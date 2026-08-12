import type {
  ProjectSession,
  MapData,
  MapEvent,
  EventPage,
  EventConditions,
  EventImage,
  EventCommand,
  CommonEvent,
} from '@rmmz-kit/core';
import { IdAllocator, mapFileName } from '@rmmz-kit/core';
import { buildMoveRoute, compile, moveStep, parseDsl, type MoveStepSpec } from '@rmmz-kit/compiler';
import { validateProject, type Finding } from '@rmmz-kit/validate';
import { simulate, type BattleReport, type BattleSpec } from '@rmmz-kit/battlesim';
import {
  composeMap,
  createMap,
  paintTiles,
  resizeMap,
  setTileFlags,
  type ComposeResult,
  type ComposeSpec,
  type CreateMapSpec,
  type PaintSpec,
  type ResizeResult,
  type TileFlagSpec,
} from '@rmmz-kit/mapgen';
import { formatPluginsJs, parsePluginsJs, PLUGINS_FILE, type PluginEntry } from './plugins.js';
import {
  AUTOTEST_PLUGIN_NAME,
  AUTOTEST_PLUGIN_PATH,
  autoTestSource,
  runScenario,
  startPlaytestServer,
  type PlaytestServer,
  type Scenario,
  type ScenarioReport,
} from '@rmmz-kit/playtest';
import { RepairLoop, type RepairSpec } from '@rmmz-kit/agent';
import { DATABASE_TABLES, NEW_ROW_DEFAULTS } from './tables.js';

/**
 * MCP write/transaction tools (plan §4.5). Each is a plain function over a
 * ProjectSession — server.ts only adds zod schemas and MCP plumbing on top,
 * per the plan's decision A (thin adapter, value lives in core/compiler/validate).
 */

export type ScriptTarget = { map: number; event: number; page: number } | { commonEvent: number };

/** Compiles a DSL string via L2 and writes it as one page's (or one common event's) command list. */
export function applyScript(session: ProjectSession, target: ScriptTarget, dsl: string): void {
  const list = compile(parseDsl(dsl));

  if ('commonEvent' in target) {
    session.updateFile<Array<CommonEvent | null>>('CommonEvents.json', (data) => {
      const entry = data.find((e) => e?.id === target.commonEvent);
      if (!entry) throw new Error(`Common event ${target.commonEvent} does not exist`);
      entry.list = list;
    });
    return;
  }

  session.updateFile<MapData>(mapFileName(target.map), (data) => {
    const event = data.events.find((e) => e?.id === target.event);
    if (!event) throw new Error(`Event ${target.event} does not exist on map ${target.map}`);
    const page = event.pages[target.page - 1];
    if (!page) throw new Error(`Map ${target.map} event ${target.event} has no page ${target.page}`);
    page.list = list;
  });
}

const DEFAULT_CONDITIONS: EventConditions = {
  actorId: 1,
  actorValid: false,
  itemId: 1,
  itemValid: false,
  selfSwitchCh: 'A',
  selfSwitchValid: false,
  switch1Id: 1,
  switch1Valid: false,
  switch2Id: 1,
  switch2Valid: false,
  variableId: 1,
  variableValid: false,
  variableValue: 0,
};

const DEFAULT_IMAGE: EventImage = { tileId: 0, characterName: '', characterIndex: 0, direction: 2, pattern: 0 };

/**
 * Merge onto the defaults, rejecting keys they don't have. The MCP schema types
 * `conditions`/`image` as open records (a hand-written per-field zod schema for
 * each is the upfront modeling §4.5 says to skip), so without this a plausible
 * near-miss like `switchId` for `switch1Id` lands in data/*.json as a junk key:
 * the condition silently never applies and nothing — zod, validateProject,
 * commit — reports it. Checked here, not in server.ts, so direct API callers
 * get the same guard.
 */
function mergeKnown<T extends object>(defaults: T, overrides: Partial<T> | undefined, what: string): T {
  for (const key of Object.keys(overrides ?? {})) {
    if (!(key in defaults)) {
      throw new Error(`Unknown ${what} field: ${key}. Known fields: ${Object.keys(defaults).join(', ')}`);
    }
  }
  return { ...defaults, ...overrides };
}

export interface PageSpec {
  conditions?: Partial<EventConditions>;
  /** 0 action button, 1 player touch, 2 event touch, 3 autorun, 4 parallel. */
  trigger?: number;
  image?: Partial<EventImage>;
  moveType?: number;
  moveSpeed?: number;
  moveFrequency?: number;
  /**
   * The page's autonomous route, used when `moveType` is 3 (custom). Steps take
   * the same shape as the DSL's `moveRoute` command — MOVE_ROUTE_CODES names or
   * raw codes — and the ROUTE_END terminator is appended for you (M7.5).
   * Omitted, a page gets MZ's default empty route.
   */
  moveRoute?: { route: MoveStepSpec[]; repeat?: boolean; skippable?: boolean; wait?: boolean };
  priorityType?: number;
  through?: boolean;
  walkAnime?: boolean;
  stepAnime?: boolean;
  directionFix?: boolean;
}

export interface MapEventSpec {
  /** Omit to allocate the first free event id on the map. */
  id?: number;
  name?: string;
  note?: string;
  x: number;
  y: number;
  /**
   * At least one page. A page's command list is not part of the spec — a page
   * that already exists keeps its list, a new one starts empty; either way
   * apply_script is what writes it.
   */
  pages: PageSpec[];
}

/** `list` comes from the page being replaced (if any), never from the spec — see MapEventSpec.pages. */
function buildPage(spec: PageSpec, list: EventCommand[] | undefined): EventPage {
  return {
    conditions: mergeKnown(DEFAULT_CONDITIONS, spec.conditions, 'page condition'),
    directionFix: spec.directionFix ?? false,
    image: mergeKnown(DEFAULT_IMAGE, spec.image, 'page image'),
    list: list ?? compile([]),
    moveFrequency: spec.moveFrequency ?? 3,
    moveRoute: spec.moveRoute
      ? buildMoveRoute({
          route: spec.moveRoute.route.map(moveStep),
          repeat: spec.moveRoute.repeat ?? true,
          skippable: spec.moveRoute.skippable ?? false,
          wait: spec.moveRoute.wait ?? false,
        })
      : { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: spec.moveSpeed ?? 3,
    moveType: spec.moveType ?? 0,
    priorityType: spec.priorityType ?? 1,
    stepAnime: spec.stepAnime ?? false,
    through: spec.through ?? false,
    trigger: spec.trigger ?? 0,
    walkAnime: spec.walkAnime ?? true,
  };
}

/**
 * Declarative, full-replace upsert of one map event's metadata + pages (plan
 * §4.5's "宣告式" write style) — never a partial merge, since a page's
 * conditions/trigger/image only make sense read together. Command lists are
 * deliberately not part of the spec: apply_script owns `list` so structure
 * (this tool) and behavior (the DSL) stay separately editable. That split only
 * holds if replacing an event *keeps* its lists — otherwise "move this NPC one
 * tile" silently deletes every line of its dialogue — so page N inherits the
 * list of the page N it replaced.
 */
export function upsertMapEvent(session: ProjectSession, mapId: number, spec: MapEventSpec): number {
  let id = spec.id;
  session.updateFile<MapData>(mapFileName(mapId), (data) => {
    if (id === undefined) {
      id = 1;
      while (data.events[id]) id++;
    }
    const previous = data.events[id];
    const event: MapEvent = {
      id,
      name: spec.name ?? `EV${String(id).padStart(3, '0')}`,
      note: spec.note ?? '',
      x: spec.x,
      y: spec.y,
      pages: spec.pages.map((page, i) => buildPage(page, previous?.pages[i]?.list)),
    };
    while (data.events.length <= id) data.events.push(null);
    data.events[id] = event;
  });
  return id!;
}

/**
 * Shallow-merges each entry onto the existing row with that id (or appends a
 * new row, id allocated via IdAllocator, if id is omitted or not found).
 * Deliberately no schema validation beyond JSON-serializability (session.commit()
 * already guards that) — a full per-table Zod schema for Actor/Item/.../Troop
 * is exactly the kind of upfront modeling §4.5 says to avoid building ahead of need.
 */
export function upsertDatabase(
  session: ProjectSession,
  table: string,
  entries: Array<Record<string, unknown> & { id?: number }>
): number[] {
  const file = DATABASE_TABLES[table];
  if (!file) {
    throw new Error(`Unknown database table: ${table}. Known tables: ${Object.keys(DATABASE_TABLES).join(', ')}`);
  }
  // MapInfos is the editor's map *tree*, not a standalone table: a row with no
  // Map###.json is a map the game 404s on and the editor can't open — and it
  // also silences validate's references/dangling-map rule, which takes
  // MapInfos as the ground truth for "map N exists", so a transfer to the
  // phantom map passes validation. Creating the map file is compose_map's job
  // (§4.5, M7), so only edits to maps that already exist are allowed here.
  // Checked before updateFile, not inside the loop: the loop mutates `data` in
  // place, so throwing mid-loop would leave earlier entries applied.
  if (file === 'MapInfos.json') {
    for (const entry of entries) {
      if (entry.id === undefined || !session.listFiles().includes(mapFileName(entry.id))) {
        throw new Error(
          `Cannot write MapInfos row ${entry.id ?? '(appended)'}: ${entry.id === undefined ? 'a new map' : mapFileName(entry.id)} has no map file. ` +
            `upsert_database can only edit (rename/re-parent) maps that already exist.`
        );
      }
    }
  }

  const allocator = new IdAllocator(session);
  const ids: number[] = [];
  session.updateFile<Array<Record<string, unknown> | null>>(file, (data) => {
    for (const entry of entries) {
      const id = entry.id ?? allocator.allocEntityId(file);
      // MZ tables are 1-indexed behind a mandatory leading null, and the MCP
      // schema takes entries as open records — so an unchecked id is a silent
      // corruption either way: id 0 overwrites the sentinel, and a negative or
      // fractional id becomes a non-index array property that JSON.stringify
      // drops, leaving us reporting an allocation that was never written.
      if (!Number.isInteger(id) || id < 1) {
        throw new Error(`Invalid id ${JSON.stringify(id)} for ${table}: ids must be integers >= 1`);
      }
      while (data.length <= id) data.push(null);
      // Defaults apply only where there is no row yet — merging them onto an
      // existing row would undo edits, and they exist for exactly one reason:
      // a table whose rows carry an invariant a shallow merge can't supply
      // (Tilesets' 8192-long `flags`, M6.5 gap #1).
      const base = data[id] ?? NEW_ROW_DEFAULTS[file]?.() ?? {};
      data[id] = { ...base, ...entry, id };
      ids.push(id);
    }
  });
  return ids;
}

/**
 * System.json is a single object, not an id-indexed array, so upsertDatabase's
 * row model doesn't apply (plan §3 M6.5) — shallow merge instead: a nested
 * field like `terms` or `titleBgm` is replaced whole, since the fields under it
 * are only meaningful as a set and deep-merging System's many arrays
 * (`switches`, `elements`, `menuCommands`) has no sensible element-wise rule.
 *
 * Unlike upsertMapEvent's page specs there is no unknown-key rejection here:
 * core's `SystemData` is a deliberate subset of what MZ actually writes
 * (`advanced`, `itemCategories`, `optAutosave`, ... aren't modeled), so an
 * allowlist would reject legitimate fields — exactly the R1 failure mode. The
 * returned `newFields` is the cheap substitute: a typo like `gametitle` shows
 * up in the tool result as a field that wasn't already there.
 */
export function updateSystem(session: ProjectSession, patch: Record<string, unknown>): { newFields: string[] } {
  let newFields: string[] = [];
  session.updateFile<Record<string, unknown>>('System.json', (data) => {
    // hasOwn, not `in`: `'toString' in data` is true for every JSON object, so
    // `in` would silently drop exactly the keys most worth reporting.
    newFields = Object.keys(patch).filter((key) => !Object.hasOwn(data, key));
    return { ...data, ...patch };
  });
  return { newFields };
}

/**
 * L3.5 map tools (plan §4.5 `create_map`/`resize_map`/`paint_tiles`/`compose_map`,
 * M7). All four are one-liners into `@rmmz-kit/mapgen` for the same reason the
 * rest of this file is one-liners into core/compiler/validate — decision A.
 */
export function createMapTool(session: ProjectSession, spec: CreateMapSpec): { id: number } {
  return { id: createMap(session, spec) };
}

export function resizeMapTool(
  session: ProjectSession,
  mapId: number,
  width: number,
  height: number
): ResizeResult {
  return resizeMap(session, mapId, width, height);
}

export function paintTilesTool(session: ProjectSession, spec: PaintSpec): void {
  paintTiles(session, spec);
}

export function setTileFlagsTool(session: ProjectSession, tilesetId: number, tiles: TileFlagSpec[]): void {
  setTileFlags(session, tilesetId, tiles);
}

export function composeMapTool(session: ProjectSession, spec: ComposeSpec): ComposeResult {
  return composeMap(session, spec);
}

/**
 * `manage_plugins` (plan §4.5, M7.6): read js/plugins.js, and optionally
 * shallow-merge entries into it by name (new names append, so load order is
 * append-order — reordering an existing list isn't exposed because nothing has
 * needed it yet). Always returns the resulting list, so the read-only call is
 * just this one with no patch.
 *
 * The write is staged on the session like a data file: it lands on commit() and
 * vanishes on rollback(), together with whatever database rows referenced the
 * plugin.
 */
export async function managePlugins(session: ProjectSession, patches?: PluginPatch[]): Promise<PluginEntry[]> {
  const text = await session.readRaw(PLUGINS_FILE);
  const { header, entries } = text === null ? { header: undefined, entries: [] as PluginEntry[] } : parsePluginsJs(text);
  if (!patches || patches.length === 0) return entries;

  for (const patch of patches) {
    // A plugin listed with no js/plugins/<name>.js is a hard crash on boot
    // (PluginManager.loadScript's onerror throws), and it is the single most
    // likely mistake here: the name is a filename an agent typed from memory.
    if ((await session.readRaw(`js/plugins/${patch.name}.js`)) === null) {
      throw new Error(`No such plugin: js/plugins/${patch.name}.js. Import the plugin file before enabling it.`);
    }
    const existing = entries.find((entry) => entry.name === patch.name);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      entries.push({ status: true, description: '', parameters: {}, ...patch });
    }
  }

  session.writeRaw(PLUGINS_FILE, formatPluginsJs(entries, header));
  return entries;
}

export type PluginPatch = Partial<PluginEntry> & { name: string };

export { importAsset } from './assets.js';

export function allocateNamespace(
  session: ProjectSession,
  namespace: string,
  counts: { switches?: number; variables?: number }
) {
  return new IdAllocator(session).allocNamespace(namespace, counts);
}

export function validate(session: ProjectSession): Promise<Finding[]> {
  return validateProject(session);
}

/**
 * Runs the L4.5 simulator (§4.5's `simulate_battle`) against the *in-memory*
 * session, so a balance question can be asked about an edit that hasn't been
 * committed yet — the point of pairing it with the transaction model.
 */
export function simulateBattle(session: ProjectSession, spec: BattleSpec): BattleReport {
  return simulate(session, spec);
}

/**
 * `playtest` (plan §4.5, M8's front half): the editor's Playtest button's
 * equivalent — a local site over the project so a human can open the game and
 * try it. One server per process, because the point is a URL a person is
 * looking at; starting it twice would just orphan the first port.
 *
 * `install-autotest` stages `js/plugins/AutoTest.js` plus its js/plugins.js
 * entry, which is what turns that browser session into a drivable one
 * (`window.__AT`). It is staged like every other change: nothing is on disk
 * until commit(), so a playtest of *uncommitted* edits needs a commit first —
 * unlike `run_scenario`, which runs against the in-memory session directly.
 */
let runningPlaytest: PlaytestServer | null = null;

export type PlaytestAction = 'start' | 'stop' | 'status' | 'install-autotest';

export async function playtest(
  session: ProjectSession,
  action: PlaytestAction = 'start',
  options: { port?: number; openBrowser?: boolean } = {}
): Promise<Record<string, unknown>> {
  switch (action) {
    case 'start':
      if (!runningPlaytest) runningPlaytest = await startPlaytestServer(session.rootPath, options);
      return { running: true, url: runningPlaytest.url, root: session.rootPath };
    case 'stop':
      await runningPlaytest?.close();
      runningPlaytest = null;
      return { running: false };
    case 'status':
      return runningPlaytest ? { running: true, url: runningPlaytest.url } : { running: false };
    case 'install-autotest': {
      session.writeRaw(AUTOTEST_PLUGIN_PATH, autoTestSource());
      const entries = await managePlugins(session, [
        { name: AUTOTEST_PLUGIN_NAME, status: true, description: 'rmmz-kit automation hooks (window.__AT)' },
      ]);
      return {
        file: AUTOTEST_PLUGIN_PATH,
        plugins: entries.map((entry) => entry.name),
        note: 'Staged only — commit() writes it. Disable the plugin before shipping the game.',
      };
    }
  }
}

/**
 * `playtest(scenario)`'s headless half (plan §4.5): run a scenario against the
 * *in-memory* session — the same "test the edit before committing it" property
 * `simulate_battle` has. §4.5 also lists a separate `coverage()`; it is folded
 * into this report instead, because coverage with no scenario behind it is a
 * table of zeroes.
 */
export function runScenarioTool(session: ProjectSession, scenario: Scenario): ScenarioReport {
  return runScenario(session, scenario);
}

/**
 * `repair` (plan §3 M9): the L6 loop, driven by the client rather than driving
 * it. The generator in that pipeline is an LLM, and here the LLM *is* the MCP
 * client — so the loop cannot call it, and instead exposes the state machine:
 * `start` snapshots what is already broken, then the client edits with the
 * ordinary tools and calls `check` to have the attempt graded. `check` returns
 * the feedback to act on, or stops the loop (`converged` / `exhausted` /
 * `oscillating`). One loop per process, like `playtest`: two concurrent loops
 * over the same session would grade each other's edits.
 */
let repairLoop: RepairLoop | null = null;

export type RepairAction = 'start' | 'check' | 'status' | 'abort';

export async function repair(
  session: ProjectSession,
  action: RepairAction = 'check',
  spec: RepairSpec = {}
): Promise<Record<string, unknown>> {
  switch (action) {
    case 'start':
      repairLoop = new RepairLoop(session, spec);
      return { ...(await repairLoop.start()) };
    case 'check':
      if (!repairLoop) throw new Error('No repair loop is running — call repair with action "start" first.');
      return { ...(await repairLoop.check()) };
    case 'status': {
      const status = repairLoop?.status();
      return status ? { ...status } : { outcome: 'none' };
    }
    case 'abort':
      repairLoop = null;
      return { outcome: 'none' };
  }
}

export function commit(session: ProjectSession, message: string): Promise<string | null> {
  return session.commit(message);
}

export function rollback(session: ProjectSession): void {
  session.rollback();
}

/** Files that would be written by commit() right now. */
export function diff(session: ProjectSession): string[] {
  return session.dirtyFiles();
}
