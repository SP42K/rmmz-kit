import type { EventCommand, MoveRoute } from '@rmmz-kit/core';
import { SIMPLE_COMMANDS, type CompareOp, type Condition, type MoveStep, type Node } from './ir.js';

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
      // Copy: the parameters array on a decompiled node aliases the array in
      // the caller's parsed project JSON, and the emitted list must not stay
      // wired to it (mutating one would silently mutate the other).
      out.push({ code: node.code, indent, parameters: [...node.parameters] });
      if (node.body) emitList(node.body, indent + 1, out);
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
      // A mismatch would emit `{code:402, parameters:[i, undefined]}`, and
      // `undefined` inside an array survives JSON.stringify as `null` — i.e. a
      // corrupt label written to disk that this compiler then refuses to
      // decompile. Fail before that reaches the write path.
      if (node.branches.length !== node.choices.length) {
        throw new Error(
          `Show Choices has ${node.choices.length} choice(s) but ${node.branches.length} branch bodies; they must match one-to-one`
        );
      }
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
      out.push(audioCommand(250, indent, node));
      return;

    case 'playBgm':
      out.push(audioCommand(241, indent, node));
      return;

    case 'moveRoute': {
      const route = buildMoveRoute(node);
      out.push({ code: 205, indent, parameters: [node.characterId, route] });
      // The 505 mirror rows: one per route step, terminator included. The
      // interpreter ignores them, the editor renders from them — omitting them
      // makes a route the game runs but the editor shows as a blank line.
      for (const step of route.list) out.push({ code: 505, indent, parameters: [step] });
      return;
    }

    case 'battle': {
      out.push({
        code: 301,
        indent,
        parameters: [node.designation, node.troopId, node.canEscape, node.canLose],
      });
      if (node.win) {
        out.push({ code: 601, indent, parameters: [] });
        emitList(node.win, indent + 1, out);
      }
      if (node.escape) {
        out.push({ code: 602, indent, parameters: [] });
        emitList(node.escape, indent + 1, out);
      }
      if (node.lose) {
        out.push({ code: 603, indent, parameters: [] });
        emitList(node.lose, indent + 1, out);
      }
      out.push({ code: 604, indent, parameters: [] });
      return;
    }

    case 'shop': {
      // `Game_Interpreter.command302` reads the first good off the 302 itself,
      // so an empty stock has nowhere to put `purchaseOnly` and would emit a
      // 302 whose parameters are all undefined — i.e. `null`s on disk.
      if (node.goods.length === 0) throw new Error('Shop Processing needs at least one good');
      const [first, ...rest] = node.goods;
      out.push({ code: 302, indent, parameters: [first.type, first.id, first.priceType, first.price, node.purchaseOnly] });
      for (const good of rest) {
        out.push({ code: 605, indent, parameters: [good.type, good.id, good.priceType, good.price] });
      }
      return;
    }

    case 'script': {
      const lines = node.lines.length > 0 ? node.lines : [''];
      lines.forEach((line, i) => out.push({ code: i === 0 ? 355 : 655, indent, parameters: [line] }));
      return;
    }

    case 'pluginCommand':
      out.push({
        code: 357,
        indent,
        parameters: [node.plugin, node.command, node.label ?? node.command, node.args],
      });
      return;

    default: {
      // Every Tier 2 command whose payload is a flat parameter list — the table
      // in ir.ts is the parameter order, for emit and decompile both.
      const spec = SIMPLE_COMMANDS[node.kind];
      if (!spec) throw new Error(`Cannot emit unknown node kind: ${JSON.stringify((node as Node).kind)}`);
      const fields = node as unknown as Record<string, unknown>;
      out.push({ code: spec.code, indent, parameters: Object.keys(spec.fields).map((name) => fields[name]) });
    }
  }
}

function audioCommand(code: number, indent: number, node: { name: string; volume: number; pitch: number; pan: number }): EventCommand {
  return { code, indent, parameters: [{ name: node.name, volume: node.volume, pitch: node.pitch, pan: node.pan }] };
}

/**
 * The `{list, repeat, skippable, wait}` object MZ stores both on a 205 and on
 * an event page's autonomous `moveRoute`. Exported because the MCP layer writes
 * the page one (`upsert_map_event`), and two places deriving "append ROUTE_END,
 * default `indent: null` per step" separately is how they drift apart.
 */
export function buildMoveRoute(spec: {
  route: MoveStep[];
  repeat: boolean;
  skippable: boolean;
  wait: boolean;
}): MoveRoute {
  const list: MoveRoute['list'] = spec.route.map((step) => ({
    code: step.code,
    indent: null,
    ...(step.parameters ? { parameters: [...step.parameters] } : {}),
  }));
  list.push({ code: 0, indent: null });
  return { list, repeat: spec.repeat, skippable: spec.skippable, wait: spec.wait };
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
      return [...condition.parameters]; // copy, for the same aliasing reason as RawNode
  }
}
