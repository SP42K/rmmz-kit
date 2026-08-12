import type {
  ProjectSession,
  MapData,
  MapEvent,
  CommonEvent,
  EventCommand,
  EventConditions,
  EventImage,
} from '@rmmz-kit/core';
import { decompile, type Node, type Condition } from '@rmmz-kit/compiler';

/**
 * Traversal helpers shared by every rule file, mirroring RefIndex's own
 * "scan every Map*.json + CommonEvents.json" loop (core/src/refIndex.ts) so
 * this package doesn't re-derive that structure a third time.
 */

export function forEachMapEvent(
  session: ProjectSession,
  fn: (mapId: number, file: string, event: MapEvent) => void
): void {
  for (const file of session.listFiles()) {
    const m = /^Map(\d+)\.json$/.exec(file);
    if (!m) continue;
    const map = session.readFile<MapData>(file);
    for (const event of map.events) {
      if (event) fn(Number(m[1]), file, event);
    }
  }
}

export interface ListContext {
  file: string;
  path: string;
  list: EventCommand[];
  kind: 'mapEventPage' | 'commonEvent';
  mapId?: number;
  eventId?: number;
  eventName?: string;
  pageIndex?: number;
  conditions?: EventConditions;
  image?: EventImage;
}

export function forEachCommandList(session: ProjectSession, fn: (ctx: ListContext) => void): void {
  forEachMapEvent(session, (mapId, file, event) => {
    event.pages.forEach((page, i) => {
      fn({
        file,
        mapId,
        eventId: event.id,
        eventName: event.name,
        pageIndex: i,
        path: `event ${event.id} (${event.name}) > page ${i + 1}`,
        list: page.list,
        kind: 'mapEventPage',
        conditions: page.conditions,
        image: page.image,
      });
    });
  });
  if (session.listFiles().includes('CommonEvents.json')) {
    for (const ce of session.readFile<Array<CommonEvent | null>>('CommonEvents.json')) {
      if (!ce) continue;
      fn({
        file: 'CommonEvents.json',
        eventId: ce.id,
        eventName: ce.name,
        path: `commonEvent ${ce.id} (${ce.name})`,
        // A row can legitimately lack `list` — MCP's upsert_database writes a
        // partial row, and hand-edited projects happen. Default here rather
        // than in each rule: every rule routes through this one function, and
        // without it they all die on `undefined.forEach`.
        list: ce.list ?? [],
        kind: 'commonEvent',
      });
    }
  }
}

/** decompile() is the L2 compiler's own recursive-descent structure check; reuse it instead of re-deriving indent/pairing rules here. Returns undefined (rather than throwing) so callers can skip semantic analysis of a block structure.ts already flagged as malformed. */
export function tryDecompile(list: EventCommand[]): Node[] | undefined {
  try {
    return decompile(list);
  } catch {
    return undefined;
  }
}

/** Conditional-branch guards active at the current point in a decompiled tree, e.g. "we're inside an `if gold >= N`" — used to spot Change Gold/Items decreases with no preceding possession check. */
export interface Guards {
  gold: boolean;
  items: ReadonlySet<number>;
}

const NO_GUARDS: Guards = { gold: false, items: new Set() };

/** Depth-first walk of a decompiled Node tree, threading Guards through `if.then` (never `if.else` — the guard doesn't hold there). */
export function walkNodes(nodes: Node[], visit: (node: Node, guards: Guards) => void, guards: Guards = NO_GUARDS): void {
  for (const node of nodes) {
    visit(node, guards);
    switch (node.kind) {
      case 'if':
        walkNodes(node.then, visit, extendGuard(guards, node.condition));
        if (node.else) walkNodes(node.else, visit, guards);
        break;
      case 'loop':
        walkNodes(node.body, visit, guards);
        break;
      case 'choice':
        for (const branch of node.branches) walkNodes(branch, visit, guards);
        if (node.cancelBranch) walkNodes(node.cancelBranch, visit, guards);
        break;
      case 'battle':
        for (const branch of [node.win, node.escape, node.lose]) {
          if (branch) walkNodes(branch, visit, guards);
        }
        break;
      case 'raw':
        // An unmodeled structural command (see RawNode.body) still nests real
        // commands under it. Skipping them would make every rule blind inside
        // such a branch. Guards pass through unchanged: an enclosing "gold >="
        // check still holds inside the branch, and the raw command itself
        // guards nothing we model.
        if (node.body) walkNodes(node.body, visit, guards);
        break;
    }
  }
}

/** Conditional Branch type 7 = Gold, type 8 = Item (params [type, itemId, ...]); neither gets a typed Condition variant (§4.3 is Tier 1 only), so both surface as `{type:'raw', parameters}`. */
function extendGuard(guards: Guards, condition: Condition): Guards {
  if (condition.type !== 'raw') return guards;
  const params = condition.parameters as number[];
  // Gold's parameters[2] is the comparison: 0 = ">=", 1 = "<=", 2 = "<". Only
  // ">=" bounds the balance from below, so only it guards a decrease — the
  // other two are the opposite check. (MV data may omit it; default ">=".)
  if (params[0] === 7 && (params[2] ?? 0) === 0) return { ...guards, gold: true };
  if (params[0] === 8) return { ...guards, items: new Set([...guards.items, params[1]]) };
  return guards;
}
