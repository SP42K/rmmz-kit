import type {
  EventConditions,
  EventImage,
  EventPage,
  MapData,
  MapEvent,
  ProjectSession,
} from '@rmmz-kit/core';
import { IdAllocator, mapFileName } from '@rmmz-kit/core';
import { compile, type Node } from '@rmmz-kit/compiler';
import { composeMap, type Rect } from '@rmmz-kit/mapgen';
import { questOrder, type FinaleSpec, type GameSpec, type ObjectiveSpec, type QuestSpec, type Sprite } from './spec.js';

/**
 * Spec → project. Everything here is deterministic: same spec + same seed
 * produces the same maps, the same ids and the same text, because M10's
 * acceptance is a *repeat* run («連續 10 次生成») and a generator that is only
 * reproducible in the aggregate can't be debugged when one of the ten fails.
 *
 * Nothing is written to disk — every call goes through `ProjectSession`, so a
 * caller that doesn't like the result rolls back and nothing happened (§1.1
 * decision B). `generateGame` is what runs the checks; this file only builds.
 *
 * **Why this doesn't call `upsert_map_event` / `apply_script`.** Those are the
 * MCP layer, which sits *above* every other package and depends on this one —
 * writing events through them would invert the layering for the sake of
 * ~40 lines of page boilerplate. What it does share is the compiler: pages are
 * emitted from L2's IR, never as hand-built command arrays, so a generated
 * event is exactly as structurally sound as one an agent writes in the DSL.
 */

export interface Point {
  x: number;
  y: number;
}

export interface BuiltArea {
  key: string;
  name: string;
  mapId: number;
  /** Where a portal into this area drops the player, and where the game starts if it's the first area. */
  arrival: Point;
  rooms: Rect[];
}

export interface BuiltPortal {
  from: string;
  to: string;
  mapId: number;
  eventId: number;
  at: Point;
  target: { mapId: number } & Point;
}

export interface BuiltObjective {
  kind: ObjectiveSpec['kind'];
  /** The spec's own name for it, so a human opening the map recognises the event. */
  name: string;
  area: string;
  mapId: number;
  eventId: number;
  at: Point;
  /** fetch only. */
  itemId?: number;
  count?: number;
  /** defeat only. */
  troopId?: number;
}

/** The generated dialogue, resolved (spec override or default) — the walkthrough asserts against these, not against hardcoded strings. */
export interface QuestLines {
  locked: string;
  offer: string;
  accept: string;
  decline: string;
  remind: string;
  complete: string;
  done: string;
  /** What the objective event itself says. */
  objective: string;
  /** What it says once it has been used up. */
  objectiveSpent: string;
}

export interface BuiltQuest {
  key: string;
  title: string;
  /**
   * `quest.<key>.started` / `.done` / `.objective`. The third is allocated only
   * for objectives that need a flag of their own: a `fetch` is proven by the
   * item being in the bag, and a switch that duplicates that is one more thing
   * to get out of sync.
   */
  switches: { started: number; done: number; objective?: number };
  /**
   * `eventId` is shared with every other quest this NPC gives (one person, one
   * event), and `order` is this quest's position in that NPC's list — 0 is the
   * one they talk about first, and therefore the only one whose refusal is
   * reachable before anything is done.
   */
  giver: { area: string; name: string; mapId: number; eventId: number; at: Point; order: number };
  objective: BuiltObjective;
  reward?: QuestSpec['reward'];
  lines: QuestLines;
  requires: string[];
}

export interface BuiltFinale {
  area: string;
  name: string;
  mapId: number;
  eventId: number;
  at: Point;
  troopId: number;
  requires: string[];
  /** `game.clear` — the one switch that means "the player finished the game". */
  clearSwitch: number;
  lines: { locked: string; intro: string; victory: string; after: string };
}

export interface GameBuild {
  title: string;
  party: number[];
  startMapId: number;
  start: Point;
  /** Set by beating the finale. "Completable" means a run can turn this on. */
  clearSwitch: number;
  areas: BuiltArea[];
  portals: BuiltPortal[];
  quests: BuiltQuest[];
  finale: BuiltFinale;
  /** Rows this build appended, so a caller can tell generated content from the project's own. */
  created: { items: number[]; troops: number[] };
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

const BLANK_IMAGE: EventImage = { tileId: 0, characterName: '', characterIndex: 0, direction: 2, pattern: 0 };

interface PageDraft {
  conditions?: Partial<EventConditions>;
  nodes: Node[];
}

/**
 * Hands out distinct tiles inside an area's rooms. Two events on one tile is
 * legal MZ and a bug in every case we generate (the player can only talk to
 * the top one), so placement is an allocator, not a formula.
 *
 * Preference order is "middle of a room first, edges last", round-robined
 * across rooms: an NPC in a doorway is the one placement that can wall the
 * player out of a corridor, and spreading across rooms is also what stops a
 * six-quest area putting all twelve events in the same corner.
 *
 * Handed-out tiles are also kept orthogonally *apart*. A generated event is
 * `priorityType: 1` — it blocks movement — so "middle first" on its own packs
 * them into one solid blob around the room's centre, and the tiles inside that
 * blob are ones no player can ever step next to. With the arrival tile first in
 * line that includes the spawn point: four events in the starting room and the
 * player wakes up walled in. Nothing downstream would catch it, because the
 * walkthrough drives events with `runEvent` and never walks. Reserving each
 * taken tile's four neighbours costs about half the room and buys the invariant
 * that every event has a free tile to be talked to from.
 */
class Placer {
  private readonly tiles: Point[];
  private readonly taken = new Set<string>();
  private next = 0;

  constructor(rooms: Rect[]) {
    const perRoom = rooms.map((room) => tilesByCentrality(room));
    const depth = Math.max(0, ...perRoom.map((t) => t.length));
    const tiles: Point[] = [];
    for (let i = 0; i < depth; i++) {
      for (const room of perRoom) if (room[i]) tiles.push(room[i]);
    }
    this.tiles = tiles;
  }

  take(what: string): Point {
    while (this.next < this.tiles.length) {
      const tile = this.tiles[this.next++];
      if (NEIGHBOURS.some(([dx, dy]) => this.taken.has(`${tile.x + dx},${tile.y + dy}`))) continue;
      this.taken.add(`${tile.x},${tile.y}`);
      return tile;
    }
    throw new Error(`No free tile left to place ${what} — the area's rooms are full. Give it a larger width/height.`);
  }
}

const NEIGHBOURS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function tilesByCentrality(room: Rect): Point[] {
  const cx = room.x + (room.width - 1) / 2;
  const cy = room.y + (room.height - 1) / 2;
  const tiles: Point[] = [];
  for (let y = room.y; y < room.y + room.height; y++) {
    for (let x = room.x; x < room.x + room.width; x++) tiles.push({ x, y });
  }
  return tiles.sort((a, b) => {
    const da = Math.max(Math.abs(a.x - cx), Math.abs(a.y - cy));
    const db = Math.max(Math.abs(b.x - cx), Math.abs(b.y - cy));
    return da - db || a.y - b.y || a.x - b.x;
  });
}

export function buildGame(session: ProjectSession, spec: GameSpec): GameBuild {
  const seed = spec.seed ?? 0;
  const party = spec.party ?? [1];
  const allocator = new IdAllocator(session);

  // 1. Maps. One composed BSP map per area — connected by construction (M7),
  //    which is why nothing here has to check the *inside* of a map is walkable.
  const areas: BuiltArea[] = spec.areas.map((area, i) => {
    const result = composeMap(session, {
      name: area.name,
      width: area.width ?? 33,
      height: area.height ?? 25,
      // Passed through rather than left at blankMap's default: composeMap writes
      // its floor/wall passability into *the map's* tileset, so a map generated
      // against tileset 1 and re-pointed afterwards reads the other tileset's
      // flags — and stock MZ marks A4 kind 0 (cliff tops) passable, which is
      // walls you walk through.
      tilesetId: area.tilesetId,
      // Per-area seed offset, so reordering areas doesn't reshuffle every map.
      seed: seed + i * 7919,
    });
    return { key: area.key, name: area.name, mapId: result.mapId, arrival: { x: 0, y: 0 }, rooms: result.rooms };
  });
  const byKey = new Map(areas.map((a) => [a.key, a]));
  const placers = new Map(areas.map((a) => [a.key, new Placer(a.rooms)]));
  const place = (areaKey: string, what: string): Point => placers.get(areaKey)!.take(what);

  // 2. Positions, all of them, before a single event is written: a portal's
  //    destination is the *other* area's arrival tile, so the coordinates have
  //    to exist before either side can be emitted.
  for (const area of areas) area.arrival = place(area.key, `the arrival point of "${area.key}"`);

  const edges = portalEdges(spec);
  const portalSites = edges.map(([from, to]) => ({
    from,
    to,
    at: place(from, `the portal from "${from}" to "${to}"`),
    backAt: place(to, `the portal from "${to}" to "${from}"`),
  }));

  const order = questOrder(spec.quests);
  const questSpecs = order.map((key) => spec.quests.find((q) => q.key === key)!);
  // One tile — and later one event — per (area, name): two quests from the same
  // person are that person with two things to ask for, not two identical NPCs
  // standing in different rooms. Keyed on \0 because a name may contain
  // anything; the first quest to name them supplies the sprite.
  const givers = new Map<string, { area: string; name: string; at: Point; sprite?: Sprite; count: number }>();
  for (const quest of questSpecs) {
    const key = `${quest.giver.area} ${quest.giver.name}`;
    const existing = givers.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    givers.set(key, {
      area: quest.giver.area,
      name: quest.giver.name,
      at: place(quest.giver.area, `${quest.giver.name} (giver of "${quest.key}")`),
      sprite: quest.giver.sprite,
      count: 1,
    });
  }
  const giverOf = (quest: QuestSpec) => givers.get(`${quest.giver.area} ${quest.giver.name}`)!;

  const sites = questSpecs.map((quest) => ({
    quest,
    objective: place(quest.objective.area, `${quest.objective.name} (objective of "${quest.key}")`),
  }));
  const finaleAt = place(spec.finale.area, `${spec.finale.name} (the finale)`);

  // 3. Database rows and switch ids. Both before the events, which reference them.
  const created = { items: [] as number[], troops: [] as number[] };
  const clearSwitch = allocator.allocNamespace('game', { switches: ['clear'] }).switches.clear;

  const givenSoFar = new Map<string, number>();
  const quests: BuiltQuest[] = sites.map(({ quest, objective }) => {
    const needsFlag = quest.objective.kind !== 'fetch';
    // Named members, not counts: `quest.herb.started` is what a human skimming
    // the editor's switch list — or a repair loop reading feedback — sees.
    const ids = allocator.allocNamespace(`quest.${quest.key}`, {
      switches: needsFlag ? ['started', 'done', 'objective'] : ['started', 'done'],
    }).switches;
    const built = buildObjective(session, quest.objective, objective, byKey, created);
    const giver = giverOf(quest);
    const giverKey = `${giver.area} ${giver.name}`;
    const orderAtGiver = givenSoFar.get(giverKey) ?? 0;
    givenSoFar.set(giverKey, orderAtGiver + 1);
    return {
      key: quest.key,
      title: quest.title,
      switches: { started: ids.started, done: ids.done, objective: needsFlag ? ids.objective : undefined },
      giver: {
        area: quest.giver.area,
        name: quest.giver.name,
        mapId: byKey.get(quest.giver.area)!.mapId,
        eventId: 0,
        at: giver.at,
        order: orderAtGiver,
      },
      objective: built,
      reward: quest.reward,
      lines: questLines(session, quest, built),
      requires: quest.requires ?? [],
    };
  });

  const finaleTroop = resolveTroop(session, spec.finale.troop, spec.finale.name, created);
  const finale: BuiltFinale = {
    area: spec.finale.area,
    name: spec.finale.name,
    mapId: byKey.get(spec.finale.area)!.mapId,
    eventId: 0,
    at: finaleAt,
    troopId: finaleTroop,
    requires: spec.finale.requires ?? spec.quests.map((q) => q.key),
    clearSwitch,
    lines: finaleLines(spec.finale),
  };

  // 4. Events.
  const portals: BuiltPortal[] = [];
  const spriteOf = new Map(spec.areas.map((area) => [area.key, area.portalSprite]));
  for (const site of portalSites) {
    const from = byKey.get(site.from)!;
    const to = byKey.get(site.to)!;
    portals.push(writePortal(session, from, to, site.at, spriteOf.get(site.from)));
    portals.push(writePortal(session, to, from, site.backAt, spriteOf.get(site.to)));
  }

  const questsByKey = new Map(quests.map((q) => [q.key, q]));
  const objectiveSprites = new Map(questSpecs.map((quest) => [quest.key, quest.objective.sprite]));
  for (const quest of quests) writeObjectiveEvent(session, quest, objectiveSprites.get(quest.key));
  for (const giver of givers.values()) {
    const group = quests.filter((quest) => quest.giver.area === giver.area && quest.giver.name === giver.name);
    const eventId = writeGiverEvent(session, giver, group, questsByKey);
    for (const quest of group) quest.giver.eventId = eventId;
  }
  finale.eventId = writeFinaleEvent(session, finale, questsByKey, spec.finale.sprite);

  // 5. System. Without a start position the game boots into whatever map id 1
  //    happens to be, which after this build is usually not the first area.
  const start = areas[0];
  session.updateFile<Record<string, unknown>>('System.json', (data) => ({
    ...data,
    gameTitle: spec.title,
    partyMembers: party,
    startMapId: start.mapId,
    startX: start.arrival.x,
    startY: start.arrival.y,
  }));

  return {
    title: spec.title,
    party,
    startMapId: start.mapId,
    start: start.arrival,
    clearSwitch,
    areas,
    portals,
    quests,
    finale,
    created,
  };
}

/** Deduped area pairs, in a stable order — `a connects b` and `b connects a` are one portal pair, not two. */
function portalEdges(spec: GameSpec): Array<[string, string]> {
  const seen = new Set<string>();
  const edges: Array<[string, string]> = [];
  for (const area of spec.areas) {
    for (const to of area.connects ?? []) {
      if (to === area.key) continue;
      const key = [area.key, to].sort().join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([area.key, to]);
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Database rows
// ---------------------------------------------------------------------------

function buildObjective(
  session: ProjectSession,
  spec: ObjectiveSpec,
  at: Point,
  byKey: Map<string, BuiltArea>,
  created: { items: number[]; troops: number[] }
): BuiltObjective {
  const base = { kind: spec.kind, name: spec.name, area: spec.area, mapId: byKey.get(spec.area)!.mapId, eventId: 0, at };
  switch (spec.kind) {
    case 'fetch':
      return { ...base, itemId: resolveItem(session, spec.item, created), count: spec.count ?? 1 };
    case 'defeat':
      return { ...base, troopId: resolveTroop(session, spec.troop, spec.name, created) };
    case 'talk':
      return base;
  }
}

function resolveItem(
  session: ProjectSession,
  item: Extract<ObjectiveSpec, { kind: 'fetch' }>['item'],
  created: { items: number[] }
): number {
  if (typeof item === 'number') return item;
  const id = new IdAllocator(session).allocEntityId('Items.json');
  session.updateFile<Array<Record<string, unknown> | null>>('Items.json', (data) => {
    while (data.length <= id) data.push(null);
    data[id] = {
      id,
      name: item.name,
      iconIndex: 0,
      description: '',
      price: item.price ?? 0,
      // A quest item: it exists to be carried and handed over, so it is never
      // usable (occasion 3) and has no effect — an item with scope 0 that the
      // menu still offered would be a dead menu entry. `itypeId` still has to be
      // 1: Window_ItemList.includes() filters the "item" category on it, so a
      // row without one is carried but never listed, and the player cannot see
      // they have the thing the quest giver is asking for.
      itypeId: 1,
      consumable: true,
      scope: 0,
      occasion: 3,
      speed: 0,
      successRate: 100,
      repeats: 1,
      tpGain: 0,
      hitType: 0,
      animationId: 0,
      damage: { type: 0, elementId: 0, formula: '0', variance: 20 },
      effects: [],
      note: '',
    };
  });
  created.items.push(id);
  return id;
}

function resolveTroop(
  session: ProjectSession,
  troop: number | { enemyId: number; count?: number },
  name: string,
  created: { troops: number[] }
): number {
  if (typeof troop === 'number') return troop;
  const count = troop.count ?? 1;
  const id = new IdAllocator(session).allocEntityId('Troops.json');
  session.updateFile<Array<Record<string, unknown> | null>>('Troops.json', (data) => {
    while (data.length <= id) data.push(null);
    data[id] = {
      id,
      name,
      // Battler screen positions. Spread horizontally around MZ's own centre so
      // a generated troop of three doesn't stack into one sprite — but the row
      // has to stay on a 816-wide screen, so the spacing shrinks once a fixed
      // 140 would push the outermost member off the edge (count 6+).
      members: Array.from({ length: count }, (_, i) => ({
        enemyId: troop.enemyId,
        x: 300 + (i - (count - 1) / 2) * Math.min(140, count > 1 ? 560 / (count - 1) : 140),
        y: 300,
        hidden: false,
      })),
      // One empty page: MZ reads `pages[0].list` unconditionally when the battle
      // starts, so a troop without it crashes on encounter.
      pages: [
        {
          conditions: {
            actorHp: 50,
            actorId: 1,
            actorValid: false,
            enemyHp: 50,
            enemyIndex: 0,
            enemyValid: false,
            switchId: 1,
            switchValid: false,
            turnA: 0,
            turnB: 0,
            turnEnding: false,
            turnValid: false,
          },
          span: 0,
          list: [{ code: 0, indent: 0, parameters: [] }],
        },
      ],
    };
  });
  created.troops.push(id);
  return id;
}

// ---------------------------------------------------------------------------
// Dialogue
// ---------------------------------------------------------------------------

function itemName(session: ProjectSession, id: number): string {
  const rows = session.readFile<Array<{ id: number; name?: string } | null>>('Items.json');
  return rows[id]?.name ?? `item ${id}`;
}

function questLines(session: ProjectSession, quest: QuestSpec, objective: BuiltObjective): QuestLines {
  const lines = quest.lines ?? {};
  const target = quest.objective.name;
  const what =
    objective.kind === 'fetch'
      ? `Bring me ${objective.count} ${itemName(session, objective.itemId!)}.`
      : objective.kind === 'defeat'
        ? `Deal with ${target}.`
        : `Go and speak to ${target}.`;

  // Every default names the quest or its target. That is not decoration: the
  // walkthrough asserts on message text, and a game whose NPCs all say "Thank
  // you!" gives a passing assertion no evidence that the *right* one said it.
  return {
    locked: lines.locked ?? `${quest.title} will have to wait — there is something else to see to first.`,
    offer: lines.offer ?? `${quest.title}. ${what} Will you help?`,
    accept: lines.accept ?? `Thank you. ${what}`,
    decline: lines.decline ?? `Come back if you change your mind about ${quest.title}.`,
    remind: lines.remind ?? `Any luck with ${quest.title}?`,
    complete: lines.complete ?? `That settles ${quest.title}. You have my thanks.`,
    done: lines.done ?? `${quest.title} is behind us, thanks to you.`,
    objective:
      quest.objective.text ??
      (objective.kind === 'fetch'
        ? `You gather ${objective.count} ${itemName(session, objective.itemId!)}.`
        : objective.kind === 'defeat'
          ? `${target} blocks the way!`
          : `${target}: "So you are here about ${quest.title}. Consider it done."`),
    objectiveSpent: `There is nothing more to do about ${quest.title} here.`,
  };
}

function finaleLines(spec: FinaleSpec): BuiltFinale['lines'] {
  const lines = spec.lines ?? {};
  return {
    locked: lines.locked ?? `${spec.name} is beyond your reach — there is unfinished business elsewhere.`,
    intro: lines.intro ?? `${spec.name} bars the way!`,
    victory: lines.victory ?? `${spec.name} is defeated. It is over.`,
    after: `${spec.name} troubles no one now.`,
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function writePortal(session: ProjectSession, from: BuiltArea, to: BuiltArea, at: Point, sprite?: Sprite): BuiltPortal {
  const eventId = writeEvent(session, from.mapId, {
    name: `To ${to.name}`,
    at,
    sprite,
    pages: [
      {
        nodes: [
          say('', `The way to ${to.name}.`),
          { kind: 'transfer', mapId: to.mapId, x: to.arrival.x, y: to.arrival.y, direction: 2, fadeType: 0 },
        ],
      },
    ],
  });
  return { from: from.key, to: to.key, mapId: from.mapId, eventId, at, target: { mapId: to.mapId, ...to.arrival } };
}

/**
 * The NPC, and every quest they give: one event, one page, one chain of
 * branches — the whole quest state machine as commands rather than as pages.
 *
 * It used to be three pages per quest, which is the natural MZ idiom for *one*
 * quest and has no answer at all for two. An NPC's pages are matched
 * last-to-first on their conditions, so two quests' page sets concatenated
 * either shadow each other (which `validate`'s semantics/dead-event-page rule
 * correctly calls an error) or need a gate invented between them. Branches say
 * the same thing without either problem, and the ordering — `requires` order,
 * i.e. `questOrder` — is the one the player can actually do them in:
 *
 *     if quest 1 done  -> acknowledge it, fall through to quest 2
 *     otherwise        -> offer / remind / take the turn-in, and stop here
 *
 * so the NPC talks about the first thing they still want, and thanks you for
 * what is already behind you on the way.
 */
function writeGiverEvent(
  session: ProjectSession,
  giver: { area: string; name: string; at: Point; sprite?: Sprite },
  group: BuiltQuest[],
  byKey: Map<string, BuiltQuest>
): number {
  const nodes: Node[] = group.map((quest) => ({
    kind: 'if',
    condition: { type: 'switch', switchId: quest.switches.done, value: true },
    then: [say(giver.name, quest.lines.done)],
    // exitEvent, so an unfinished quest is the last thing this NPC talks about:
    // without it they would offer everything they have in one conversation.
    else: [...questNodes(quest, giver.name, byKey), { kind: 'exitEvent' }],
  }));

  return writeEvent(session, group[0].giver.mapId, {
    name: giver.name,
    at: giver.at,
    sprite: giver.sprite,
    pages: [{ nodes }],
  });
}

/** One quest's half of the conversation: locked, offer, remind, or turn-in. */
function questNodes(quest: BuiltQuest, speaker: string, byKey: Map<string, BuiltQuest>): Node[] {
  const gate: Node[] = quest.requires.flatMap((key) => {
    const needed = byKey.get(key);
    if (!needed) return [];
    // Guard clause rather than nesting: one `if` per requirement, each bailing
    // out, keeps the offer at one indent no matter how many prerequisites there
    // are — nesting would repeat the locked line once per level.
    return [
      {
        kind: 'if' as const,
        condition: { type: 'switch' as const, switchId: needed.switches.done, value: false },
        then: [say(speaker, quest.lines.locked), { kind: 'exitEvent' as const }],
      },
    ];
  });

  return [
    {
      kind: 'if',
      condition: { type: 'switch', switchId: quest.switches.started, value: true },
      then: [
        {
          kind: 'if',
          condition: objectiveCondition(quest),
          then: [say(speaker, quest.lines.complete), ...turnIn(quest)],
          else: [say(speaker, quest.lines.remind)],
        },
      ],
      else: [
        ...gate,
        say(speaker, quest.lines.offer),
        {
          kind: 'choice',
          choices: ['Yes', 'Not now'],
          // Cancel picks "Not now": declining a quest must never be a state
          // change, so the escape hatch routes to the branch that isn't one.
          cancelType: 1,
          defaultType: 0,
          positionType: 2,
          background: 0,
          branches: [
            [
              { kind: 'setSwitch', from: quest.switches.started, to: quest.switches.started, value: true },
              say(speaker, quest.lines.accept),
            ],
            [say(speaker, quest.lines.decline)],
          ],
        },
      ],
    },
  ];
}

/**
 * "Has the player finished the objective?" — a possession check for a fetch
 * (Conditional Branch type 8), the objective switch otherwise.
 *
 * The item form is exact rather than approximate *because* the objective event
 * hands over the whole `count` in one interaction: possession therefore implies
 * possession of all of them, which is the only reason a type-8 branch (which
 * only ever asks "at least one") can gate a multi-item turn-in honestly.
 */
function objectiveCondition(quest: BuiltQuest): Extract<Node, { kind: 'if' }>['condition'] {
  if (quest.objective.kind === 'fetch') return { type: 'raw', parameters: [8, quest.objective.itemId] };
  return { type: 'switch', switchId: quest.switches.objective!, value: true };
}

function turnIn(quest: BuiltQuest): Node[] {
  const nodes: Node[] = [];
  if (quest.objective.kind === 'fetch') {
    // Inside the possession branch, so it can't take the count negative — and
    // so validate's semantics/possible-negative-item rule can see the guard.
    nodes.push({
      kind: 'gainItem',
      itemId: quest.objective.itemId!,
      operation: 1,
      operandType: 0,
      value: quest.objective.count ?? 1,
    });
  }
  if (quest.reward?.gold) {
    nodes.push({ kind: 'gainGold', operation: 0, operandType: 0, value: quest.reward.gold });
  }
  if (quest.reward?.itemId) {
    nodes.push({
      kind: 'gainItem',
      itemId: quest.reward.itemId,
      operation: 0,
      operandType: 0,
      value: quest.reward.itemCount ?? 1,
    });
  }
  nodes.push({ kind: 'setSwitch', from: quest.switches.done, to: quest.switches.done, value: true });
  return nodes;
}

/**
 * The objective, in two pages: do the thing (gated on the quest running), then
 * a spent page gated on self switch A. Before the quest starts *neither* page
 * matches and the event is inert — which is deliberate, and is what the gates
 * scenario asserts: a herb patch you can strip before anyone asks you to is how
 * a quest chain ends up completable out of order.
 */
function writeObjectiveEvent(session: ProjectSession, quest: BuiltQuest, sprite?: Sprite): void {
  const objective = quest.objective;
  const done: Node[] = [{ kind: 'setSelfSwitch', ch: 'A', value: true }];
  const active: Node[] =
    objective.kind === 'fetch'
      ? [
          say('', quest.lines.objective),
          { kind: 'gainItem', itemId: objective.itemId!, operation: 0, operandType: 0, value: objective.count ?? 1 },
          ...done,
        ]
      : objective.kind === 'defeat'
        ? [
            say('', quest.lines.objective),
            {
              kind: 'battle',
              designation: 0,
              troopId: objective.troopId!,
              // No escape and no lose branch: MZ's own defaults, and both
              // branches would need a story this generator doesn't have. Losing
              // is a game over the player retries from, not a dead end.
              canEscape: false,
              canLose: false,
              win: [
                { kind: 'setSwitch', from: quest.switches.objective!, to: quest.switches.objective!, value: true },
                ...done,
              ],
            },
          ]
        : [
            say('', quest.lines.objective),
            { kind: 'setSwitch', from: quest.switches.objective!, to: quest.switches.objective!, value: true },
            ...done,
          ];

  objective.eventId = writeEvent(session, objective.mapId, {
    name: objective.name,
    at: objective.at,
    sprite,
    pages: [
      { conditions: { switch1Valid: true, switch1Id: quest.switches.started }, nodes: active },
      { conditions: { selfSwitchValid: true, selfSwitchCh: 'A' }, nodes: [say('', quest.lines.objectiveSpent)] },
    ],
  });
}

function writeFinaleEvent(
  session: ProjectSession,
  finale: BuiltFinale,
  byKey: Map<string, BuiltQuest>,
  sprite?: Sprite
): number {
  const gate: Node[] = finale.requires.flatMap((key) => {
    const needed = byKey.get(key);
    if (!needed) return [];
    return [
      {
        kind: 'if' as const,
        condition: { type: 'switch' as const, switchId: needed.switches.done, value: false },
        then: [say('', finale.lines.locked), { kind: 'exitEvent' as const }],
      },
    ];
  });

  return writeEvent(session, finale.mapId, {
    name: finale.name,
    at: finale.at,
    sprite,
    pages: [
      {
        nodes: [
          ...gate,
          say('', finale.lines.intro),
          {
            kind: 'battle',
            designation: 0,
            troopId: finale.troopId,
            canEscape: false,
            canLose: false,
            win: [
              say('', finale.lines.victory),
              { kind: 'setSwitch', from: finale.clearSwitch, to: finale.clearSwitch, value: true },
            ],
          },
        ],
      },
      { conditions: { switch1Valid: true, switch1Id: finale.clearSwitch }, nodes: [say('', finale.lines.after)] },
    ],
  });
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function say(speaker: string, ...lines: string[]): Node {
  return {
    kind: 'text',
    face: '',
    faceIndex: 0,
    background: 0,
    position: 2,
    // Omitted entirely when there is no speaker: MZ's 5th parameter is the name
    // box, and an empty one still draws.
    speakerName: speaker || undefined,
    lines,
  };
}

function writeEvent(
  session: ProjectSession,
  mapId: number,
  event: { name: string; at: Point; sprite?: Sprite; pages: PageDraft[] }
): number {
  let id = 0;
  session.updateFile<MapData>(mapFileName(mapId), (map) => {
    id = 1;
    while (map.events[id]) id++;
    const built: MapEvent = {
      id,
      name: event.name,
      note: '',
      x: event.at.x,
      y: event.at.y,
      pages: event.pages.map((page) => makePage(page, event.sprite)),
    };
    while (map.events.length <= id) map.events.push(null);
    map.events[id] = built;
  });
  return id;
}

function makePage(page: PageDraft, sprite?: Sprite): EventPage {
  return {
    conditions: { ...DEFAULT_CONDITIONS, ...page.conditions },
    directionFix: false,
    // The same sprite on every page: an NPC that changes appearance between
    // quest states is a decision the spec doesn't express, and a blank page 2
    // would make them vanish mid-quest.
    image: { ...BLANK_IMAGE, ...sprite },
    list: compile(page.nodes),
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 3,
    moveType: 0,
    priorityType: 1,
    stepAnime: false,
    through: false,
    trigger: 0,
    walkAnime: true,
  };
}
