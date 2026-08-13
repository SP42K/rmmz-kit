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

  it('resolves namespace.member names through the resolver, everywhere an id appears', () => {
    const fail = (name: string): never => {
      throw new Error(`unknown ${name}`);
    };
    const names = {
      switch: (name: string) => ({ 'quest.herb.started': 11, 'quest.herb.done': 12 })[name] ?? fail(name),
      variable: (name: string) => ({ 'quest.herb.count': 7 })[name] ?? fail(name),
    };
    const yaml = `
- setSwitch: { from: quest.herb.started, value: true }
- setVariable: { from: quest.herb.count, op: add, value: 1 }
- if:
    switch: quest.herb.started
    then:
      - if:
          variable: quest.herb.count
          cmp: gte
          value: 3
          then:
            - setSwitch: { from: quest.herb.done, value: true }
`;
    const nodes = parseDsl(yaml, names);
    expect(nodes[0]).toEqual({ kind: 'setSwitch', from: 11, to: 11, value: true });
    expect(nodes[1]).toMatchObject({ kind: 'setVariable', from: 7, to: 7 });
    expect(nodes[2]).toMatchObject({ condition: { type: 'switch', switchId: 11 } });

    // Inverse: print with the lookup and the ids come back out as names.
    const printed = printDsl(nodes, {
      switch: (id) => ({ 11: 'quest.herb.started', 12: 'quest.herb.done' })[id],
      variable: (id) => ({ 7: 'quest.herb.count' })[id],
    });
    expect(printed).toContain('quest.herb.done');
    expect(parseDsl(printed, names)).toEqual(nodes);
  });

  it('a named id with no resolver is an error, not switch NaN', () => {
    expect(() => parseDsl('- setSwitch: { from: quest.herb.started, value: true }')).toThrow(/name resolver/);
  });

  it('rejects malformed DSL with a schema error rather than compiling garbage', () => {
    expect(() => parseDsl('- say: { nope: true }')).toThrow();
  });

  it('rejects a mistyped payload key instead of silently dropping its value', () => {
    // `els` used to be stripped, quietly deleting the whole else branch.
    expect(() => parseDsl('- if: { switch: 5, then: [{ wait: 1 }], els: [{ wait: 2 }] }')).toThrow();
    expect(() => parseDsl('- say: { text: hi, speeker: Bob }')).toThrow();
    expect(() => parseDsl('- choice: { branches: { A: [] }, cancle: [{ wait: 1 }] }')).toThrow();
  });

  it('defaults a choice to cancel-disallowed, and to the cancel branch only when one is given', () => {
    // -1 disallows cancel (Window_ChoiceList.isCancelEnabled), -2 allows it and
    // runs the 403 body; defaulting to -2 with no `cancel:` would let the player
    // dismiss the menu and skip every branch.
    const [plain] = parseDsl('- choice: { branches: { A: [], B: [] } }') as [{ cancelType: number }];
    expect(plain.cancelType).toBe(-1);
    const [withCancel] = parseDsl('- choice: { branches: { A: [] }, cancel: [{ wait: 1 }] }') as [{ cancelType: number }];
    expect(withCancel.cancelType).toBe(-2);
  });

  it('rejects plain-integer choice labels, whose YAML order JS objects do not preserve', () => {
    expect(() => parseDsl('- choice: { branches: { "10": [], "5": [] } }')).toThrow(/integer/);
  });

  it('rejects a face index that is not a number rather than writing NaN', () => {
    expect(() => parseDsl('- say: { text: hi, face: "Actor1/abc" }')).toThrow(/face/);
  });

  it('refuses to print a Show Choices with duplicate labels rather than dropping a branch', () => {
    const commands = compile([
      {
        kind: 'choice',
        choices: ['Yes', 'Yes'],
        cancelType: -1,
        defaultType: -1,
        positionType: 2,
        background: 0,
        branches: [[{ kind: 'wait', frames: 1 }], [{ kind: 'wait', frames: 2 }]],
      },
    ]);
    expect(() => printDsl(decompile(commands))).toThrow(/duplicate label/);
  });

  it('the raw escape hatch passes through an unmodeled command untouched', () => {
    const nodes = parseDsl('- raw: { code: 231, parameters: [1, "Cloud", 0, 0] }');
    expect(compile(nodes)[0]).toEqual({ code: 231, indent: 0, parameters: [1, 'Cloud', 0, 0] });
  });
});
