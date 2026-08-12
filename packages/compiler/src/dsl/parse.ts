import { parse as parseYaml } from 'yaml';
import { MOVE_ROUTE_CODES, SIMPLE_COMMANDS, SIMPLE_KINDS, type Condition, type MoveStep, type Node } from '../ir.js';
import {
  BattlePayload,
  ChoicePayload,
  IfPayload,
  MoveRoutePayload,
  MoveStepSpec,
  SayPayload,
  ShopPayload,
  Step,
  StepListSchema,
} from './schema.js';

/** Parses a YAML DSL document (plan §4.2) into IR nodes ready for emit.ts's compile(). */
export function parseDsl(yamlText: string): Node[] {
  const raw = parseYaml(yamlText) ?? [];
  const steps = StepListSchema.parse(raw);
  return steps.map(stepToNode);
}

export function stepToNode(step: Step): Node {
  if ('say' in step) return sayToNode(step.say);
  if ('comment' in step) return { kind: 'comment', lines: toLines(step.comment) };
  if ('if' in step) return ifToNode(step.if);
  if ('choice' in step) return choiceToNode(step.choice);
  if ('loop' in step) return { kind: 'loop', body: step.loop.body.map(stepToNode) };
  if ('setSwitch' in step) {
    const { from, to, value } = step.setSwitch;
    return { kind: 'setSwitch', from, to: to ?? from, value };
  }
  if ('setVariable' in step) {
    const { from, to, op, value } = step.setVariable;
    return { kind: 'setVariable', from, to: to ?? from, op: op ?? 'set', value };
  }
  if ('setSelfSwitch' in step) return { kind: 'setSelfSwitch', ...step.setSelfSwitch };
  if ('callCommonEvent' in step) return { kind: 'callCommonEvent', commonEventId: step.callCommonEvent };
  if ('transfer' in step) {
    const { mapId, x, y, direction, fade } = step.transfer;
    return { kind: 'transfer', mapId, x, y, direction: direction ?? 2, fadeType: fade ?? 0 };
  }
  if ('wait' in step) return { kind: 'wait', frames: step.wait };
  if ('playSe' in step) {
    const { name, volume, pitch, pan } = step.playSe;
    return { kind: 'playSe', name, volume: volume ?? 90, pitch: pitch ?? 100, pan: pan ?? 0 };
  }
  if ('raw' in step) {
    return {
      kind: 'raw',
      code: step.raw.code,
      parameters: step.raw.parameters,
      body: step.raw.body?.map(stepToNode),
    };
  }
  if ('moveRoute' in step) return moveRouteToNode(step.moveRoute);
  if ('playBgm' in step) {
    const { name, volume, pitch, pan } = step.playBgm;
    return { kind: 'playBgm', name, volume: volume ?? 90, pitch: pitch ?? 100, pan: pan ?? 0 };
  }
  if ('battle' in step) return battleToNode(step.battle);
  if ('shop' in step) return shopToNode(step.shop);
  if ('script' in step) return { kind: 'script', lines: toLines(step.script) };
  if ('pluginCommand' in step) {
    const { plugin, command, label, args } = step.pluginCommand;
    return { kind: 'pluginCommand', plugin, command, label, args: args ?? {} };
  }
  const simple = simpleToNode(step);
  if (simple) return simple;
  throw new Error(`Unrecognized DSL step: ${JSON.stringify(step)}`);
}

/** Fills in ir.ts's table defaults for every field the author left out (or for `- fadeOut:`, which YAML hands us as `null`). */
function simpleToNode(step: Step): Node | undefined {
  const kind = SIMPLE_KINDS.find((k) => k in step);
  if (!kind) return undefined;
  const payload = (step as Record<string, Record<string, unknown> | null>)[kind] ?? {};
  return { kind, ...SIMPLE_COMMANDS[kind].fields, ...payload } as unknown as Node;
}

function moveRouteToNode(payload: MoveRoutePayload): Node {
  return {
    kind: 'moveRoute',
    characterId: payload.characterId ?? 0,
    repeat: payload.repeat ?? false,
    skippable: payload.skippable ?? false,
    wait: payload.wait ?? false,
    route: payload.route.map(moveStep),
  };
}

/** Exported because `upsert_map_event` writes a page's autonomous route and must accept the same step names as the DSL does. */
export function moveStep(spec: MoveStepSpec): MoveStep {
  if (typeof spec === 'string') return { code: routeCode(spec) };
  const code = typeof spec.step === 'number' ? spec.step : routeCode(spec.step);
  return spec.parameters ? { code, parameters: spec.parameters } : { code };
}

function routeCode(name: string): number {
  const code = (MOVE_ROUTE_CODES as Record<string, number>)[name];
  // A typo'd route step is otherwise a NaN code, i.e. a move route the game
  // silently skips — the same failure mode say.face's index check exists for.
  if (code === undefined) {
    throw new Error(`Unknown move route step ${JSON.stringify(name)}. Known steps: ${Object.keys(MOVE_ROUTE_CODES).join(', ')}`);
  }
  return code;
}

function battleToNode(payload: BattlePayload): Node {
  return {
    kind: 'battle',
    designation: payload.designation ?? 0,
    troopId: payload.troopId ?? 1,
    canEscape: payload.canEscape ?? false,
    canLose: payload.canLose ?? false,
    win: payload.win?.map(stepToNode),
    escape: payload.escape?.map(stepToNode),
    lose: payload.lose?.map(stepToNode),
  };
}

function shopToNode(payload: ShopPayload): Node {
  return {
    kind: 'shop',
    goods: payload.goods.map((good) => ({
      type: good.type ?? 0,
      id: good.id,
      priceType: good.priceType ?? 0,
      price: good.price ?? 0,
    })),
    purchaseOnly: payload.purchaseOnly ?? false,
  };
}

function sayToNode(say: string | SayPayload): Node {
  const payload: SayPayload = typeof say === 'string' ? { text: say } : say;
  let face = '';
  let faceIndex = 0;
  if (payload.face) {
    const [name, idx] = payload.face.split('/');
    face = name;
    if (idx !== undefined) {
      // Without this check a typo'd index becomes NaN, and NaN survives
      // JSON.stringify as `null` — i.e. a silently corrupt faceIndex written
      // into data/*.json rather than a rejected document.
      faceIndex = Number(idx);
      if (!Number.isInteger(faceIndex) || faceIndex < 0) {
        throw new Error(`say.face expects "FileName/Index" with a non-negative integer index, got ${JSON.stringify(payload.face)}`);
      }
    }
  }
  return {
    kind: 'text',
    face,
    faceIndex,
    background: payload.background ?? 0,
    position: payload.position ?? 2,
    speakerName: payload.speaker,
    lines: toLines(payload.text),
  };
}

function ifToNode(payload: IfPayload): Node {
  const condition = ifConditionOf(payload);
  return { kind: 'if', condition, then: payload.then.map(stepToNode), else: payload.else?.map(stepToNode) };
}

function ifConditionOf(payload: IfPayload): Condition {
  if (payload.switch !== undefined) return { type: 'switch', switchId: payload.switch, value: payload.is ?? true };
  if (payload.variable !== undefined) {
    return { type: 'variable', variableId: payload.variable, cmp: payload.cmp ?? 'eq', value: payload.value ?? 0 };
  }
  if (payload.script !== undefined) return { type: 'script', code: payload.script };
  if (payload.raw !== undefined) return { type: 'raw', parameters: payload.raw };
  throw new Error('if: needs one of switch, variable, script, or raw');
}

function choiceToNode(payload: ChoicePayload): Node {
  const labels = Object.keys(payload.branches);
  // `branches` is a mapping, and JS object key order is only insertion order
  // for non-integer-like keys: `{ "10": …, "5": … }` enumerates as 5, 10, so a
  // menu written with numeric labels would silently come out reordered. Menu
  // order is meaningful (it is also the 402 branch index), so reject rather
  // than reorder — a label like "1." or "１" is unaffected.
  const numericLabel = labels.find((label) => /^(0|[1-9]\d*)$/.test(label));
  if (numericLabel !== undefined) {
    throw new Error(
      `choice branch labels must not be plain non-negative integers (got ${JSON.stringify(numericLabel)}); ` +
        'YAML mapping order is not preserved for them. Add any non-digit character to the label.'
    );
  }
  return {
    kind: 'choice',
    choices: labels,
    // -1 = cancel disallowed, -2 = cancel allowed and runs the "When Cancel"
    // (403) body. Defaulting to -2 with no `cancel:` would let the player
    // dismiss the menu and skip every branch, which is never what an author
    // who omitted the key meant.
    cancelType: payload.cancelType ?? (payload.cancel ? -2 : -1),
    defaultType: payload.defaultType ?? -1,
    positionType: payload.positionType ?? 2,
    background: payload.background ?? 0,
    branches: labels.map((label) => payload.branches[label].map(stepToNode)),
    cancelBranch: payload.cancel?.map(stepToNode),
  };
}

function toLines(text: string | string[]): string[] {
  return Array.isArray(text) ? text : text.split('\n');
}
