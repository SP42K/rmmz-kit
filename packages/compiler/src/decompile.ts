import type { EventCommand } from '@rmmz-kit/core';
import type { CompareOp, Condition, Node, RawNode } from './ir.js';

const COMPARE_OPS: CompareOp[] = ['eq', 'gte', 'lte', 'gt', 'lt', 'neq'];
const VARIABLE_OPS: Array<'set' | 'add' | 'sub' | 'mul' | 'div' | 'mod'> = ['set', 'add', 'sub', 'mul', 'div', 'mod'];

/**
 * Inverse of emit.ts's compile(). Expects a full page/common-event command
 * list including the trailing `{code:0, indent:0}` terminator (real MZ data
 * always has one) and strips it.
 *
 * Any code this compiler doesn't model semantically — Tier 2/3, or operand
 * shapes Tier 1 doesn't cover (e.g. Control Variables with a variable
 * operand instead of a constant) — decompiles to a RawNode carrying the
 * command verbatim, so nothing existing in a real project is ever lost.
 */
export function decompile(commands: EventCommand[]): Node[] {
  const { nodes, pos } = parseBlock(commands, 0, 0);
  const terminator = commands[pos];
  if (!terminator || terminator.code !== 0 || terminator.indent !== 0) {
    throw new Error(`Expected a code-0 terminator at index ${pos}`);
  }
  if (pos !== commands.length - 1) {
    throw new Error(`Unexpected commands after the terminator at index ${pos}`);
  }
  return nodes;
}

/**
 * Structural codes that close a block; parseBlock stops (without consuming)
 * when it sees one at `indent`. 113 (Break Loop) is deliberately excluded —
 * it's an ordinary command *inside* a loop body (jumps to after 413 at
 * runtime), not a marker that ends the body in the command list itself.
 */
const CLOSERS = new Set([0, 411, 412, 402, 403, 404, 413]);

function parseBlock(cmds: EventCommand[], pos: number, indent: number): { nodes: Node[]; pos: number } {
  const nodes: Node[] = [];
  while (pos < cmds.length) {
    const cmd = cmds[pos];
    if (cmd.indent < indent) break;
    if (cmd.indent > indent) {
      // Only reachable when the *caller* mis-positioned us; every recursive
      // call below enters a block whose first command is at `indent` or is a
      // closer. Deeper-than-expected commands that follow an unmodeled
      // structural command are absorbed as that command's `body` in `default`.
      throw new Error(`Command ${pos} (code ${cmd.code}) is indented deeper than expected`);
    }
    if (CLOSERS.has(cmd.code)) break;

    switch (cmd.code) {
      case 101: {
        const params = cmd.parameters as [string, number, number, number, string?];
        const lines: string[] = [];
        pos++;
        while (pos < cmds.length && cmds[pos].code === 401 && cmds[pos].indent === indent) {
          lines.push(cmds[pos].parameters[0] as string);
          pos++;
        }
        nodes.push({
          kind: 'text',
          face: params[0],
          faceIndex: params[1],
          background: params[2],
          position: params[3],
          speakerName: params.length >= 5 ? params[4] : undefined,
          lines,
        });
        break;
      }

      case 108: {
        const lines: string[] = [cmd.parameters[0] as string];
        pos++;
        while (pos < cmds.length && cmds[pos].code === 408 && cmds[pos].indent === indent) {
          lines.push(cmds[pos].parameters[0] as string);
          pos++;
        }
        nodes.push({ kind: 'comment', lines });
        break;
      }

      case 111: {
        pos++;
        const condition = readCondition(cmd.parameters);
        const thenResult = parseBlock(cmds, pos, indent + 1);
        pos = thenResult.pos;
        let elseNodes: Node[] | undefined;
        if (cmds[pos]?.code === 411 && cmds[pos].indent === indent) {
          pos++;
          const elseResult = parseBlock(cmds, pos, indent + 1);
          pos = elseResult.pos;
          elseNodes = elseResult.nodes;
        }
        expect(cmds, pos, 412, indent);
        pos++;
        nodes.push({ kind: 'if', condition, then: thenResult.nodes, else: elseNodes });
        break;
      }

      case 102: {
        const params = cmd.parameters as [string[], number?, number?, number?, number?];
        if (!Array.isArray(params[0])) {
          pos = pushRaw(nodes, cmds, pos, indent);
          break;
        }
        pos++;
        const choices = params[0];
        const branches: Node[][] = [];
        for (let i = 0; i < choices.length; i++) {
          expect(cmds, pos, 402, indent);
          pos++;
          const result = parseBlock(cmds, pos, indent + 1);
          pos = result.pos;
          pos = consumeOptionalFiller(cmds, pos, indent + 1);
          branches.push(result.nodes);
        }
        let cancelBranch: Node[] | undefined;
        if (cmds[pos]?.code === 403 && cmds[pos].indent === indent) {
          pos++;
          const result = parseBlock(cmds, pos, indent + 1);
          pos = result.pos;
          pos = consumeOptionalFiller(cmds, pos, indent + 1);
          cancelBranch = result.nodes;
        }
        expect(cmds, pos, 404, indent);
        pos++;
        nodes.push({
          kind: 'choice',
          choices,
          cancelType: params[1] ?? -2,
          defaultType: params[2] ?? -1,
          positionType: params[3] ?? 2,
          background: params[4] ?? 0,
          branches,
          cancelBranch,
        });
        break;
      }

      case 112: {
        pos++;
        const result = parseBlock(cmds, pos, indent + 1);
        pos = result.pos;
        expect(cmds, pos, 413, indent);
        pos++;
        nodes.push({ kind: 'loop', body: result.nodes });
        break;
      }

      case 121: {
        const [from, to, valueIdx] = cmd.parameters as [number, number, number];
        nodes.push({ kind: 'setSwitch', from, to, value: valueIdx === 0 });
        pos++;
        break;
      }

      case 122: {
        const [from, to, opIdx, operandType, value] = cmd.parameters as [number, number, number, number, number];
        if (operandType !== 0 || !VARIABLE_OPS[opIdx]) {
          pos = pushRaw(nodes, cmds, pos, indent);
          break;
        }
        nodes.push({ kind: 'setVariable', from, to, op: VARIABLE_OPS[opIdx], value });
        pos++;
        break;
      }

      case 123: {
        const [ch, valueIdx] = cmd.parameters as ['A' | 'B' | 'C' | 'D', number];
        nodes.push({ kind: 'setSelfSwitch', ch, value: valueIdx === 0 });
        pos++;
        break;
      }

      case 117: {
        nodes.push({ kind: 'callCommonEvent', commonEventId: cmd.parameters[0] as number });
        pos++;
        break;
      }

      case 201: {
        const [designation, mapId, x, y, direction, fadeType] = cmd.parameters as number[];
        if (designation !== 0) {
          pos = pushRaw(nodes, cmds, pos, indent);
          break;
        }
        nodes.push({ kind: 'transfer', mapId, x, y, direction, fadeType });
        pos++;
        break;
      }

      case 230: {
        nodes.push({ kind: 'wait', frames: cmd.parameters[0] as number });
        pos++;
        break;
      }

      case 250: {
        const audio = cmd.parameters[0] as { name: string; volume: number; pitch: number; pan: number } | undefined;
        // A plugin-written or truncated 250 must degrade to RawNode like every
        // other unmodeled shape, not throw a TypeError out of decompile().
        if (audio === null || typeof audio !== 'object') {
          pos = pushRaw(nodes, cmds, pos, indent);
          break;
        }
        nodes.push({ kind: 'playSe', name: audio.name, volume: audio.volume, pitch: audio.pitch, pan: audio.pan });
        pos++;
        break;
      }

      default:
        pos = pushRaw(nodes, cmds, pos, indent);
    }
  }
  return { nodes, pos };
}

/**
 * Emits a RawNode for the command at `pos` and, if the next command is
 * indented one level deeper, absorbs that run as the node's `body`.
 *
 * The deeper-body case is how unmodeled *structural* commands survive:
 * Battle Processing writes 301 / 601 "If Win" / 603 "If Lose" / 604 at one
 * indent with their bodies at indent+1, exactly like 111/411/412, but nothing
 * here models it. Before this, such a list threw — which contradicted the
 * whole point of the RawNode fallback, since Battle Processing is ordinary
 * content in a real project.
 */
function pushRaw(nodes: Node[], cmds: EventCommand[], pos: number, indent: number): number {
  const cmd = cmds[pos];
  // Copy the parameters array: it belongs to the caller's parsed project JSON,
  // and the IR must not hand out a live alias into it.
  const node: RawNode = { kind: 'raw', code: cmd.code, parameters: [...cmd.parameters] };
  pos++;
  const next = cmds[pos];
  if (next && next.indent === indent + 1 && !CLOSERS.has(next.code)) {
    const result = parseBlock(cmds, pos, indent + 1);
    pos = result.pos;
    node.body = result.nodes;
  }
  nodes.push(node);
  return pos;
}

/** Choice/cancel branches end with an optional `{code:0}` filler (see ChoiceNode doc in ir.ts) — consume it if present. */
function consumeOptionalFiller(cmds: EventCommand[], pos: number, indent: number): number {
  const cmd = cmds[pos];
  return cmd && cmd.code === 0 && cmd.indent === indent ? pos + 1 : pos;
}

function expect(cmds: EventCommand[], pos: number, code: number, indent: number): void {
  const cmd = cmds[pos];
  if (!cmd || cmd.code !== code || cmd.indent !== indent) {
    throw new Error(`Expected code ${code} at indent ${indent} at index ${pos}, got ${cmd ? `code ${cmd.code} indent ${cmd.indent}` : 'end of list'}`);
  }
}

function readCondition(parameters: unknown[]): Condition {
  const [type] = parameters as [number];
  if (type === 0) {
    const [, switchId, valueIdx] = parameters as [number, number, number];
    return { type: 'switch', switchId, value: valueIdx === 0 };
  }
  if (type === 1) {
    const [, variableId, operandType, value, cmp] = parameters as [number, number, number, number, number];
    if (operandType === 0 && COMPARE_OPS[cmp]) {
      return { type: 'variable', variableId, cmp: COMPARE_OPS[cmp], value };
    }
    return { type: 'raw', parameters: [...parameters] };
  }
  if (type === 12) {
    const [, code] = parameters as [number, string];
    return { type: 'script', code };
  }
  return { type: 'raw', parameters: [...parameters] };
}
