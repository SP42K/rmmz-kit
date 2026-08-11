import { describe, expect, it } from 'vitest';
import { compile } from '../src/emit.js';
import { decompile } from '../src/decompile.js';
import { parseDsl } from '../src/dsl/parse.js';
import { printDsl } from '../src/dsl/print.js';

describe('DSL (YAML)', () => {
  it('compiles the plan §4.2 herb-quest style script into a valid command list', () => {
    const yaml = `
- say:
    speaker: 藥草師
    face: Actor1/2
    text: "北邊森林有藥草…能幫我採三株嗎？"
- choice:
    branches:
      好:
        - setSwitch: { from: 10, value: true }
        - say: "太感謝了！"
      不了:
        - say: "…也罷。"
- if:
    switch: 10
    then:
      - callCommonEvent: 3
`;
    const nodes = parseDsl(yaml);
    const commands = compile(nodes);
    expect(commands.at(-1)).toEqual({ code: 0, indent: 0, parameters: [] });
    expect(commands[0]).toEqual({ code: 101, indent: 0, parameters: ['Actor1', 2, 0, 2, '藥草師'] });
  });

  it('round-trips DSL -> IR -> commands -> IR -> DSL back to an equivalent document', () => {
    const yaml = `
- say:
    text:
      - line one
      - line two
- setVariable: { from: 3, to: 3, op: add, value: 5 }
- wait: 30
`;
    const nodes = parseDsl(yaml);
    const commands = compile(nodes);
    const roundTripped = parseDsl(printDsl(decompile(commands)));
    expect(roundTripped).toEqual(nodes);
  });

  it('rejects malformed DSL with a schema error rather than compiling garbage', () => {
    expect(() => parseDsl('- say: { nope: true }')).toThrow();
  });

  it('the raw escape hatch passes through an unmodeled command untouched', () => {
    const nodes = parseDsl('- raw: { code: 357, parameters: ["MyPlugin", "cmd", {}] }');
    expect(compile(nodes)[0]).toEqual({ code: 357, indent: 0, parameters: ['MyPlugin', 'cmd', {}] });
  });
});
