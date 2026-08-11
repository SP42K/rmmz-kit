import { parse as parseYaml } from 'yaml';
import type { Condition, Node } from '../ir.js';
import { ChoicePayload, IfPayload, SayPayload, Step, StepListSchema } from './schema.js';

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
  throw new Error(`Unrecognized DSL step: ${JSON.stringify(step)}`);
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
