import type { EventCommand } from '@rmmz-kit/core';
import type { CompareOp, Condition, Node } from './ir.js';

const COMPARE_CODES: Record<CompareOp, number> = {
  eq: 0,
  gte: 1,
  lte: 2,
  gt: 3,
  lt: 4,
  neq: 5,
};

const VARIABLE_OPS: Record<'set' | 'add' | 'sub' | 'mul' | 'div' | 'mod', number> = {
  set: 0,
  add: 1,
  sub: 2,
  mul: 3,
  div: 4,
  mod: 5,
};

/** Compiles a page/common-event's full command list, including the trailing terminator. */
export function compile(nodes: Node[]): EventCommand[] {
  const out: EventCommand[] = [];
  emitList(nodes, 0, out);
  out.push({ code: 0, indent: 0, parameters: [] });
  return out;
}

function emitList(nodes: Node[], indent: number, out: EventCommand[]): void {
  for (const node of nodes) emitNode(node, indent, out);
}

function emitNode(node: Node, indent: number, out: EventCommand[]): void {
  switch (node.kind) {
    case 'raw':
      out.push({ code: node.code, indent, parameters: node.parameters });
      return;

    case 'text': {
      const head = node.speakerName === undefined
        ? [node.face, node.faceIndex, node.background, node.position]
        : [node.face, node.faceIndex, node.background, node.position, node.speakerName];
      out.push({ code: 101, indent, parameters: head });
      for (const line of node.lines) out.push({ code: 401, indent, parameters: [line] });
      return;
    }

    case 'comment': {
      const lines = node.lines.length > 0 ? node.lines : [''];
      lines.forEach((line, i) => out.push({ code: i === 0 ? 108 : 408, indent, parameters: [line] }));
      return;
    }

    case 'if': {
      out.push({ code: 111, indent, parameters: conditionParams(node.condition) });
      emitList(node.then, indent + 1, out);
      if (node.else) {
        out.push({ code: 411, indent, parameters: [] });
        emitList(node.else, indent + 1, out);
      }
      out.push({ code: 412, indent, parameters: [] });
      return;
    }

    case 'choice': {
      out.push({
        code: 102,
        indent,
        parameters: [node.choices, node.cancelType, node.defaultType, node.positionType, node.background],
      });
      node.branches.forEach((body, i) => {
        out.push({ code: 402, indent, parameters: [i, node.choices[i]] });
        emitList(body, indent + 1, out);
        out.push({ code: 0, indent: indent + 1, parameters: [] });
      });
      if (node.cancelBranch !== undefined) {
        out.push({ code: 403, indent, parameters: [] });
        emitList(node.cancelBranch, indent + 1, out);
        out.push({ code: 0, indent: indent + 1, parameters: [] });
      }
      out.push({ code: 404, indent, parameters: [] });
      return;
    }

    case 'loop': {
      out.push({ code: 112, indent, parameters: [] });
      emitList(node.body, indent + 1, out);
      out.push({ code: 413, indent, parameters: [] });
      return;
    }

    case 'setSwitch':
      out.push({ code: 121, indent, parameters: [node.from, node.to, node.value ? 0 : 1] });
      return;

    case 'setVariable':
      out.push({ code: 122, indent, parameters: [node.from, node.to, VARIABLE_OPS[node.op], 0, node.value] });
      return;

    case 'setSelfSwitch':
      out.push({ code: 123, indent, parameters: [node.ch, node.value ? 0 : 1] });
      return;

    case 'callCommonEvent':
      out.push({ code: 117, indent, parameters: [node.commonEventId] });
      return;

    case 'transfer':
      out.push({
        code: 201,
        indent,
        parameters: [0, node.mapId, node.x, node.y, node.direction, node.fadeType],
      });
      return;

    case 'wait':
      out.push({ code: 230, indent, parameters: [node.frames] });
      return;

    case 'playSe':
      out.push({
        code: 250,
        indent,
        parameters: [{ name: node.name, volume: node.volume, pitch: node.pitch, pan: node.pan }],
      });
      return;
  }
}

function conditionParams(condition: Condition): unknown[] {
  switch (condition.type) {
    case 'switch':
      return [0, condition.switchId, condition.value ? 0 : 1];
    case 'variable':
      return [1, condition.variableId, 0, condition.value, COMPARE_CODES[condition.cmp]];
    case 'script':
      return [12, condition.code];
    case 'raw':
      return condition.parameters;
  }
}
