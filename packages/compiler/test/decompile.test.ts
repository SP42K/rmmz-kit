import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/emit.js';
import { decompile } from '../src/decompile.js';
import type { EventCommand, MapData } from '@rmmz-kit/core';

const fixturePath = fileURLToPath(new URL('../../../fixtures/minimal-project/data/Map001.json', import.meta.url));

describe('decompile', () => {
  it('is the exact inverse of compile for canonical (self-produced) command lists', () => {
    const commands = compile([
      { kind: 'text', face: 'Actor1', faceIndex: 2, background: 0, position: 2, lines: ['Hi'] },
      {
        kind: 'if',
        condition: { type: 'switch', switchId: 5, value: true },
        then: [{ kind: 'setSwitch', from: 1, to: 3, value: false }],
        else: [{ kind: 'wait', frames: 10 }],
      },
      {
        kind: 'choice',
        choices: ['Yes', 'No'],
        cancelType: -2,
        defaultType: -1,
        positionType: 2,
        background: 0,
        branches: [[{ kind: 'callCommonEvent', commonEventId: 1 }], []],
      },
      { kind: 'loop', body: [{ kind: 'raw', code: 113, parameters: [] }] },
    ]);

    expect(compile(decompile(commands))).toEqual(commands);
  });

  it('throws a clear error when the list is missing its terminator', () => {
    const commands: EventCommand[] = [{ code: 101, indent: 0, parameters: ['', 0, 0, 2] }];
    expect(() => decompile(commands)).toThrow(/terminator/);
  });

  it('falls back to a RawNode for an unmodeled code', () => {
    // 231 Show Picture — Tier 3, so still nothing but code+parameters here.
    const commands = compile([{ kind: 'raw', code: 231, parameters: [1, 'Cloud', 0, 0, 0, 0, 100, 100, 255, 0] }]);
    expect(decompile(commands)).toEqual([{ kind: 'raw', code: 231, parameters: [1, 'Cloud', 0, 0, 0, 0, 100, 100, 255, 0] }]);
  });

  it('round-trips an unmodeled structural command with an indented body', () => {
    // A command this compiler has no node for, whose body MZ indents by one
    // exactly like 111/411/412 (Battle Processing was this case until M7.5
    // typed it; Tier 3 and plugin-added commands still are). It must survive
    // as RawNodes carrying a `body`, not throw.
    const commands: EventCommand[] = [
      { code: 900, indent: 0, parameters: ['branching plugin command'] },
      { code: 101, indent: 1, parameters: ['', 0, 0, 2] },
      { code: 401, indent: 1, parameters: ['Inside the body'] },
      { code: 901, indent: 0, parameters: [] },
      { code: 230, indent: 1, parameters: [60] },
      { code: 0, indent: 0, parameters: [] },
    ];

    const nodes = decompile(commands);
    expect(nodes).toEqual([
      {
        kind: 'raw',
        code: 900,
        parameters: ['branching plugin command'],
        body: [{ kind: 'text', face: '', faceIndex: 0, background: 0, position: 2, speakerName: undefined, lines: ['Inside the body'] }],
      },
      { kind: 'raw', code: 901, parameters: [], body: [{ kind: 'wait', frames: 60 }] },
    ]);
    expect(compile(nodes)).toEqual(commands);
  });

  it('does not hand out IR that aliases the input command list', () => {
    const source: EventCommand[] = [
      { code: 231, indent: 0, parameters: [1, 'Cloud'] },
      { code: 0, indent: 0, parameters: [] },
    ];
    const [node] = decompile(source) as [{ kind: 'raw'; parameters: unknown[] }];
    expect(node.parameters).not.toBe(source[0].parameters);
    expect(compile([node as never])[0].parameters).not.toBe(source[0].parameters);
  });

  it('falls back to a RawNode instead of throwing on a Play SE with no audio operand', () => {
    const commands: EventCommand[] = [
      { code: 250, indent: 0, parameters: [] },
      { code: 0, indent: 0, parameters: [] },
    ];
    expect(decompile(commands)).toEqual([{ kind: 'raw', code: 250, parameters: [] }]);
  });

  it('falls back to a raw condition for a variable-vs-variable conditional branch (unmodeled operand)', () => {
    const commands: EventCommand[] = [
      { code: 111, indent: 0, parameters: [1, 3, 1, 4, 0] }, // variable 3 vs variable 4, operandType 1
      { code: 412, indent: 0, parameters: [] },
      { code: 0, indent: 0, parameters: [] },
    ];
    const [node] = decompile(commands);
    expect(node).toEqual({
      kind: 'if',
      condition: { type: 'raw', parameters: [1, 3, 1, 4, 0] },
      then: [],
      else: undefined,
    });
  });

  it('decompiles the real fixture event without throwing, and is stable under a second round trip', () => {
    const map = JSON.parse(readFileSync(fixturePath, 'utf-8')) as MapData;
    // The fixture's first 3 commands (112 Loop / 113 Break Loop / 413 Repeat Above) put the
    // Break Loop at the *same* indent as its enclosing Loop, not one level deeper like every
    // other nested body in this file — almost certainly hand-authored test data rather than
    // real MZ editor output (see CLAUDE.md's R1 note on this fixture). Skipped here rather
    // than taught to the decompiler, since real Loop bodies do use indent+1 everywhere else.
    const list = map.events[1]!.pages[0].list.slice(3);

    const decompiled = decompile(list);
    const recompiled = compile(decompiled);
    // Not necessarily byte-identical to `list` (fixture data omits some trailing MZ
    // parameter padding, e.g. Show Choices' positionType/background) — see ir.ts's
    // ChoiceNode doc. What must hold: decompiling is idempotent from here on.
    expect(decompile(recompiled)).toEqual(decompiled);
  });
});
