/**
 * L2 intermediate representation: a tree over event commands. `indent` is
 * never stored on a node — emit.ts derives it from tree depth, decompile.ts
 * derives the tree from `indent` — so the two are structurally incapable of
 * disagreeing with each other the way hand-maintained indent counters would.
 *
 * Tier 1 command codes (plan §4.3) get a dedicated, friendly node so the DSL
 * layer and decompiled output stay readable. Everything else (Tier 2/3, or
 * any code this compiler doesn't know) round-trips through `RawNode`, which
 * carries a single command's code+parameters verbatim — so decompiling an
 * arbitrary existing project can never lose data, even for constructs this
 * compiler has no opinion about.
 */

export type Node =
  | RawNode
  | TextNode
  | CommentNode
  | IfNode
  | ChoiceNode
  | LoopNode
  | SetSwitchNode
  | SetVariableNode
  | SetSelfSwitchNode
  | CallCommonEventNode
  | TransferNode
  | WaitNode
  | PlaySeNode;

/** Passthrough for any single command this compiler doesn't model semantically (code 0/411/412/402/403/404/413 excluded — those are structural and never appear as a bare RawNode). */
export interface RawNode {
  kind: 'raw';
  code: number;
  parameters: unknown[];
  /**
   * Commands nested one indent level under this one. Present only for
   * *unmodeled* structural commands — Battle Processing's 301/601/602/603/604
   * being the common real-world case: MZ indents each If Win/If Escape/If Lose
   * body by one, exactly like 111/411/412, but this compiler has no typed node
   * for it. Without this field decompile would have to throw on such a list,
   * which would break the "decompiling an arbitrary project never fails and
   * never loses data" guarantee. Nesting is the only thing modeled here — the
   * grouping of 601/603 under their 301 is not, and doesn't need to be, since
   * emit re-derives indent from depth the same way MZ wrote it.
   */
  body?: Node[];
}

/** Show Text (101) + its Show Text continuation lines (401). */
export interface TextNode {
  kind: 'text';
  face: string;
  faceIndex: number;
  /** 0 = window, 1 = dim, 2 = transparent */
  background: number;
  /** 0 = top, 1 = middle, 2 = bottom */
  position: number;
  /** MZ-only 5th param (absent in MV). Undefined omits it, matching a 4-element parameters array. */
  speakerName?: string;
  lines: string[];
}

/** Comment (108) + continuation lines (408). */
export interface CommentNode {
  kind: 'comment';
  lines: string[];
}

/**
 * Conditional Branch (111/411/412). Only switch/variable-vs-constant/script
 * conditions get a typed shape (§4.3's common cases); anything else
 * (variable-vs-variable, actor/enemy/character/gold/item/... conditions)
 * still compiles, just via `RawCondition`, which stores the 111 parameter
 * array verbatim — full Conditional Branch support without modeling all ~15
 * condition types up front.
 */
export interface IfNode {
  kind: 'if';
  condition: Condition;
  then: Node[];
  else?: Node[];
}

export type Condition =
  | { type: 'switch'; switchId: number; value: boolean }
  | { type: 'variable'; variableId: number; cmp: CompareOp; value: number }
  | { type: 'script'; code: string }
  | { type: 'raw'; parameters: unknown[] };

/** MZ's Control Variables / Conditional Branch operand comparators: 0 = equal ... 5 = greater-or-equal. */
export type CompareOp = 'eq' | 'gte' | 'lte' | 'gt' | 'lt' | 'neq';

/**
 * Show Choices (102/402/403/404). Each choice branch always ends with an
 * explicit `{code:0}` filler at its own indent, mirroring the only ground
 * truth this repo has (fixtures/minimal-project's empty choice branches) —
 * an R1-style assumption (see docs/rmmz-automation-implementation-plan.md
 * §6 R1): decompile accepts the filler being absent, emit always adds it.
 */
export interface ChoiceNode {
  kind: 'choice';
  choices: string[];
  /**
   * -1 = cancel disallowed entirely (`Window_ChoiceList.isCancelEnabled` is
   * `choiceCancelType() !== -1`); -2 = cancel allowed and selects no branch,
   * which is what routes to a `{code:403}` "When Canceled" body; >=0 = cancel
   * behaves as choosing that index. The editor writes `choices.length` for
   * "Branch" and `Game_Interpreter.setupChoices` normalizes anything >= length
   * to -2, so -2 and `choices.length` are equivalent on disk.
   *
   * A 403 branch's *presence* is tracked separately via `cancelBranch` rather
   * than derived from this value: a project can legitimately carry a 403 that
   * the current cancelType makes unreachable, and decompiling must not silently
   * drop it.
   */
  cancelType: number;
  /** -1 = no default selection. */
  defaultType: number;
  /** 0 = left/window, 1 = center, 2 = right (MZ's usual default). */
  positionType: number;
  /** 0 = window, 1 = dim, 2 = transparent. */
  background: number;
  /** One body per entry in `choices`, same order. */
  branches: Node[][];
  /** Present only if the command list actually has a 403 "When Canceled" branch. */
  cancelBranch?: Node[];
}

/** Loop (112) ... Repeat Above (413). A Break Loop (113) inside the body is just a RawNode. */
export interface LoopNode {
  kind: 'loop';
  body: Node[];
}

/** Control Switches (121), constant-range form (the only form 121 has). */
export interface SetSwitchNode {
  kind: 'setSwitch';
  from: number;
  to: number;
  value: boolean;
}

/**
 * Control Variables (122), constant-operand form only (operand type 0).
 * Variable/random/game-data/script operands fall back to decompiling as
 * RawNode — see decompile.ts.
 */
export interface SetVariableNode {
  kind: 'setVariable';
  from: number;
  to: number;
  op: 'set' | 'add' | 'sub' | 'mul' | 'div' | 'mod';
  value: number;
}

/** Control Self Switch (123). */
export interface SetSelfSwitchNode {
  kind: 'setSelfSwitch';
  ch: 'A' | 'B' | 'C' | 'D';
  value: boolean;
}

/** Common Event (117). */
export interface CallCommonEventNode {
  kind: 'callCommonEvent';
  commonEventId: number;
}

/** Transfer Player (201), direct-designation form (designation 0). Variable-designation falls back to RawNode. */
export interface TransferNode {
  kind: 'transfer';
  mapId: number;
  x: number;
  y: number;
  direction: number;
  fadeType: number;
}

/** Wait (230), in frames. */
export interface WaitNode {
  kind: 'wait';
  frames: number;
}

/** Play SE (250). */
export interface PlaySeNode {
  kind: 'playSe';
  name: string;
  volume: number;
  pitch: number;
  pan: number;
}
