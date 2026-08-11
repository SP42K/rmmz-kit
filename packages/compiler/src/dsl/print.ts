import { stringify } from 'yaml';
import type { Condition, Node } from '../ir.js';
import { IfPayload, SayPayload, Step } from './schema.js';

/** Inverse of parse.ts: turns decompiled IR back into the YAML DSL, so an LLM can read an existing event (plan §3 M3). */
export function printDsl(nodes: Node[]): string {
  return stringify(nodes.map(nodeToStep));
}

function nodeToStep(node: Node): Step {
  switch (node.kind) {
    case 'raw':
      return {
        raw: { code: node.code, parameters: node.parameters, body: node.body?.map(nodeToStep) },
      };

    case 'text': {
      const say: SayPayload = { text: node.lines.length === 1 ? node.lines[0] : node.lines };
      if (node.speakerName !== undefined) say.speaker = node.speakerName;
      if (node.face) say.face = node.faceIndex ? `${node.face}/${node.faceIndex}` : node.face;
      if (node.background !== 0) say.background = node.background;
      if (node.position !== 2) say.position = node.position;
      return { say };
    }

    case 'comment':
      return { comment: node.lines.length === 1 ? node.lines[0] : node.lines };

    case 'if': {
      const condition = conditionToPayload(node.condition);
      const payload: IfPayload = { ...condition, then: node.then.map(nodeToStep) };
      if (node.else) payload.else = node.else.map(nodeToStep);
      return { if: payload };
    }

    case 'choice': {
      const branches: Record<string, Step[]> = {};
      node.choices.forEach((label, i) => {
        // MZ allows two choices to share a label; the DSL keys branches by
        // label, so writing both would drop a choice *and* its body. Refuse
        // loudly — printDsl is used to show an agent an existing event, and
        // handing back a quietly shortened menu is worse than not printing.
        if (label in branches) {
          throw new Error(
            `Show Choices has duplicate label ${JSON.stringify(label)}; the YAML DSL keys branches by label and cannot represent it`
          );
        }
        branches[label] = node.branches[i].map(nodeToStep);
      });
      return {
        choice: {
          cancelType: node.cancelType,
          defaultType: node.defaultType,
          positionType: node.positionType,
          background: node.background,
          branches,
          cancel: node.cancelBranch?.map(nodeToStep),
        },
      };
    }

    case 'loop':
      return { loop: { body: node.body.map(nodeToStep) } };

    case 'setSwitch':
      return { setSwitch: { from: node.from, to: node.to, value: node.value } };

    case 'setVariable':
      return { setVariable: { from: node.from, to: node.to, op: node.op, value: node.value } };

    case 'setSelfSwitch':
      return { setSelfSwitch: { ch: node.ch, value: node.value } };

    case 'callCommonEvent':
      return { callCommonEvent: node.commonEventId };

    case 'transfer':
      return { transfer: { mapId: node.mapId, x: node.x, y: node.y, direction: node.direction, fade: node.fadeType } };

    case 'wait':
      return { wait: node.frames };

    case 'playSe':
      return { playSe: { name: node.name, volume: node.volume, pitch: node.pitch, pan: node.pan } };
  }
}

function conditionToPayload(condition: Condition): Pick<IfPayload, 'switch' | 'is' | 'variable' | 'cmp' | 'value' | 'script' | 'raw'> {
  switch (condition.type) {
    case 'switch':
      return { switch: condition.switchId, is: condition.value };
    case 'variable':
      return { variable: condition.variableId, cmp: condition.cmp, value: condition.value };
    case 'script':
      return { script: condition.code };
    case 'raw':
      return { raw: condition.parameters };
  }
}
