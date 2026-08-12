import { z } from 'zod';

/**
 * The `GameSpec` — M10's contract, and the only place the one-sentence brief
 * turns into something deterministic.
 *
 * Plan §3 M10 is「一句話 → 30-60 分鐘可玩小 RPG」and says outright that the
 * milestone is 編排與 prompt 工程, not new architecture. Splitting it the way
 * this repo has split every model-shaped milestone (M6, M8, M9): the half that
 * needs a model is the *plan* — which quests exist, who gives them, what the
 * boss is — and in this architecture the model is the MCP client. So that half
 * is a typed document the client writes, and everything downstream of it (maps,
 * events, switch allocation, the walkthrough that proves the result is
 * completable) is deterministic code in this package.
 *
 * Every field carries a `.describe()` because this schema *is* the prompt: it
 * is what the client reads before writing a spec, the same argument §4.5 makes
 * for the asset catalog and server.ts makes for the scenario step union.
 */

const key = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'keys are lowercase identifiers: a-z, 0-9, _ and -')
  .describe('Stable identifier other parts of the spec refer to; also names the switch namespace');

const troop = z
  .union([
    z.number().int().min(1).describe('An existing Troops.json row id'),
    z
      .object({
        enemyId: z.number().int().min(1).describe('An existing Enemies.json row id'),
        count: z.number().int().min(1).max(8).optional().describe('How many of it (default 1)'),
      })
      .strict()
      .describe('Generate a troop from an enemy that already exists'),
  ])
  .describe(
    'The enemy side. Designing an *enemy* is a balance question simulate_battle answers, so this only ' +
      'ever arranges enemies the project already has — it never invents stats.'
  );

export const AreaSpecSchema = z
  .object({
    key,
    name: z.string().min(1).describe("The map's name in the editor's map tree"),
    width: z.number().int().min(15).max(120).optional().describe('Default 33'),
    height: z.number().int().min(15).max(120).optional().describe('Default 25'),
    connects: z
      .array(key)
      .optional()
      .describe(
        'Area keys this one links to. Each edge becomes a *pair* of portal events, one on each side, ' +
          'so it is enough to declare it once. Every area must be reachable from the first area in the list.'
      ),
  })
  .strict();

export const ObjectiveSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('fetch'),
        area: key,
        name: z.string().min(1).describe('Name of the event the player interacts with (a herb patch, a chest)'),
        item: z
          .union([
            z.number().int().min(1).describe('An existing Items.json row id'),
            z.object({ name: z.string().min(1), price: z.number().int().min(0).optional() }).strict().describe('Create this item'),
          ])
          .describe('What the player picks up; the giver checks the party actually carries it'),
        count: z.number().int().min(1).optional().describe('How many (default 1)'),
        text: z.string().optional().describe('Line shown when the player picks it up'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('defeat'),
        area: key,
        name: z.string().min(1),
        troop,
        text: z.string().optional().describe('Line shown before the fight'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('talk'),
        area: key,
        name: z.string().min(1),
        text: z.string().optional().describe('What this NPC says'),
      })
      .strict(),
  ])
  .describe('What completes the quest. Every kind ends up gating the giver the same way.');

export const QuestSpecSchema = z
  .object({
    key,
    title: z.string().min(1).describe('Shown in dialogue, and what the generated messages are keyed on'),
    giver: z
      .object({ area: key, name: z.string().min(1) })
      .strict()
      .describe('The NPC that offers the quest and takes the turn-in'),
    objective: ObjectiveSchema,
    reward: z
      .object({
        gold: z.number().int().min(0).optional(),
        itemId: z.number().int().min(1).optional().describe('An existing Items.json row id'),
        itemCount: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
    requires: z
      .array(key)
      .optional()
      .describe('Quest keys that must be finished first. The giver refuses to offer this one until they are.'),
    lines: z
      .object({
        offer: z.string().optional(),
        accept: z.string().optional(),
        decline: z.string().optional(),
        locked: z.string().optional().describe('Shown while `requires` is unmet'),
        remind: z.string().optional().describe('Shown while the objective is outstanding'),
        complete: z.string().optional().describe('Shown on turn-in'),
        done: z.string().optional().describe('Shown afterwards, forever'),
      })
      .strict()
      .optional()
      .describe('Every line has a generated default that names the quest; override the ones worth writing'),
  })
  .strict();

export const FinaleSpecSchema = z
  .object({
    area: key,
    name: z.string().min(1).describe('The boss, or whatever the player confronts last'),
    troop,
    requires: z.array(key).optional().describe('Quest keys that must be finished first (default: all of them)'),
    lines: z
      .object({ locked: z.string().optional(), intro: z.string().optional(), victory: z.string().optional() })
      .strict()
      .optional(),
  })
  .strict();

export const GameSpecSchema = z
  .object({
    title: z.string().min(1).describe("The game's title (System.json gameTitle)"),
    seed: z.number().int().optional().describe('Same seed + same spec = byte-identical maps. Default 0.'),
    party: z
      .array(z.number().int().min(1))
      .min(1)
      .optional()
      .describe('Actor ids the game starts with. Default [1]. They must exist in Actors.json.'),
    areas: z.array(AreaSpecSchema).min(1).describe('The first area is where the game starts'),
    quests: z.array(QuestSpecSchema).describe('The chain the player works through, in any order — `requires` is what sequences them'),
    finale: FinaleSpecSchema.describe('What ends the game. Beating it sets the clear switch, which is what "completable" means here.'),
  })
  .strict();

export type AreaSpec = z.infer<typeof AreaSpecSchema>;
export type ObjectiveSpec = z.infer<typeof ObjectiveSchema>;
export type QuestSpec = z.infer<typeof QuestSpecSchema>;
export type FinaleSpec = z.infer<typeof FinaleSpecSchema>;
export type GameSpec = z.infer<typeof GameSpecSchema>;

export interface SpecIssue {
  code: string;
  message: string;
  /** Where in the spec, e.g. `quests[2].requires[0]`. */
  path: string;
}

/**
 * Everything about a spec that makes the finished game unplayable *before* a
 * single file is touched — the plan's acceptance is「可完整通關且不卡關」, and
 * the cheapest way to fail that is a spec whose quest graph has a cycle or
 * whose boss lives on a map nothing links to.
 *
 * These are structural, not aesthetic: nothing here judges whether the game is
 * any *good*, only whether a player can reach the end of it. That limit is the
 * honest one — see the acceptance note in CLAUDE.md.
 */
export function checkSpec(spec: GameSpec): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const add = (code: string, path: string, message: string) => issues.push({ code, path, message });

  const areaKeys = new Set<string>();
  for (const [i, area] of spec.areas.entries()) {
    if (areaKeys.has(area.key)) add('duplicate-area', `areas[${i}].key`, `Two areas share the key "${area.key}"`);
    areaKeys.add(area.key);
  }

  const questKeys = new Set<string>();
  for (const [i, quest] of spec.quests.entries()) {
    if (questKeys.has(quest.key)) add('duplicate-quest', `quests[${i}].key`, `Two quests share the key "${quest.key}"`);
    questKeys.add(quest.key);
  }

  const area = (value: string, path: string) => {
    if (!areaKeys.has(value)) add('unknown-area', path, `No area has the key "${value}"`);
  };
  const quest = (value: string, path: string) => {
    if (!questKeys.has(value)) add('unknown-quest', path, `No quest has the key "${value}"`);
  };

  for (const [i, a] of spec.areas.entries()) {
    for (const [j, to] of (a.connects ?? []).entries()) {
      if (to === a.key) add('self-connection', `areas[${i}].connects[${j}]`, `Area "${a.key}" connects to itself`);
      else area(to, `areas[${i}].connects[${j}]`);
    }
  }
  for (const [i, q] of spec.quests.entries()) {
    area(q.giver.area, `quests[${i}].giver.area`);
    area(q.objective.area, `quests[${i}].objective.area`);
    for (const [j, r] of (q.requires ?? []).entries()) {
      if (r === q.key) add('self-requirement', `quests[${i}].requires[${j}]`, `Quest "${q.key}" requires itself`);
      else quest(r, `quests[${i}].requires[${j}]`);
    }
  }
  area(spec.finale.area, 'finale.area');
  for (const [j, r] of (spec.finale.requires ?? []).entries()) quest(r, `finale.requires[${j}]`);

  // A cycle in `requires` is the purest softlock the spec can express: neither
  // quest can ever be offered, so the finale can never be unlocked. Reported
  // per cycle member so the client sees the whole loop, not one arbitrary edge.
  for (const cycle of findCycles(spec.quests)) {
    add('requirement-cycle', `quests`, `Quest requirements form a cycle: ${cycle.join(' -> ')}. None of these can ever be started.`);
  }

  // Reachability over the *undirected* area graph — a portal pair is two-way,
  // so an area is reachable exactly when the graph connects it to the start.
  const start = spec.areas[0]?.key;
  if (start) {
    const reached = reachableAreas(spec, start);
    for (const [i, a] of spec.areas.entries()) {
      if (!reached.has(a.key)) {
        add(
          'unreachable-area',
          `areas[${i}]`,
          `Area "${a.key}" is not connected to the starting area "${start}" — add it to some area's \`connects\`. ` +
            `Everything placed there would be unreachable.`
        );
      }
    }
  }

  return issues;
}

function findCycles(quests: QuestSpec[]): string[][] {
  const edges = new Map(quests.map((q) => [q.key, (q.requires ?? []).filter((r) => r !== q.key)]));
  const cycles: string[][] = [];
  const state = new Map<string, 'open' | 'closed'>();
  const stack: string[] = [];

  const visit = (node: string): void => {
    const seen = state.get(node);
    if (seen === 'closed') return;
    if (seen === 'open') {
      const from = stack.indexOf(node);
      if (from !== -1) cycles.push([...stack.slice(from), node]);
      return;
    }
    state.set(node, 'open');
    stack.push(node);
    for (const next of edges.get(node) ?? []) visit(next);
    stack.pop();
    state.set(node, 'closed');
  };

  for (const q of quests) visit(q.key);
  return cycles;
}

function reachableAreas(spec: GameSpec, start: string): Set<string> {
  const neighbours = new Map<string, string[]>(spec.areas.map((a) => [a.key, []]));
  for (const a of spec.areas) {
    for (const to of a.connects ?? []) {
      if (to === a.key || !neighbours.has(to)) continue;
      neighbours.get(a.key)!.push(to);
      neighbours.get(to)!.push(a.key);
    }
  }

  const reached = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const next of neighbours.get(queue.shift()!) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  return reached;
}

/**
 * Quest keys in an order where every quest's `requires` come before it — the
 * order a player can actually do them in, and therefore the order the
 * walkthrough plays them.
 *
 * A cycle has no such order, so its members come out in an arbitrary one rather
 * than being dropped: `checkSpec` refuses a cyclic spec outright and nothing is
 * built from it, so the only caller never sees the degenerate case. Dropping
 * them here would silently generate a *smaller* game instead.
 */
export function questOrder(quests: QuestSpec[]): string[] {
  const byKey = new Map(quests.map((q) => [q.key, q]));
  const order: string[] = [];
  const done = new Set<string>();
  const active = new Set<string>();

  const visit = (key: string): void => {
    if (done.has(key) || active.has(key)) return;
    const quest = byKey.get(key);
    if (!quest) return;
    active.add(key);
    for (const need of quest.requires ?? []) visit(need);
    active.delete(key);
    done.add(key);
    order.push(key);
  };

  for (const q of quests) visit(q.key);
  return order;
}
