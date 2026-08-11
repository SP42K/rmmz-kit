import { z } from 'zod';

/**
 * The YAML authoring surface (plan §4.2): what an LLM/human writes. Deliberately
 * narrower than ir.ts's Node — no indent, no command codes, switches/variables
 * addressed by raw numeric id (the plan's `quest.herb.started`-style namespaced
 * expression language is a separate, not-yet-built layer on top of IdAllocator;
 * this DSL is the id-based floor it would compile down to).
 */
export type Step =
  | { say: string | SayPayload }
  | { comment: string | string[] }
  | { if: IfPayload }
  | { choice: ChoicePayload }
  | { loop: { body: Step[] } }
  | { setSwitch: { from: number; to?: number; value: boolean } }
  | { setVariable: { from: number; to?: number; op?: VariableOp; value: number } }
  | { setSelfSwitch: { ch: 'A' | 'B' | 'C' | 'D'; value: boolean } }
  | { callCommonEvent: number }
  | { transfer: { mapId: number; x: number; y: number; direction?: number; fade?: number } }
  | { wait: number }
  | { playSe: { name: string; volume?: number; pitch?: number; pan?: number } }
  | { raw: { code: number; parameters: unknown[] } };

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
  switch?: number;
  is?: boolean;
  variable?: number;
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

const SayPayloadSchema: z.ZodType<SayPayload> = z.object({
  text: z.union([z.string(), z.array(z.string())]),
  speaker: z.string().optional(),
  face: z.string().optional(),
  background: z.number().int().optional(),
  position: z.number().int().optional(),
});

const IfPayloadSchema: z.ZodType<IfPayload> = z.lazy(() =>
  z.object({
    switch: z.number().int().optional(),
    is: z.boolean().optional(),
    variable: z.number().int().optional(),
    cmp: z.enum(['eq', 'gte', 'lte', 'gt', 'lt', 'neq']).optional(),
    value: z.number().optional(),
    script: z.string().optional(),
    raw: z.array(z.unknown()).optional(),
    then: stepArray(),
    else: stepArray().optional(),
  })
);

const ChoicePayloadSchema: z.ZodType<ChoicePayload> = z.lazy(() =>
  z.object({
    cancelType: z.number().int().optional(),
    defaultType: z.number().int().optional(),
    positionType: z.number().int().optional(),
    background: z.number().int().optional(),
    branches: z.record(z.string(), stepArray()),
    cancel: stepArray().optional(),
  })
);

export const StepSchema: z.ZodType<Step> = z.lazy(() =>
  z.union([
    z.object({ say: z.union([z.string(), SayPayloadSchema]) }).strict(),
    z.object({ comment: z.union([z.string(), z.array(z.string())]) }).strict(),
    z.object({ if: IfPayloadSchema }).strict(),
    z.object({ choice: ChoicePayloadSchema }).strict(),
    z.object({ loop: z.object({ body: stepArray() }) }).strict(),
    z
      .object({ setSwitch: z.object({ from: z.number().int(), to: z.number().int().optional(), value: z.boolean() }) })
      .strict(),
    z
      .object({
        setVariable: z.object({
          from: z.number().int(),
          to: z.number().int().optional(),
          op: z.enum(['set', 'add', 'sub', 'mul', 'div', 'mod']).optional(),
          value: z.number(),
        }),
      })
      .strict(),
    z.object({ setSelfSwitch: z.object({ ch: z.enum(['A', 'B', 'C', 'D']), value: z.boolean() }) }).strict(),
    z.object({ callCommonEvent: z.number().int() }).strict(),
    z
      .object({
        transfer: z.object({
          mapId: z.number().int(),
          x: z.number().int(),
          y: z.number().int(),
          direction: z.number().int().optional(),
          fade: z.number().int().optional(),
        }),
      })
      .strict(),
    z.object({ wait: z.number().int().nonnegative() }).strict(),
    z
      .object({
        playSe: z.object({
          name: z.string(),
          volume: z.number().optional(),
          pitch: z.number().optional(),
          pan: z.number().optional(),
        }),
      })
      .strict(),
    z.object({ raw: z.object({ code: z.number().int(), parameters: z.array(z.unknown()) }) }).strict(),
  ])
);

export const StepListSchema = z.array(StepSchema);
