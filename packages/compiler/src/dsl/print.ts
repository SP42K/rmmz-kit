import { stringify } from 'yaml';
import { MOVE_ROUTE_CODES, SIMPLE_COMMANDS, type Condition, type MoveStep, type Node } from '../ir.js';
import { IfPayload, MoveStepSpec, SayPayload, Step } from './schema.js';

/** Reverse of MOVE_ROUTE_CODES, so a printed route reads `moveLeft` rather than `2`. */
const ROUTE_NAMES = new Map<number, string>(Object.entries(MOVE_ROUTE_CODES).map(([name, code]) => [code, name]));

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

    case 'playBgm':
      return { playBgm: { name: node.name, volume: node.volume, pitch: node.pitch, pan: node.pan } };

    case 'moveRoute':
      return {
        moveRoute: {
          characterId: node.characterId,
          repeat: node.repeat,
          skippable: node.skippable,
          wait: node.wait,
          route: node.route.map(routeStepToSpec),
        },
      };

    case 'battle':
      return {
        battle: {
          designation: node.designation,
          troopId: node.troopId,
          canEscape: node.canEscape,
          canLose: node.canLose,
          win: node.win?.map(nodeToStep),
          escape: node.escape?.map(nodeToStep),
          lose: node.lose?.map(nodeToStep),
        },
      };

    case 'shop':
      return { shop: { goods: node.goods.map((good) => ({ ...good })), purchaseOnly: node.purchaseOnly } };

    case 'script':
      return { script: node.lines.length === 1 ? node.lines[0] : node.lines };

    case 'pluginCommand':
      return {
        pluginCommand: { plugin: node.plugin, command: node.command, label: node.label, args: node.args },
      };

    default: {
      // Flat-parameter Tier 2 command: the node's own fields are the payload,
      // minus the discriminant. Printed in full (not diffed against the table's
      // defaults) so the YAML shows what the event actually does.
      const { kind, ...fields } = node;
      if (!SIMPLE_COMMANDS[kind]) throw new Error(`Cannot print unknown node kind: ${JSON.stringify(kind)}`);
      return { [kind]: fields } as Step;
    }
  }
}

function routeStepToSpec(step: MoveStep): MoveStepSpec {
  const name = ROUTE_NAMES.get(step.code);
  if (name && step.parameters === undefined) return name;
  return { step: name ?? step.code, ...(step.parameters ? { parameters: step.parameters } : {}) };
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
