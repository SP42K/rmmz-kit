/**
 * L2 intermediate representation: a tree over event commands. `indent` is
 * never stored on a node — emit.ts derives it from tree depth, decompile.ts
 * derives the tree from `indent` — so the two are structurally incapable of
 * disagreeing with each other the way hand-maintained indent counters would.
 *
 * Tier 1 and Tier 2 command codes (plan §4.3) get a dedicated, friendly node so
 * the DSL layer and decompiled output stay readable. Everything else (Tier 3, or
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
  | PlaySeNode
  // Tier 2 (M7.5).
  | SimpleNode
  | MoveRouteNode
  | PlayBgmNode
  | BattleNode
  | ShopNode
  | ScriptNode
  | PluginCommandNode;

/** Passthrough for any single command this compiler doesn't model semantically (code 0/411/412/402/403/404/413 excluded — those are structural and never appear as a bare RawNode). */
export interface RawNode {
  kind: 'raw';
  code: number;
  parameters: unknown[];
  /**
   * Commands nested one indent level under this one. Present only for
   * *unmodeled* structural commands: MZ indents a branch body by one exactly
   * like 111/411/412, but this compiler only has typed nodes for the shapes it
   * models. Battle Processing (301/601–604) was the motivating case and is
   * typed as of M7.5; the field stays because Tier 3 has more of them (vehicle
   * and enemy-command branches), and without it decompile would have to throw
   * on such a list — breaking the "decompiling an arbitrary project never fails
   * and never loses data" guarantee. Nesting is the only thing modeled here:
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

/** Play BGM (241). Same audio object shape as Play SE. */
export interface PlayBgmNode {
  kind: 'playBgm';
  name: string;
  volume: number;
  pitch: number;
  pan: number;
}

/**
 * Tier 2 commands whose whole payload is a flat, positional list of scalars
 * (plan §4.3). One table entry replaces what would otherwise be, per command,
 * an interface + an emit case + a decompile case + a Zod member + a parse and a
 * print branch — six places to get the same parameter *order* right, which is
 * the only thing any of them actually encode. emit/decompile/schema/parse/print
 * all read this table instead, so a wrong index is impossible to introduce in
 * only half of them.
 *
 * The values are the defaults used when real data has a shorter array than MZ's
 * current one (older projects), and their *types* are what the DSL schema is
 * generated from. The parameter order below is `Game_Interpreter`'s, not a
 * guess — anything with a shape this flat model can't hold (movement routes,
 * battle/shop branches, script and plugin commands) is a hand-written node.
 *
 * MZ enum conventions repeated across these:
 * - `operation`: 0 = increase / add / learn, 1 = decrease / remove / forget.
 * - `operandType`: 0 = `value` is the constant, 1 = `value` is a variable id.
 * - `actorType`: 0 = `actorId` is fixed, 1 = `actorId` is a variable id.
 * - `characterId`: -1 = player, 0 = this event, >0 = that event id.
 */
export const SIMPLE_COMMANDS = {
  breakLoop: { code: 113, fields: {} },
  exitEvent: { code: 115, fields: {} },
  label: { code: 118, fields: { name: '' } },
  jump: { code: 119, fields: { name: '' } },
  gainGold: { code: 125, fields: { operation: 0, operandType: 0, value: 0 } },
  gainItem: { code: 126, fields: { itemId: 1, operation: 0, operandType: 0, value: 1 } },
  gainWeapon: { code: 127, fields: { weaponId: 1, operation: 0, operandType: 0, value: 1, includeEquip: false } },
  gainArmor: { code: 128, fields: { armorId: 1, operation: 0, operandType: 0, value: 1, includeEquip: false } },
  changeParty: { code: 129, fields: { actorId: 1, operation: 0, initialize: false } },
  showAnimation: { code: 212, fields: { characterId: 0, animationId: 1, wait: false } },
  balloon: { code: 213, fields: { characterId: 0, balloonId: 1, wait: false } },
  fadeOut: { code: 221, fields: {} },
  fadeIn: { code: 222, fields: {} },
  fadeOutBgm: { code: 242, fields: { duration: 10 } },
  changeHp: { code: 311, fields: { actorType: 0, actorId: 1, operation: 0, operandType: 0, value: 0, allowDeath: false } },
  changeMp: { code: 312, fields: { actorType: 0, actorId: 1, operation: 0, operandType: 0, value: 0 } },
  changeState: { code: 313, fields: { actorType: 0, actorId: 1, operation: 0, stateId: 1 } },
  recoverAll: { code: 314, fields: { actorType: 0, actorId: 1 } },
  changeExp: { code: 315, fields: { actorType: 0, actorId: 1, operation: 0, operandType: 0, value: 0, showLevelUp: false } },
  changeLevel: { code: 316, fields: { actorType: 0, actorId: 1, operation: 0, operandType: 0, value: 0, showLevelUp: false } },
  changeParameter: { code: 317, fields: { actorType: 0, actorId: 1, paramId: 0, operation: 0, operandType: 0, value: 0 } },
  changeSkill: { code: 318, fields: { actorType: 0, actorId: 1, operation: 0, skillId: 1 } },
} as const;

/** `as const` pins every default to a literal type (`0`, `''`, `false`); the node/DSL field types want the base type. */
type Widen<T> = T extends number ? number : T extends string ? string : T extends boolean ? boolean : never;

export type SimpleKind = keyof typeof SIMPLE_COMMANDS;
type FieldsOf<K extends SimpleKind> = (typeof SIMPLE_COMMANDS)[K]['fields'];

/** One node type per SIMPLE_COMMANDS entry, fields and all — derived, so the table stays the single source of truth. */
export type SimpleNode = {
  [K in SimpleKind]: { kind: K } & { -readonly [F in keyof FieldsOf<K>]: Widen<FieldsOf<K>[F]> };
}[SimpleKind];

/** The same fields, all optional: what the DSL accepts (anything omitted takes the table's default). */
export type SimpleFields<K extends SimpleKind> = { -readonly [F in keyof FieldsOf<K>]?: Widen<FieldsOf<K>[F]> };

export const SIMPLE_KINDS = Object.keys(SIMPLE_COMMANDS) as SimpleKind[];

/**
 * `Game_Character`'s ROUTE_* constants. Named here for the same reason plan
 * §4.5 makes the asset catalog a resource: a model that must write `code: 2`
 * for "move left" gets it wrong, one that writes `moveLeft` cannot.
 */
export const MOVE_ROUTE_CODES = {
  end: 0,
  moveDown: 1,
  moveLeft: 2,
  moveRight: 3,
  moveUp: 4,
  moveLowerLeft: 5,
  moveLowerRight: 6,
  moveUpperLeft: 7,
  moveUpperRight: 8,
  moveRandom: 9,
  moveToward: 10,
  moveAway: 11,
  moveForward: 12,
  moveBackward: 13,
  jump: 14,
  wait: 15,
  turnDown: 16,
  turnLeft: 17,
  turnRight: 18,
  turnUp: 19,
  turn90dRight: 20,
  turn90dLeft: 21,
  turn180d: 22,
  turn90dRightOrLeft: 23,
  turnRandom: 24,
  turnToward: 25,
  turnAway: 26,
  switchOn: 27,
  switchOff: 28,
  changeSpeed: 29,
  changeFrequency: 30,
  walkAnimeOn: 31,
  walkAnimeOff: 32,
  stepAnimeOn: 33,
  stepAnimeOff: 34,
  directionFixOn: 35,
  directionFixOff: 36,
  throughOn: 37,
  throughOff: 38,
  transparentOn: 39,
  transparentOff: 40,
  changeImage: 41,
  changeOpacity: 42,
  changeBlendMode: 43,
  playSe: 44,
  script: 45,
} as const;

export interface MoveStep {
  code: number;
  parameters?: unknown[];
}

/**
 * Set Movement Route (205). MZ writes the route twice: once as the 205's own
 * second parameter (the only copy `Game_Interpreter` reads) and once as one
 * `{code:505}` command per route step, which the interpreter no-ops and the
 * editor uses to render the route inline. emit writes both; decompile takes
 * the 205's copy and drops the 505 mirror.
 */
export interface MoveRouteNode {
  kind: 'moveRoute';
  /** -1 = player, 0 = this event, >0 = that event id. */
  characterId: number;
  repeat: boolean;
  skippable: boolean;
  wait: boolean;
  /** Without the trailing ROUTE_END (code 0) — emit appends it, exactly as compile() appends the command list's own terminator. */
  route: MoveStep[];
}

/**
 * Battle Processing (301) with its If Win / If Escape / If Lose bodies
 * (601/602/603, closed by 604). An absent branch means MZ wrote no 60x at all
 * (escape/lose bodies only exist when `canEscape`/`canLose`); an empty array
 * means the branch exists and does nothing — the same distinction `IfNode.else`
 * makes. Unlike Show Choices, no trailing `{code:0}` filler is emitted inside a
 * branch (an R1-class assumption, plan §6: this repo has no editor-written 301
 * to copy) — decompile accepts one either way.
 */
export interface BattleNode {
  kind: 'battle';
  /** 0 = `troopId` is the troop, 1 = `troopId` is a variable holding it, 2 = the map's random encounter. */
  designation: number;
  troopId: number;
  canEscape: boolean;
  canLose: boolean;
  win?: Node[];
  escape?: Node[];
  lose?: Node[];
}

/** One line of a shop's stock. `price` is only read when `priceType` is 1 (specify); 0 means "the item's own price". */
export interface ShopGood {
  /** 0 = item, 1 = weapon, 2 = armor. */
  type: number;
  id: number;
  priceType: number;
  price: number;
}

/** Shop Processing (302). The first good rides on the 302 itself, the rest are 605 rows — `Game_Interpreter.command302` reassembles them the same way. */
export interface ShopNode {
  kind: 'shop';
  goods: ShopGood[];
  purchaseOnly: boolean;
}

/** Script (355) + its continuation lines (655), joined with newlines at runtime. Same shape as a Comment block. */
export interface ScriptNode {
  kind: 'script';
  lines: string[];
}

/**
 * Plugin Command (357), MZ's structured form — plan §4.3 calls this out as the
 * right interface to hand an AI, since it is a plugin name + command key +
 * named arguments rather than MV's free text (356).
 */
export interface PluginCommandNode {
  kind: 'pluginCommand';
  /** The plugin's js filename without `.js`, as listed in js/plugins.js. */
  plugin: string;
  command: string;
  /** MZ's third parameter: what the editor shows in the event list. Defaults to `command` when omitted. */
  label?: string;
  /** The editor writes every argument value as a string; plugins parse them themselves. */
  args: Record<string, unknown>;
}
