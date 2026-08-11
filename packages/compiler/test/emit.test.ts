import { describe, expect, it } from 'vitest';
import { compile } from '../src/emit.js';
import type { Node } from '../src/ir.js';

describe('compile', () => {
  it('always appends the terminating code-0 command', () => {
    expect(compile([])).toEqual([{ code: 0, indent: 0, parameters: [] }]);
  });

  it('emits Show Text as 101 followed by one 401 per line', () => {
    const node: Node = {
      kind: 'text',
      face: 'Actor1',
      faceIndex: 2,
      background: 0,
      position: 2,
      lines: ['Hello', 'World'],
    };
    expect(compile([node])).toEqual([
      { code: 101, indent: 0, parameters: ['Actor1', 2, 0, 2] },
      { code: 401, indent: 0, parameters: ['Hello'] },
      { code: 401, indent: 0, parameters: ['World'] },
      { code: 0, indent: 0, parameters: [] },
    ]);
  });

  it('includes speakerName as a 5th param only when set', () => {
    const withSpeaker: Node = {
      kind: 'text',
      face: '',
      faceIndex: 0,
      background: 0,
      position: 2,
      speakerName: 'Reid',
      lines: ['Hi'],
    };
    const [head] = compile([withSpeaker]);
    expect(head.parameters).toEqual(['', 0, 0, 2, 'Reid']);
  });

  it('emits if/else/end-if with bodies indented one level deeper', () => {
    const node: Node = {
      kind: 'if',
      condition: { type: 'switch', switchId: 5, value: true },
      then: [{ kind: 'wait', frames: 10 }],
      else: [{ kind: 'wait', frames: 20 }],
    };
    expect(compile([node])).toEqual([
      { code: 111, indent: 0, parameters: [0, 5, 0] },
      { code: 230, indent: 1, parameters: [10] },
      { code: 411, indent: 0, parameters: [] },
      { code: 230, indent: 1, parameters: [20] },
      { code: 412, indent: 0, parameters: [] },
      { code: 0, indent: 0, parameters: [] },
    ]);
  });

  it('omits the 411 else-marker entirely when there is no else branch', () => {
    const node: Node = {
      kind: 'if',
      condition: { type: 'switch', switchId: 5, value: true },
      then: [],
    };
    const codes = compile([node]).map((c) => c.code);
    expect(codes).toEqual([111, 412, 0]);
  });

  it('emits each choice branch with a trailing filler 0 at branch indent', () => {
    const node: Node = {
      kind: 'choice',
      choices: ['Yes', 'No'],
      cancelType: -2,
      defaultType: -1,
      positionType: 2,
      background: 0,
      branches: [[], []],
    };
    expect(compile([node])).toEqual([
      { code: 102, indent: 0, parameters: [['Yes', 'No'], -2, -1, 2, 0] },
      { code: 402, indent: 0, parameters: [0, 'Yes'] },
      { code: 0, indent: 1, parameters: [] },
      { code: 402, indent: 0, parameters: [1, 'No'] },
      { code: 0, indent: 1, parameters: [] },
      { code: 404, indent: 0, parameters: [] },
      { code: 0, indent: 0, parameters: [] },
    ]);
  });

  it('emits a 403 cancel branch only when cancelBranch is present', () => {
    const node: Node = {
      kind: 'choice',
      choices: ['Yes'],
      cancelType: -1,
      defaultType: -1,
      positionType: 2,
      background: 0,
      branches: [[]],
      cancelBranch: [{ kind: 'wait', frames: 1 }],
    };
    const codes = compile([node]).map((c) => c.code);
    expect(codes).toEqual([102, 402, 0, 403, 230, 0, 404, 0]);
  });

  it('emits loop as 112 ... 413 with the body indented one level deeper', () => {
    const node: Node = { kind: 'loop', body: [{ kind: 'raw', code: 113, parameters: [] }] };
    expect(compile([node])).toEqual([
      { code: 112, indent: 0, parameters: [] },
      { code: 113, indent: 1, parameters: [] },
      { code: 413, indent: 0, parameters: [] },
      { code: 0, indent: 0, parameters: [] },
    ]);
  });

  it('emits setVariable with the constant-operand shape', () => {
    const node: Node = { kind: 'setVariable', from: 3, to: 3, op: 'add', value: 5 };
    expect(compile([node])[0]).toEqual({ code: 122, indent: 0, parameters: [3, 3, 1, 0, 5] });
  });
});
