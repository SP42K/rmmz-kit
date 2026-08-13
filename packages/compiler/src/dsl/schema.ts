import { z } from 'zod';
import { SIMPLE_COMMANDS, SIMPLE_KINDS, type SimpleFields, type SimpleKind } from '../ir.js';

/**
 * The YAML authoring surface (plan §4.2): what an LLM/human writes. Deliberately
 * narrower than ir.ts's Node — no indent, no command codes. Switches/variables
 * take a raw numeric id or a `namespace.member` name (§4.2's sugar, §8.1-1):
 * names are resolved to ids at parse time via the resolver parseDsl is given,
 * so the IR — and everything downstream of it — stays numeric.
 */
export type Step =
  | { say: string | SayPayload }
  | { comment: string | string[] }
  | { if: IfPayload }
  | { choice: ChoicePayload }
  | { loop: { body: Step[] } }
  | { setSwitch: { from: number | string; to?: number | string; value: boolean } }
  | { setVariable: { from: number | string; to?: number | string; op?: VariableOp; value: number } }
  | { setSelfSwitch: { ch: 'A' | 'B' | 'C' | 'D'; value: boolean } }
  | { callCommonEvent: number }
  | { transfer: { mapId: number; x: number; y: number; direction?: number; fade?: number } }
  | { wait: number }
  | { playSe: { name: string; volume?: number; pitch?: number; pan?: number } }
  | { raw: { code: number; parameters: unknown[]; body?: Step[] } }
  // Tier 2 (M7.5).
  | SimpleStep
  | { moveRoute: MoveRoutePayload }
  | { playBgm: { name: string; volume?: number; pitch?: number; pan?: number } }
  | { battle: BattlePayload }
  | { shop: ShopPayload }
  | { script: string | string[] }
  | { pluginCommand: { plugin: string; command: string; label?: string; args?: Record<string, unknown> } };

/**
 * One step per ir.ts SIMPLE_COMMANDS entry, e.g. `{ gainGold: { value: 100 } }`.
 * Every field is optional (the table's value is the default) and `null` is
 * accepted for the whole payload, because a parameterless command written the
 * natural YAML way — `- fadeOut:` — parses as `{ fadeOut: null }`.
 */
export type SimpleStep = { [K in SimpleKind]: { [P in K]: SimpleFields<K> | null } }[SimpleKind];

export interface MoveRoutePayload {
  /** -1 player, 0 this event (default), >0 event id. */
  characterId?: number;
  repeat?: boolean;
  skippable?: boolean;
  /** Wait for the route to finish before running the next command. */
  wait?: boolean;
  route: MoveStepSpec[];
}

/** A route step: a MOVE_ROUTE_CODES name on its own, or a name/code plus parameters. */
export type MoveStepSpec = string | { step: string | number; parameters?: unknown[] };

export interface BattlePayload {
  /** 0 = troopId is the troop (default), 1 = troopId is a variable, 2 = random encounter. */
  designation?: number;
  troopId?: number;
  canEscape?: boolean;
  canLose?: boolean;
  win?: Step[];
  escape?: Step[];
  lose?: Step[];
}

export interface ShopPayload {
  goods: Array<{ type?: number; id: number; priceType?: number; price?: number }>;
  purchaseOnly?: boolean;
}

export type VariableOp = 'set' | 'add' | 'sub' | 'mul' | 'div' | 'mod';

export interface SayPayload {
  text: string | string[];
  speaker?: string;
  /** "FileName/Index", e.g. "Actor1/2". */
  face?: string;
  background?: number;
  position?: number;
}

export interface IfPayload {
  switch?: number | string;
  is?: boolean;
  variable?: number | string;
  cmp?: 'eq' | 'gte' | 'lte' | 'gt' | 'lt' | 'neq';
  value?: number;
  script?: string;
  /** Escape hatch for any 111 parameter shape this DSL doesn't model — see Condition['raw'] in ir.ts. */
  raw?: unknown[];
  then: Step[];
  else?: Step[];
}

export interface ChoicePayload {
  cancelType?: number;
  defaultType?: number;
  positionType?: number;
  background?: number;
  /** Key = choice label, in display order (JS/YAML preserve object key order). */
  branches: Record<string, Step[]>;
  cancel?: Step[];
}

const stepArray = (): z.ZodType<Step[]> => z.lazy(() => z.array(StepSchema));

/** A raw numeric id, or a `namespace.member` name parseDsl's resolver turns into one. */
const idOrName = z.union([z.number().int(), z.string()]);

/**
 * Every payload object is `.strict()`, not just the outer step wrappers. All
 * of these fields are optional, so a stripping schema would accept `els:` /
 * `speeker:` / `cancle:` and silently drop the value — for a surface whose
 * whole point is being written by an LLM, a mistyped key that quietly deletes
 * an else-branch is the worst possible failure mode. Reject instead.
 */
const SayPayloadSchema: z.ZodType<SayPayload> = z
  .object({
    text: z.union([z.string(), z.array(z.string())]),
    speaker: z.string().optional(),
    face: z.string().optional(),
    background: z.number().int().optional(),
    position: z.number().int().optional(),
  })
  .strict();

const IfPayloadSchema: z.ZodType<IfPayload> = z.lazy(() =>
  z
    .object({
      switch: idOrName.optional(),
      is: z.boolean().optional(),
      variable: idOrName.optional(),
      cmp: z.enum(['eq', 'gte', 'lte', 'gt', 'lt', 'neq']).optional(),
      value: z.number().optional(),
      script: z.string().optional(),
      raw: z.array(z.unknown()).optional(),
      then: stepArray(),
      else: stepArray().optional(),
    })
    .strict()
);

const ChoicePayloadSchema: z.ZodType<ChoicePayload> = z.lazy(() =>
  z
    .object({
      cancelType: z.number().int().optional(),
      defaultType: z.number().int().optional(),
      positionType: z.number().int().optional(),
      background: z.number().int().optional(),
      branches: z.record(z.string(), stepArray()),
      cancel: stepArray().optional(),
    })
    .strict()
);

/**
 * The flat-parameter Tier 2 steps, generated from ir.ts's table rather than
 * hand-written 22 times — same reason emit/decompile read it: the table *is*
 * the parameter contract, and a second hand-maintained copy of it here would
 * only ever be a way for the two to disagree.
 */
const SimpleStepSchemas: Array<z.ZodType<Step>> = SIMPLE_KINDS.map((kind) => {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, value] of Object.entries(SIMPLE_COMMANDS[kind].fields as Record<string, unknown>)) {
    const field = typeof value === 'number' ? z.number().int() : typeof value === 'string' ? z.string() : z.boolean();
    shape[name] = field.optional();
  }
  return z.object({ [kind]: z.object(shape).strict().nullable() }).strict() as unknown as z.ZodType<Step>;
});

const MoveStepSchema: z.ZodType<MoveStepSpec> = z.union([
  z.string(),
  z.object({ step: z.union([z.string(), z.number().int()]), parameters: z.array(z.unknown()).optional() }).strict(),
]);

const MoveRoutePayloadSchema: z.ZodType<MoveRoutePayload> = z
  .object({
    characterId: z.number().int().optional(),
    repeat: z.boolean().optional(),
    skippable: z.boolean().optional(),
    wait: z.boolean().optional(),
    route: z.array(MoveStepSchema),
  })
  .strict();

const BattlePayloadSchema: z.ZodType<BattlePayload> = z.lazy(() =>
  z
    .object({
      designation: z.number().int().optional(),
      troopId: z.number().int().optional(),
      canEscape: z.boolean().optional(),
      canLose: z.boolean().optional(),
      win: stepArray().optional(),
      escape: stepArray().optional(),
      lose: stepArray().optional(),
    })
    .strict()
);

const ShopPayloadSchema: z.ZodType<ShopPayload> = z
  .object({
    goods: z
      .array(
        z
          .object({
            type: z.number().int().min(0).max(2).optional().describe('0 item (default), 1 weapon, 2 armor'),
            id: z.number().int(),
            priceType: z.number().int().optional().describe("0 the item's own price (default), 1 the `price` below"),
            price: z.number().int().optional(),
          })
          .strict()
      )
      .min(1),
    purchaseOnly: z.boolean().optional(),
  })
  .strict();

export const StepSchema: z.ZodType<Step> = z.lazy(() =>
  // The spread of the generated members makes this an array, not the tuple
  // z.union's signature wants; the members are all ZodType<Step> either way.
  z.union([
    z.object({ say: z.union([z.string(), SayPayloadSchema]) }).strict(),
    z.object({ comment: z.union([z.string(), z.array(z.string())]) }).strict(),
    z.object({ if: IfPayloadSchema }).strict(),
    z.object({ choice: ChoicePayloadSchema }).strict(),
    z.object({ loop: z.object({ body: stepArray() }).strict() }).strict(),
    z
      .object({
        setSwitch: z.object({ from: idOrName, to: idOrName.optional(), value: z.boolean() }).strict(),
      })
      .strict(),
    z
      .object({
        setVariable: z
          .object({
            from: idOrName,
            to: idOrName.optional(),
            op: z.enum(['set', 'add', 'sub', 'mul', 'div', 'mod']).optional(),
            value: z.number(),
          })
          .strict(),
      })
      .strict(),
    z.object({ setSelfSwitch: z.object({ ch: z.enum(['A', 'B', 'C', 'D']), value: z.boolean() }).strict() }).strict(),
    z.object({ callCommonEvent: z.number().int() }).strict(),
    z
      .object({
        transfer: z
          .object({
            mapId: z.number().int(),
            x: z.number().int(),
            y: z.number().int(),
            direction: z.number().int().optional(),
            fade: z.number().int().optional(),
          })
          .strict(),
      })
      .strict(),
    z.object({ wait: z.number().int().nonnegative() }).strict(),
    z
      .object({
        playSe: z
          .object({
            name: z.string(),
            volume: z.number().optional(),
            pitch: z.number().optional(),
            pan: z.number().optional(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        raw: z
          .object({ code: z.number().int(), parameters: z.array(z.unknown()), body: stepArray().optional() })
          .strict(),
      })
      .strict(),
    z.object({ moveRoute: MoveRoutePayloadSchema }).strict(),
    z
      .object({
        playBgm: z
          .object({
            name: z.string(),
            volume: z.number().optional(),
            pitch: z.number().optional(),
            pan: z.number().optional(),
          })
          .strict(),
      })
      .strict(),
    z.object({ battle: BattlePayloadSchema }).strict(),
    z.object({ shop: ShopPayloadSchema }).strict(),
    z.object({ script: z.union([z.string(), z.array(z.string())]) }).strict(),
    z
      .object({
        pluginCommand: z
          .object({
            plugin: z.string(),
            command: z.string(),
            label: z.string().optional(),
            args: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      })
      .strict(),
    ...SimpleStepSchemas,
  ] as unknown as [z.ZodType<Step>, z.ZodType<Step>, ...Array<z.ZodType<Step>>])
);

export const StepListSchema = z.array(StepSchema);
