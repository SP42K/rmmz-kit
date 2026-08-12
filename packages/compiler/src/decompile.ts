import type { EventCommand, MoveRoute } from '@rmmz-kit/core';
import { SIMPLE_COMMANDS, type CompareOp, type Condition, type MoveStep, type Node, type RawNode, type ShopGood, type SimpleKind } from './ir.js';

const COMPARE_OPS: CompareOp[] = ['eq', 'gte', 'lte', 'gt', 'lt', 'neq'];
const VARIABLE_OPS: Array<'set' | 'add' | 'sub' | 'mul' | 'div' | 'mod'> = ['set', 'add', 'sub', 'mul', 'div', 'mod'];

/** ir.ts's flat-parameter table, keyed the way decompile needs it. */
const SIMPLE_BY_CODE = new Map<number, { kind: SimpleKind; fields: string[]; defaults: unknown[] }>(
  Object.entries(SIMPLE_COMMANDS).map(([kind, spec]) => [
    spec.code,
    { kind: kind as SimpleKind, fields: Object.keys(spec.fields), defaults: Object.values(spec.fields) as unknown[] },
  ])
);

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

      case 250:
      case 241: {
        const audio = cmd.parameters[0] as { name: string; volume: number; pitch: number; pan: number } | undefined;
        // A plugin-written or truncated 250/241 must degrade to RawNode like
        // every other unmodeled shape, not throw a TypeError out of decompile().
        if (audio === null || typeof audio !== 'object') {
          pos = pushRaw(nodes, cmds, pos, indent);
          break;
        }
        const kind = cmd.code === 250 ? 'playSe' : 'playBgm';
        nodes.push({ kind, name: audio.name, volume: audio.volume, pitch: audio.pitch, pan: audio.pan });
        pos++;
        break;
      }

      case 205: {
        const [characterId, route] = cmd.parameters as [number, MoveRoute | undefined];
        if (typeof characterId !== 'number' || !route || typeof route !== 'object' || !Array.isArray(route.list)) {
          pos = pushRaw(nodes, cmds, pos, indent);
          break;
        }
        pos++;
        // Drop the 505 mirror rows: they are a redundant copy of `route.list`
        // that the interpreter never reads (command505 is a no-op), so keeping
        // both in the IR would mean two sources of truth for one route.
        while (cmds[pos]?.code === 505 && cmds[pos].indent === indent) pos++;
        nodes.push({
          kind: 'moveRoute',
          characterId,
          repeat: route.repeat ?? false,
          skippable: route.skippable ?? false,
          wait: route.wait ?? false,
          route: stripRouteEnd(route.list),
        });
        break;
      }

      case 301: {
        // A 301 whose branch labels aren't the canonical 601/602/603 + 604 (a
        // plugin-written or truncated list) must degrade to RawNode like every
        // other unmodeled shape: RawNode.body already nests 601-style branches,
        // and throwing here would break "decompiling an arbitrary project never
        // fails" — which also takes down rmmz://map/{id} for the whole map.
        const start = pos;
        try {
          const [designation, troopId, canEscape, canLose] = cmd.parameters as [number, number, boolean, boolean];
          pos++;
          const branches: Array<[601 | 602 | 603, Node[]]> = [];
          for (const code of [601, 602, 603] as const) {
            if (cmds[pos]?.code !== code || cmds[pos].indent !== indent) continue;
            pos++;
            const result = parseBlock(cmds, pos, indent + 1);
            pos = result.pos;
            pos = consumeOptionalFiller(cmds, pos, indent + 1);
            branches.push([code, result.nodes]);
          }
          expect(cmds, pos, 604, indent);
          pos++;
          const branch = (code: 601 | 602 | 603) => branches.find(([c]) => c === code)?.[1];
          nodes.push({
            kind: 'battle',
            designation,
            troopId,
            canEscape,
            canLose,
            win: branch(601),
            escape: branch(602),
            lose: branch(603),
          });
        } catch {
          // Nothing was pushed (the node lands only after `expect` passes), so
          // rewinding `pos` is enough to re-read the 301 as a raw command. A
          // genuinely malformed *body* still throws, out of pushRaw's own
          // parseBlock — this only swallows the 301-shape mismatch.
          pos = pushRaw(nodes, cmds, start, indent);
        }
        break;
      }

      case 302: {
        // Same shape guard `matchesSimple` applies to the flat table: a 302 the
        // ShopNode can't hold whole (an extra parameter, a non-numeric good)
        // would lose that data when emit rewrites the canonical 5-element array.
        if (!isGood(cmd.parameters, 5)) {
          pos = pushRaw(nodes, cmds, pos, indent);
          break;
        }
        const [type, id, priceType, price, purchaseOnly] = cmd.parameters as [number, number, number, number, boolean];
        pos++;
        const goods: ShopGood[] = [{ type, id, priceType, price }];
        while (cmds[pos]?.code === 605 && cmds[pos].indent === indent && isGood(cmds[pos].parameters, 4)) {
          const [t, i, pt, p] = cmds[pos].parameters as [number, number, number, number];
          goods.push({ type: t, id: i, priceType: pt, price: p });
          pos++;
        }
        nodes.push({ kind: 'shop', goods, purchaseOnly: purchaseOnly ?? false });
        break;
      }

      case 355: {
        // ScriptNode holds strings; a 355 carrying anything else would come
        // back out of emit as that non-string, or as `null` if it was missing.
        if (typeof cmd.parameters[0] !== 'string') {
          pos = pushRaw(nodes, cmds, pos, indent);
          break;
        }
        const lines: string[] = [cmd.parameters[0]];
        pos++;
        while (
          pos < cmds.length &&
          cmds[pos].code === 655 &&
          cmds[pos].indent === indent &&
          typeof cmds[pos].parameters[0] === 'string'
        ) {
          lines.push(cmds[pos].parameters[0] as string);
          pos++;
        }
        nodes.push({ kind: 'script', lines });
        break;
      }

      case 357: {
        const [plugin, command, label, args] = cmd.parameters as [string, string, string | undefined, Record<string, unknown> | undefined];
        if (typeof plugin !== 'string' || typeof command !== 'string') {
          pos = pushRaw(nodes, cmds, pos, indent);
          break;
        }
        nodes.push({
          kind: 'pluginCommand',
          plugin,
          command,
          // Only kept when it differs from the command key; emit re-derives the
          // usual case, so round-tripping a normal 357 stays byte-identical.
          label: label === undefined || label === command ? undefined : label,
          args: args && typeof args === 'object' ? args : {},
        });
        pos++;
        break;
      }

      default: {
        const simple = SIMPLE_BY_CODE.get(cmd.code);
        if (simple && matchesSimple(simple, cmd.parameters)) {
          const node: Record<string, unknown> = { kind: simple.kind };
          simple.fields.forEach((name, i) => {
            node[name] = i < cmd.parameters.length ? cmd.parameters[i] : simple.defaults[i];
          });
          nodes.push(node as unknown as Node);
          pos++;
          break;
        }
        pos = pushRaw(nodes, cmds, pos, indent);
      }
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

/**
 * A flat-parameter command only decompiles to its typed node if the data really
 * has that shape: no extra trailing parameters (a plugin's or a future MZ
 * version's addition, which the node has nowhere to hold) and no type
 * disagreement with the table. Anything else is RawNode's job — the point of
 * the fallback is that nothing is ever lost, and a silently dropped tail is a loss.
 */
function matchesSimple(simple: { fields: string[]; defaults: unknown[] }, parameters: unknown[]): boolean {
  if (parameters.length > simple.fields.length) return false;
  return parameters.every((value, i) => typeof value === typeof simple.defaults[i]);
}

/** A stock row: `[type, id, priceType, price]`, plus `purchaseOnly` on the 302 itself (`max` 5, vs 4 for a 605). Same "nothing is lost" test as matchesSimple. */
function isGood(parameters: unknown[], max: number): boolean {
  return parameters.length <= max && parameters.slice(0, 4).every((value) => typeof value === 'number');
}

/** MZ terminates a move route with ROUTE_END; the IR omits it the same way it omits the command list's own terminator. */
function stripRouteEnd(list: MoveRoute['list']): MoveStep[] {
  const steps = list.at(-1)?.code === 0 ? list.slice(0, -1) : [...list];
  return steps.map((step) => (step.parameters ? { code: step.code, parameters: [...step.parameters] } : { code: step.code }));
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
