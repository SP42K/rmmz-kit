import { describe, expect, it } from 'vitest';
import { compile } from '../src/emit.js';
import { decompile } from '../src/decompile.js';
import { SIMPLE_COMMANDS, type Condition, type Node, type SimpleKind } from '../src/ir.js';

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

/** Codes with no typed node: the Tier 3 remainder (234/261/281/331/332 — 231/232/233/235 are SIMPLE_COMMANDS entries now) and MV's text plugin command (356). */
const RAW_CODES = [124, 132, 133, 234, 261, 281, 331, 332, 356];

const SIMPLE_KINDS_UNDER_TEST = Object.keys(SIMPLE_COMMANDS) as SimpleKind[];

/** A node for a flat-parameter Tier 2 command, with every field given a value of the right type. */
function randomSimpleNode(rng: () => number): Node {
  const kind = pick(rng, SIMPLE_KINDS_UNDER_TEST);
  const node: Record<string, unknown> = { kind };
  for (const [name, value] of Object.entries(SIMPLE_COMMANDS[kind].fields as Record<string, unknown>)) {
    node[name] =
      typeof value === 'number' ? Math.floor(rng() * 20) : typeof value === 'string' ? `v${Math.floor(rng() * 100)}` : rng() < 0.5;
  }
  return node as unknown as Node;
}

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
    () => ({
      kind: 'playBgm',
      name: pick(rng, ['Town1', 'Battle1']),
      volume: Math.floor(rng() * 100),
      pitch: Math.floor(rng() * 100) + 50,
      pan: 0,
    }),
    () => randomSimpleNode(rng),
    () => ({
      kind: 'moveRoute',
      characterId: pick(rng, [-1, 0, 1, 2]),
      repeat: rng() < 0.5,
      skippable: rng() < 0.5,
      wait: rng() < 0.5,
      route: Array.from({ length: Math.floor(rng() * 4) }, () =>
        rng() < 0.7
          ? { code: 1 + Math.floor(rng() * 13) }
          : { code: 45, parameters: [`this.setOpacity(${Math.floor(rng() * 255)})`] }
      ),
    }),
    () => ({
      kind: 'shop',
      goods: Array.from({ length: 1 + Math.floor(rng() * 3) }, () => ({
        type: Math.floor(rng() * 3),
        id: 1 + Math.floor(rng() * 10),
        priceType: Math.floor(rng() * 2),
        price: Math.floor(rng() * 500),
      })),
      purchaseOnly: rng() < 0.5,
    }),
    () => ({
      kind: 'script',
      lines: Array.from({ length: 1 + Math.floor(rng() * 3) }, () => `$gameSwitches.setValue(${Math.floor(rng() * 20)}, true);`),
    }),
    () => ({
      kind: 'pluginCommand',
      plugin: pick(rng, ['TextPicture', 'AltMenuScreen']),
      command: pick(rng, ['set', 'clear']),
      label: rng() < 0.5 ? undefined : 'Custom Label',
      args: rng() < 0.5 ? {} : { text: `hello ${Math.floor(rng() * 100)}` },
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
      () => ({
        kind: 'battle',
        designation: Math.floor(rng() * 3),
        troopId: 1 + Math.floor(rng() * 5),
        canEscape: rng() < 0.5,
        canLose: rng() < 0.5,
        // Each branch is independently present-or-absent, the same distinction
        // IfNode.else makes: no 60x row at all vs. a 60x with an empty body.
        win: rng() < 0.7 ? randomList(rng, depth - 1) : undefined,
        escape: rng() < 0.4 ? randomList(rng, depth - 1) : undefined,
        lose: rng() < 0.4 ? randomList(rng, depth - 1) : undefined,
      }),
      // An unmodeled structural command with an indented body. Only ever
      // attached non-empty: `body: []` and no body compile to the same list.
      () => {
        const body = randomList(rng, depth - 1);
        const raw: Node = { kind: 'raw', code: pick(rng, [900, 901, 902]), parameters: [] };
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
