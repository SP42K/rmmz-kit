import { describe, expect, it } from 'vitest';
import { compile } from '../src/emit.js';
import { decompile } from '../src/decompile.js';
import type { Condition, Node } from '../src/ir.js';

/**
 * Deterministic PRNG (mulberry32) so a failing seed is reproducible from the
 * printed seed alone, without vitest's own randomness getting involved.
 */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RAW_CODES = [124, 125, 132, 133, 205, 212, 213, 221, 222, 241, 242, 301, 302, 311, 355, 356];

function randomNode(rng: () => number, depth: number): Node {
  const pool: Array<() => Node> = [
    () => ({ kind: 'raw', code: pick(rng, RAW_CODES), parameters: [Math.floor(rng() * 100), 'x'] }),
    () => ({
      kind: 'text',
      face: rng() < 0.5 ? '' : 'Actor1',
      faceIndex: Math.floor(rng() * 8),
      background: Math.floor(rng() * 3),
      position: Math.floor(rng() * 3),
      speakerName: rng() < 0.5 ? undefined : 'Speaker',
      lines: Array.from({ length: 1 + Math.floor(rng() * 3) }, () => `line ${Math.floor(rng() * 1000)}`),
    }),
    () => ({
      kind: 'comment',
      lines: Array.from({ length: 1 + Math.floor(rng() * 2) }, () => `note ${Math.floor(rng() * 1000)}`),
    }),
    () => ({ kind: 'setSwitch', from: 1 + Math.floor(rng() * 20), to: 1 + Math.floor(rng() * 20), value: rng() < 0.5 }),
    () => ({
      kind: 'setVariable',
      from: 1 + Math.floor(rng() * 20),
      to: 1 + Math.floor(rng() * 20),
      op: pick(rng, ['set', 'add', 'sub', 'mul', 'div', 'mod'] as const),
      value: Math.floor(rng() * 100) - 50,
    }),
    () => ({ kind: 'setSelfSwitch', ch: pick(rng, ['A', 'B', 'C', 'D'] as const), value: rng() < 0.5 }),
    () => ({ kind: 'callCommonEvent', commonEventId: 1 + Math.floor(rng() * 10) }),
    () => ({
      kind: 'transfer',
      mapId: 1 + Math.floor(rng() * 10),
      x: Math.floor(rng() * 20),
      y: Math.floor(rng() * 20),
      direction: pick(rng, [2, 4, 6, 8]),
      fadeType: Math.floor(rng() * 3),
    }),
    () => ({ kind: 'wait', frames: Math.floor(rng() * 120) }),
    () => ({
      kind: 'playSe',
      name: pick(rng, ['Cursor1', 'Buzzer1', 'Bell1']),
      volume: Math.floor(rng() * 100),
      pitch: Math.floor(rng() * 100) + 50,
      pan: Math.floor(rng() * 20) - 10,
    }),
  ];

  if (depth > 0) {
    pool.push(
      () => ({
        kind: 'if',
        condition: randomCondition(rng),
        then: randomList(rng, depth - 1),
        else: rng() < 0.5 ? randomList(rng, depth - 1) : undefined,
      }),
      () => {
        const choices = Array.from({ length: 2 + Math.floor(rng() * 2) }, (_, i) => `choice${i}`);
        return {
          kind: 'choice',
          choices,
          cancelType: pick(rng, [-2, -1, 0]),
          defaultType: pick(rng, [-1, 0]),
          positionType: Math.floor(rng() * 3),
          background: Math.floor(rng() * 3),
          branches: choices.map(() => randomList(rng, depth - 1)),
          cancelBranch: rng() < 0.3 ? randomList(rng, depth - 1) : undefined,
        };
      },
      () => ({ kind: 'loop', body: randomList(rng, depth - 1) }),
      // An unmodeled structural command with an indented body — Battle
      // Processing's 601/603 being the real-world shape. Only ever attached
      // non-empty: `body: []` and no body compile to the same command list.
      () => {
        const body = randomList(rng, depth - 1);
        const raw: Node = { kind: 'raw', code: pick(rng, [601, 602, 603]), parameters: [] };
        return body.length > 0 ? { ...raw, body } : raw;
      }
    );
  }

  return pick(rng, pool)();
}

function randomCondition(rng: () => number): Condition {
  const kind = pick(rng, ['switch', 'variable', 'script'] as const);
  if (kind === 'switch') return { type: 'switch', switchId: 1 + Math.floor(rng() * 20), value: rng() < 0.5 };
  if (kind === 'variable') {
    return {
      type: 'variable',
      variableId: 1 + Math.floor(rng() * 20),
      cmp: pick(rng, ['eq', 'gte', 'lte', 'gt', 'lt', 'neq'] as const),
      value: Math.floor(rng() * 100),
    };
  }
  return { type: 'script', code: `$gameVariables.value(1) > ${Math.floor(rng() * 10)}` };
}

function randomList(rng: () => number, depth: number): Node[] {
  const length = Math.floor(rng() * 4);
  return Array.from({ length }, () => randomNode(rng, depth));
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

describe('compile/decompile round trip (fuzz)', () => {
  it('decompile(compile(nodes)) reproduces nodes for 1000 random trees, and every compiled list is structurally well-formed', () => {
    for (let seed = 0; seed < 1000; seed++) {
      const rng = mulberry32(seed);
      const nodes = randomList(rng, 3);

      const commands = compile(nodes);

      expect(commands.at(-1)).toEqual({ code: 0, indent: 0, parameters: [] });
      expect(commands.every((c) => c.indent >= 0)).toBe(true);

      let roundTripped: Node[];
      try {
        roundTripped = decompile(commands);
      } catch (err) {
        throw new Error(`seed ${seed} failed to decompile: ${(err as Error).message}`);
      }
      expect(roundTripped, `seed ${seed}`).toEqual(nodes);
    }
  });
});
