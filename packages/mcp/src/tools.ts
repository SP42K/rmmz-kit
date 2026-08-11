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
import { compile, parseDsl } from '@rmmz-kit/compiler';
import { validateProject, type Finding } from '@rmmz-kit/validate';
import { DATABASE_TABLES } from './tables.js';

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
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
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
      data[id] = { ...(data[id] ?? {}), ...entry, id };
      ids.push(id);
    }
  });
  return ids;
}

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
