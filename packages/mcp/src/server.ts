import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ProjectSession } from '@rmmz-kit/core';
import { assetCatalog, databaseResource, mapResource, projectSummary } from './resources.js';
import * as tools from './tools.js';

/**
 * L3 MCP tool layer (plan §3 M5): a thin adapter — every handler below is a
 * one-line call into resources.ts/tools.ts, which hold the actual logic and
 * are tested independently of any transport. Tool/resource grain follows
 * plan §4.5: 4 read resources, 15 write/validate/transaction tools (playtest and
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
    'asset-catalog',
    'rmmz://asset-catalog',
    { description: 'Filenames actually present under img/ and audio/ — ground tool calls in what exists instead of guessing.' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await assetCatalog(session), null, 2) }],
    })
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

const PageSpecSchema = z
  .object({
    conditions: z.record(z.string(), z.unknown()).optional(),
    trigger: z.number().int().optional(),
    image: z.record(z.string(), z.unknown()).optional(),
    moveType: z.number().int().optional(),
    moveSpeed: z.number().int().optional(),
    moveFrequency: z.number().int().optional(),
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
      description: 'Compile a YAML DSL script (plan §4.2) and write it as a map event page or common event\'s command list.',
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
    'allocate_namespace',
    {
      description: 'Allocate a contiguous, named block of switch/variable ids (System.json) for a quest/feature namespace.',
      inputSchema: { namespace: z.string(), switches: z.number().int().nonnegative().optional(), variables: z.number().int().nonnegative().optional() },
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
