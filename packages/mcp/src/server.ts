import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ProjectSession } from '@rmmz-kit/core';
import { GameSpecSchema } from '@rmmz-kit/gamegen';
import { assetCatalog, databaseResource, gameBriefGuide, mapResource, projectSummary, tilesetResource } from './resources.js';
import * as tools from './tools.js';

/**
 * L3 MCP tool layer (plan §3 M5): a thin adapter — every handler below is a
 * one-line call into resources.ts/tools.ts, which hold the actual logic and
 * are tested independently of any transport. Tool/resource grain follows
 * plan §4.5: 4 read resources, 17 write/validate/transaction tools (playtest and
 * coverage from §4.5's list are still omitted — they front L5, which is M8 and
 * doesn't exist in this repo yet).
 */
export function createServer(session: ProjectSession): McpServer {
  const server = new McpServer({ name: 'rmmz-kit', version: '0.1.0' });

  registerResources(server, session);
  registerTools(server, session);

  return server;
}

/** Errors are never built by hand here — handlers throw and the SDK turns that into an isError result. */
function json(text: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(text, null, 2) }] };
}

const comparison = z.enum(['eq', 'gte', 'lte', 'gt', 'lt', 'neq']);
const itemKind = z.enum(['item', 'weapon', 'armor']);
const selfSwitchCh = z.enum(['A', 'B', 'C', 'D']);

/**
 * One `run_scenario` step. Spelled out rather than left as a free-form record
 * because this schema *is* the instruction manual an LLM reads before writing a
 * scenario — the same reason §4.5 makes the asset catalog a resource.
 */
const scenarioStep = z.discriminatedUnion('action', [
  z.object({ action: z.literal('runEvent'), map: z.number().int(), event: z.number().int(), page: z.number().int().min(1).optional() }),
  z.object({ action: z.literal('runCommonEvent'), id: z.number().int() }),
  z.object({ action: z.literal('setSwitch'), id: z.number().int(), value: z.boolean() }),
  z.object({ action: z.literal('setVariable'), id: z.number().int(), value: z.number() }),
  z.object({ action: z.literal('setSelfSwitch'), map: z.number().int(), event: z.number().int(), ch: selfSwitchCh, value: z.boolean() }),
  z.object({ action: z.literal('gainGold'), amount: z.number().int() }),
  z.object({ action: z.literal('gainItem'), kind: itemKind.optional(), id: z.number().int(), amount: z.number().int() }),
  z.object({ action: z.literal('teleport'), map: z.number().int(), x: z.number().int(), y: z.number().int() }),
  z.object({ action: z.literal('answerChoices'), choices: z.array(z.number().int()) }),
  z.object({ action: z.literal('answerBattles'), outcomes: z.array(z.enum(['win', 'escape', 'lose'])) }),
  z.object({ action: z.literal('clearMessages') }).describe('Forget the messages shown so far, so a later noMessage assertion is about what comes next'),
  z.object({
    action: z.literal('expect'),
    expect: z
      .object({
        switch: z.object({ id: z.number().int(), value: z.boolean() }).optional(),
        variable: z.object({ id: z.number().int(), value: z.number(), cmp: comparison.optional() }).optional(),
        selfSwitch: z.object({ map: z.number().int(), event: z.number().int(), ch: selfSwitchCh, value: z.boolean() }).optional(),
        gold: z.object({ value: z.number(), cmp: comparison.optional() }).optional(),
        item: z.object({ kind: itemKind.optional(), id: z.number().int(), count: z.number().optional(), cmp: comparison.optional() }).optional(),
        partyHas: z.number().int().optional(),
        playerAt: z.object({ map: z.number().int(), x: z.number().int().optional(), y: z.number().int().optional() }).optional(),
        message: z.string().optional().describe('Some shown message line contains this substring'),
        noMessage: z.string().optional().describe('No shown message line contains this substring'),
        pluginCalled: z.object({ plugin: z.string(), command: z.string() }).optional(),
        activePage: z
          .object({ map: z.number().int(), event: z.number().int(), page: z.number().int() })
          .optional()
          .describe('The page MZ would run for this event right now (1-based, 0 = none)'),
      })
      .strict(),
  }),
]);

/**
 * One scenario, as `run_scenario`'s whole input and as one element of
 * `repair`'s regression suite. Shared rather than copied: two copies of this
 * shape drift, and the descriptions are the instruction manual (above).
 */
const scenarioShape = {
  name: z.string().optional(),
  steps: z.array(scenarioStep).min(1),
  choices: z.array(z.number().int()).optional().describe('Show Choices answers, in order; -1 takes the cancel branch'),
  battles: z.array(z.enum(['win', 'escape', 'lose'])).optional().describe('Battle Processing outcomes, in order (default win)'),
  maxCommands: z.number().int().min(1).optional().describe('Abort guard for a runaway event loop'),
  newGame: z.boolean().optional().describe("Start from System.json's new-game party/position (default) or from nothing"),
};

function registerResources(server: McpServer, session: ProjectSession): void {
  server.registerResource(
    'project-summary',
    'rmmz://project/summary',
    { description: 'Game title, map list, database row counts, named switch/variable counts.' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(projectSummary(session), null, 2) }],
    })
  );

  server.registerResource(
    'map',
    new ResourceTemplate('rmmz://map/{id}', { list: undefined }),
    { description: 'A map\'s full JSON, with each event page annotated with its decompiled DSL script.' },
    async (uri, { id }) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(mapResource(session, Number(id)), null, 2) }],
    })
  );

  server.registerResource(
    'database',
    new ResourceTemplate('rmmz://database/{table}', { list: undefined }),
    {
      description:
        'A database table (actors, classes, skills, items, weapons, armors, enemies, states, troops, commonEvents, tilesets, animations, mapInfos).',
    },
    async (uri, { table }) => ({
      contents: [
        { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(databaseResource(session, String(table)), null, 2) },
      ],
    })
  );

  server.registerResource(
    'tileset',
    new ResourceTemplate('rmmz://tileset/{id}', { list: undefined }),
    {
      description:
        "One tileset's drawable tile ids: every autotile kind with its base id, sheet and passability, plus each plain page's id range. Read this before paint_tiles or set_tile_flags — a tile id cannot be guessed from a filename.",
    },
    async (uri, { id }) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(tilesetResource(session, Number(id)), null, 2) }],
    })
  );

  server.registerResource(
    'asset-catalog',
    'rmmz://asset-catalog',
    { description: 'Filenames actually present under img/ and audio/ — ground tool calls in what exists instead of guessing.' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await assetCatalog(session), null, 2) }],
    })
  );

  server.registerResource(
    'game-brief-guide',
    'rmmz://game-brief-guide',
    {
      description:
        "How to turn a one-sentence brief into a generate_game spec, and what to do with the report it returns. Read this before calling generate_game.",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: gameBriefGuide(session) }] })
  );
}

const ScriptTargetSchema = z.union([
  z
    .object({
      map: z.number().int(),
      event: z.number().int(),
      // 1-based, unlike the 0-indexed `pages` array the rmmz://map/{id} resource
      // returns — say so, or every caller burns a round trip discovering it.
      page: z.number().int().min(1).describe('1-based page number: the first page is 1, not 0'),
    })
    .strict(),
  z.object({ commonEvent: z.number().int() }).strict(),
]);

/** A movement route step, same surface as the DSL's: a `Game_Character.ROUTE_*` name on its own, or a name/code plus operands. */
const MoveStepSchema = z.union([
  z.string(),
  z.object({ step: z.union([z.string(), z.number().int()]), parameters: z.array(z.unknown()).optional() }).strict(),
]);

const PageSpecSchema = z
  .object({
    conditions: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('EventConditions fields; switch1Id/switch2Id/variableId also take an allocate_namespace name'),
    trigger: z.number().int().optional(),
    image: z.record(z.string(), z.unknown()).optional(),
    moveType: z.number().int().optional(),
    moveSpeed: z.number().int().optional(),
    moveFrequency: z.number().int().optional(),
    moveRoute: z
      .object({
        route: z.array(MoveStepSchema),
        repeat: z.boolean().optional(),
        skippable: z.boolean().optional(),
        wait: z.boolean().optional(),
      })
      .strict()
      .optional()
      .describe('Autonomous route, used when moveType is 3 (custom); the ROUTE_END terminator is added for you'),
    priorityType: z.number().int().optional(),
    through: z.boolean().optional(),
    walkAnime: z.boolean().optional(),
    stepAnime: z.boolean().optional(),
    directionFix: z.boolean().optional(),
  })
  .strict();

function registerTools(server: McpServer, session: ProjectSession): void {
  server.registerTool(
    'apply_script',
    {
      description:
        'Compile a YAML DSL script (plan §4.2) and write it as a map event page or common event\'s command list. ' +
        'Switch/variable fields take a numeric id or an allocate_namespace name like "quest.herb.started".',
      inputSchema: { target: ScriptTargetSchema, dsl: z.string() },
    },
    async ({ target, dsl }) => {
      tools.applyScript(session, target as tools.ScriptTarget, dsl);
      return json({ ok: true });
    }
  );

  server.registerTool(
    'upsert_map_event',
    {
      description:
        'Create or fully replace a map event\'s metadata and pages. Command lists are left alone — an existing page keeps its, a new page starts empty; use apply_script to write them.',
      inputSchema: {
        mapId: z.number().int(),
        id: z.number().int().optional(),
        name: z.string().optional(),
        note: z.string().optional(),
        x: z.number().int(),
        y: z.number().int(),
        pages: z.array(PageSpecSchema).min(1),
      },
    },
    async ({ mapId, pages, ...spec }) => {
      const id = tools.upsertMapEvent(session, mapId, { ...spec, pages: pages as tools.PageSpec[] });
      return json({ id });
    }
  );

  server.registerTool(
    'upsert_database',
    {
      description:
        'Shallow-merge entries into a database table by id (Actors, Classes, Skills, Items, Weapons, Armors, Enemies, States, Troops, CommonEvents, Tilesets, Animations, MapInfos). Omit id to append a new row — except for MapInfos, where only existing maps can be edited (a row without its Map###.json is an unloadable map).',
      inputSchema: { table: z.string(), entries: z.array(z.record(z.string(), z.unknown())) },
    },
    async ({ table, entries }) => {
      const ids = tools.upsertDatabase(session, table, entries as Array<Record<string, unknown> & { id?: number }>);
      return json({ ids });
    }
  );

  server.registerTool(
    'update_system',
    {
      description:
        'Shallow-merge a patch into System.json (game title, terms, currency unit, starting map/party, option flags). Nested fields such as `terms` are replaced whole, not deep-merged. Returns any patch keys the file did not already have — a typo shows up there.',
      inputSchema: { patch: z.record(z.string(), z.unknown()) },
    },
    async ({ patch }) => json(tools.updateSystem(session, patch))
  );

  server.registerTool(
    'create_map',
    {
      description:
        'Create a new map: writes Map###.json and its MapInfos tree row, and returns the allocated map id. Optionally floods layer 0 with one tile.',
      inputSchema: {
        name: z.string(),
        width: z.number().int().min(1).max(256),
        height: z.number().int().min(1).max(256),
        tilesetId: z.number().int().optional(),
        parentId: z.number().int().optional().describe('Parent map in the editor tree; 0 (default) is the root'),
        fillTileId: z.number().int().optional().describe('Tile id to flood layer 0 with; pass an autotile kind\'s base id, shapes are derived'),
      },
    },
    async (spec) => json(tools.createMapTool(session, spec))
  );

  server.registerTool(
    'resize_map',
    {
      description:
        'Resize a map, anchored top-left: overlapping tiles keep their coordinates, new area is empty. Events are never moved; any left outside the new bounds are returned.',
      inputSchema: {
        mapId: z.number().int(),
        width: z.number().int().min(1).max(256),
        height: z.number().int().min(1).max(256),
      },
    },
    async ({ mapId, width, height }) => json(tools.resizeMapTool(session, mapId, width, height))
  );

  server.registerTool(
    'update_map',
    {
      description:
        'Shallow-merge a patch into one map\'s own fields — encounterList/encounterStep, displayName, bgm/bgs and their autoplay flags, parallax, note. Tiles, events and size have their own tools and are refused here. Nested fields are replaced whole.',
      inputSchema: { mapId: z.number().int(), patch: z.record(z.string(), z.unknown()) },
    },
    async ({ mapId, patch }) => json(tools.updateMap(session, mapId, patch))
  );

  server.registerTool(
    'find_free_rect',
    {
      description:
        'Find rectangles on a map where every tile is walkable and no event stands — where a house, a stall or a field can go. Returned rects do not overlap. Check the map with compose_map/validate afterwards: this says the space was free, not that filling it in leaves the map connected.',
      inputSchema: {
        mapId: z.number().int(),
        width: z.number().int().min(1),
        height: z.number().int().min(1),
        limit: z.number().int().min(1).max(64).optional().describe('How many to return (default 8)'),
      },
    },
    async (spec) => json(tools.findFreeRect(session, spec))
  );

  server.registerTool(
    'paint_tiles',
    {
      description:
        'Fill rectangles of one map layer with a tile id, then re-derive autotile shape bits over what changed (and its neighbours). Layers: 0-1 ground, 2-3 upper tiles, 4 shadow, 5 region id.',
      inputSchema: {
        mapId: z.number().int(),
        ops: z
          .array(
            z
              .object({
                x: z.number().int().nonnegative(),
                y: z.number().int().nonnegative(),
                width: z.number().int().min(1).optional().describe('Defaults to 1'),
                height: z.number().int().min(1).optional().describe('Defaults to 1'),
                tileId: z.number().int().min(0).max(8191),
              })
              .strict()
          )
          .min(1),
        layer: z.number().int().min(0).max(5).optional().describe('Defaults to 0'),
        autotile: z.boolean().optional().describe('Defaults to true; turn off only to write raw shape bits verbatim'),
      },
    },
    async (spec) => {
      tools.paintTilesTool(session, spec);
      return json({ ok: true });
    }
  );

  server.registerTool(
    'set_tile_flags',
    {
      description:
        'Set passability, terrain tags and tile options (star/ladder/bush/counter/damage) for individual tile ids in one tileset. Omitted properties keep their current value.',
      inputSchema: {
        tilesetId: z.number().int(),
        tiles: z
          .array(
            z
              .object({
                tileId: z.number().int().min(0).max(8191),
                passage: z
                  .object({
                    down: z.boolean().optional(),
                    left: z.boolean().optional(),
                    right: z.boolean().optional(),
                    up: z.boolean().optional(),
                  })
                  .strict()
                  .optional()
                  .describe('true = passable in that direction'),
                star: z.boolean().optional().describe('Drawn above the player and exempt from passage checks'),
                ladder: z.boolean().optional(),
                bush: z.boolean().optional(),
                counter: z.boolean().optional(),
                damage: z.boolean().optional(),
                terrainTag: z.number().int().min(0).max(7).optional(),
              })
              .strict()
          )
          .min(1),
      },
    },
    async ({ tilesetId, tiles }) => {
      tools.setTileFlagsTool(session, tilesetId, tiles);
      return json({ ok: true });
    }
  );

  server.registerTool(
    'compose_map',
    {
      description:
        'Generate a connected room-and-corridor map (BSP) and create it. Returns the map id and the room rectangles to place events in — decide which rooms hold what, do not paint tile by tile.',
      inputSchema: {
        name: z.string(),
        width: z.number().int().min(1).max(256).optional(),
        height: z.number().int().min(1).max(256).optional(),
        tilesetId: z.number().int().optional(),
        parentId: z.number().int().optional(),
        floorTileId: z.number().int().min(0).max(8191).optional().describe('Autotile base id for room floors; default 2816'),
        wallTileId: z.number().int().min(0).max(8191).optional().describe('Autotile base id for the solid around them; default 5888'),
        minRoom: z.number().int().min(1).optional(),
        minPartition: z.number().int().min(3).optional().describe('Larger = fewer, bigger rooms; default 12'),
        seed: z.number().int().optional(),
        setFlags: z.boolean().optional().describe('Write passage flags for the two tiles used; default true'),
      },
    },
    async (spec) => json(tools.composeMapTool(session, spec))
  );

  server.registerTool(
    'manage_plugins',
    {
      description:
        'List js/plugins.js, and optionally enable/disable/configure plugins by name (new names are appended in load order). Call with no entries to just read it. The plugin\'s js/plugins/<name>.js must already exist.',
      inputSchema: {
        entries: z
          .array(
            z
              .object({
                name: z.string().describe('The plugin file\'s name without .js'),
                status: z.boolean().optional().describe('true = enabled'),
                description: z.string().optional(),
                parameters: z.record(z.string(), z.unknown()).optional(),
              })
              .strict()
          )
          .optional(),
      },
    },
    async ({ entries }) => json({ plugins: await tools.managePlugins(session, entries) })
  );

  server.registerTool(
    'import_asset',
    {
      description:
        'Copy an image, audio, or plugin (.js) file into the right project folder. Lands with commit() like every other change, and shows up in rmmz://asset-catalog immediately. A file imported to js/plugins can be enabled with manage_plugins in the same session.',
      inputSchema: {
        dir: z.string().describe('Target folder, e.g. img/characters, audio/se, or js/plugins'),
        source: z.string().describe('Path of the file to copy in'),
        name: z.string().optional().describe("Target filename; defaults to the source's own"),
      },
    },
    async (spec) => json(await tools.importAsset(session, spec))
  );

  const memberCounts = z
    .union([z.number().int().nonnegative(), z.array(z.string())])
    .optional()
    .describe('A count (members named 0..n-1) or a list of member names, e.g. ["started", "done"]');
  server.registerTool(
    'allocate_namespace',
    {
      description:
        'Allocate a contiguous block of switch/variable ids for a quest/feature namespace. Returns member->id; from then on ' +
        '"namespace.member" (e.g. "quest.herb.started") works anywhere apply_script or a page condition takes a switch/variable id.',
      inputSchema: { namespace: z.string(), switches: memberCounts, variables: memberCounts },
    },
    async ({ namespace, switches, variables }) => json(tools.allocateNamespace(session, namespace, { switches, variables }))
  );

  server.registerTool(
    'validate',
    { description: 'Run the L4 validator (structure, reference integrity, semantics) and return all findings.' },
    async () => json(await tools.validate(session))
  );

  server.registerTool(
    'simulate_battle',
    {
      description:
        'Run N headless battles (L4.5) against the current in-memory data and report win rate, turns, TTK, damage distribution, one-shot kills and stalemates.',
      inputSchema: {
        party: z
          .array(
            z
              .object({
                actorId: z.number().int(),
                level: z.number().int().min(1).optional(),
                equips: z.array(z.number().int()).optional().describe('Equipment ids by slot; slot 0 is the weapon'),
                skills: z.array(z.number().int()).optional(),
              })
              .strict()
          )
          .min(1),
        troopId: z.number().int().optional(),
        enemies: z.array(z.number().int()).optional().describe('Enemy ids, as an alternative to troopId'),
        trials: z.number().int().min(1).max(10000).optional(),
        maxTurns: z.number().int().min(1).max(1000).optional(),
        seed: z.number().int().optional(),
      },
    },
    async (spec) => json(tools.simulateBattle(session, spec))
  );

  server.registerTool(
    'playtest',
    {
      description:
        "Local playtest site over the project (the editor's Playtest button): start it, stop it, ask its status, or stage the AutoTest.js plugin that exposes window.__AT for browser automation. Serves what is on disk, so commit() first to play uncommitted edits.",
      inputSchema: {
        action: z.enum(['start', 'stop', 'status', 'install-autotest']).optional().describe('Defaults to start'),
        port: z.number().int().min(0).max(65535).optional().describe('0 (default) picks a free port'),
        openBrowser: z.boolean().optional().describe('Open the URL in the OS default browser'),
      },
    },
    async ({ action, port, openBrowser }) => json(await tools.playtest(session, action, { port, openBrowser }))
  );

  server.registerTool(
    'run_scenario',
    {
      description:
        'Run a headless event-layer scenario against the current in-memory data and report every assertion, the messages shown, the final state and event coverage. Runs event commands, not frames — no rendering, movement or battle math (use simulate_battle for that).',
      inputSchema: scenarioShape,
    },
    async (scenario) => json(tools.runScenarioTool(session, scenario))
  );

  server.registerTool(
    'repair',
    {
      description:
        'L6 repair loop: "start" snapshots what is already failing and takes the regression suite, then you edit with the other tools and call "check" to have the attempt graded. Each check returns either the feedback to act on, or a verdict (converged/exhausted/oscillating). Commits only on convergence; a failed attempt writes nothing.',
      inputSchema: {
        action: z.enum(['start', 'check', 'status', 'abort']).optional().describe('Defaults to check'),
        scenarios: z
          .array(z.object(scenarioShape))
          .optional()
          .describe('The regression suite (start only). Every attempt runs all of it, not just the one that failed'),
        maxAttempts: z.number().int().min(1).max(10).optional().describe('Repair attempts before giving up (default 3)'),
        blockOn: z.enum(['error', 'warning', 'info']).optional().describe('Validator severity that blocks an attempt (default error)'),
        branch: z.string().optional().describe('Create and switch to this git branch before the convergence commit'),
        commitMessage: z.string().optional(),
      },
    },
    async ({ action, ...spec }) => json(await tools.repair(session, action, spec))
  );

  server.registerTool(
    'generate_game',
    {
      description:
        'Generate a whole small RPG from a spec: one composed map per area, two-way portals between them, a quest ' +
        'chain with switch gating, and a boss that ends the game. Then check it is finishable — validate the data, ' +
        'simulate every generated fight, and play a generated walkthrough through to the clear switch. Writes ' +
        'nothing to disk: commit if the report is good, rollback and change the seed if it is not. Hand the ' +
        'returned `suite` to `repair` as its regression set if you want to fix the result by hand.',
      inputSchema: {
        ...GameSpecSchema.shape,
        options: z
          .object({
            minWinRate: z.number().min(0).max(1).optional().describe('A generated fight below this win rate is reported as a wall (default 0.5)'),
            battleTrials: z.number().int().min(1).max(10000).optional().describe('Trials per simulated fight (default 200)'),
            checkBattles: z.boolean().optional().describe('Set false to skip the battle gate, which is the slow one'),
          })
          .strict()
          .optional(),
      },
    },
    async ({ options, ...spec }) => json(await tools.generateGame(session, spec, options))
  );

  server.registerTool(
    'deploy',
    {
      description:
        'Export a shippable package: copy the project to outDir, minus the editor project file, save data and (by ' +
        'default) every img//audio/ file nothing in the project refers to. Copies what is on disk, so commit first. ' +
        'Target "windows" wraps the same bundle in an NW.js shell you supply via nwPath (this tool cannot download one).',
      inputSchema: {
        outDir: z.string().describe('Where to write the package. Must be outside the project, and empty unless overwrite'),
        target: z.enum(['web', 'windows']).optional().describe('Defaults to web'),
        excludeUnusedAssets: z.boolean().optional().describe('Prune unreferenced img//audio/ files (default true)'),
        nwPath: z.string().optional().describe('Unpacked NW.js distribution (nw.exe and its libraries), required by target windows'),
        overwrite: z.boolean().optional().describe('Delete a non-empty outDir and write a fresh package, instead of refusing'),
      },
    },
    async (options) => json(await tools.deploy(session, options))
  );

  server.registerTool(
    'create_project',
    {
      description:
        'Create a new MZ project from the blank template at `path` (must be empty), git-initialised and ready for ' +
        'openProject. This is the one tool that does not touch the currently open project — reopen the server ' +
        'against the new path to edit it. Without runtimeFrom the result has data but no engine or art (those ship ' +
        'with the editor), so it opens as a project but will not boot.',
      inputSchema: {
        path: z.string().describe('Directory to create the project in — must not exist, or be empty'),
        title: z.string().optional().describe("The game title, written to System.json's gameTitle"),
        templatePath: z.string().optional().describe('Override the bundled blank-project template'),
        runtimeFrom: z.string().optional().describe('An installed MZ project to copy js/, img/, audio/, fonts/ from (its plugin list is not copied)'),
        git: z.boolean().optional().describe('git init + initial commit (default true)'),
      },
    },
    async ({ path, ...options }) => json(await tools.createProjectTool(path, options))
  );

  server.registerTool(
    'diff',
    { description: 'List data files that would be written by commit() right now.' },
    async () => json({ files: tools.diff(session) })
  );

  server.registerTool(
    'commit',
    {
      description: 'Validate, then atomically write dirty files and git-commit them. Throws (writing nothing) if validation fails.',
      inputSchema: { message: z.string() },
    },
    async ({ message }) => json({ commit: await tools.commit(session, message) })
  );

  server.registerTool('rollback', { description: 'Discard all in-memory mutations since open() or the last commit.' }, async () => {
    tools.rollback(session);
    return json({ ok: true });
  });
}
