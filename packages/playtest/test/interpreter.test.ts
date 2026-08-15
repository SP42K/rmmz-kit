import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openProject, type ProjectSession } from '@rmmz-kit/core';
import { Interpreter } from '../src/interpreter.js';
import { makeTestProject } from './testProject.js';
import { putEvent } from './helpers.js';

describe('event-layer interpreter', () => {
  let project: { dir: string; cleanup: () => Promise<void> };
  let session: ProjectSession;

  beforeEach(async () => {
    project = await makeTestProject();
    session = await openProject(project.dir);
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it('writes switches, variables and self switches, and branches on them', () => {
    putEvent(session, 1, {
      id: 2,
      pages: [
        {
          dsl: `
- setSwitch: { from: 10, value: true }
- setVariable: { from: 3, op: add, value: 5 }
- setVariable: { from: 3, op: mul, value: 2 }
- if:
    switch: 10
    then:
      - setSelfSwitch: { ch: A, value: true }
      - say: "branch taken"
    else:
      - say: "branch missed"
`,
        },
      ],
    });

    const interpreter = new Interpreter(session);
    interpreter.runEvent(1, 2);

    expect(interpreter.state.switchValue(10)).toBe(true);
    expect(interpreter.state.variableValue(3)).toBe(10);
    expect(interpreter.state.selfSwitchValue(1, 2, 'A')).toBe(true);
    expect(interpreter.state.messages.map((m) => m.lines[0])).toEqual(['branch taken']);
  });

  it('takes the answered choice branch, then the default once answers run out', () => {
    const dsl = `
- choice:
    branches:
      Yes:
        - setVariable: { from: 1, op: add, value: 1 }
      No:
        - setVariable: { from: 2, op: add, value: 1 }
`;
    putEvent(session, 1, { id: 2, pages: [{ dsl }] });

    const interpreter = new Interpreter(session, undefined, { choices: [1] });
    interpreter.runEvent(1, 2);
    interpreter.runEvent(1, 2);

    expect(interpreter.state.variableValue(2)).toBe(1); // answered: No
    expect(interpreter.state.variableValue(1)).toBe(1); // unanswered: first branch
    expect(interpreter.state.choices.map((c) => c.chosen)).toEqual([1, 0]);
  });

  it('runs a loop until Break Loop, and Exit Event Processing stops the page', () => {
    putEvent(session, 1, {
      id: 2,
      pages: [
        {
          dsl: `
- loop:
    body:
      - setVariable: { from: 1, op: add, value: 1 }
      - if:
          variable: 1
          cmp: gte
          value: 3
          then:
            - breakLoop:
- exitEvent:
- say: "never reached"
`,
        },
      ],
    });

    const interpreter = new Interpreter(session);
    interpreter.runEvent(1, 2);

    expect(interpreter.state.variableValue(1)).toBe(3);
    expect(interpreter.state.messages).toEqual([]);
  });

  it('aborts a loop with no exit instead of hanging the caller', () => {
    putEvent(session, 1, { id: 2, pages: [{ dsl: '- loop:\n    body:\n      - wait: 1\n' }] });
    const interpreter = new Interpreter(session, undefined, { maxCommands: 500 });
    expect(() => interpreter.runEvent(1, 2)).toThrow(/budget exhausted/);
  });

  it('calls a common event, which writes the calling event\'s self switch', () => {
    session.createFile('CommonEvents.json', [
      null,
      {
        id: 1,
        name: 'Reward',
        trigger: 0,
        switchId: 1,
        list: [
          { code: 123, indent: 0, parameters: ['B', 0] },
          { code: 125, indent: 0, parameters: [0, 0, 250] },
          { code: 0, indent: 0, parameters: [] },
        ],
      },
    ]);
    putEvent(session, 1, { id: 4, pages: [{ dsl: '- callCommonEvent: 1' }] });

    const interpreter = new Interpreter(session);
    interpreter.runEvent(1, 4);

    expect(interpreter.state.gold).toBe(250);
    // MZ keys self switches by the running map event, not by the common event.
    expect(interpreter.state.selfSwitchValue(1, 4, 'B')).toBe(true);
  });

  it('moves the player on Transfer and accumulates Wait frames', () => {
    putEvent(session, 1, {
      id: 2,
      pages: [{ dsl: '- wait: 30\n- transfer: { mapId: 1, x: 7, y: 9, direction: 4 }\n- wait: 12\n' }],
    });

    const interpreter = new Interpreter(session);
    interpreter.runEvent(1, 2);

    expect(interpreter.state.player).toEqual({ mapId: 1, x: 7, y: 9, direction: 4 });
    expect(interpreter.state.frames).toBe(42);
  });

  it('evaluates the gold and item conditions the IR leaves raw', () => {
    putEvent(session, 1, {
      id: 2,
      pages: [
        {
          dsl: `
- gainGold: { operation: 0, value: 300 }
- gainItem: { itemId: 1, operation: 0, value: 2 }
- if:
    raw: [7, 200, 0]
    then:
      - say: "rich"
- if:
    raw: [8, 1]
    then:
      - say: "has potion"
- if:
    raw: [8, 2]
    then:
      - say: "has something else"
`,
        },
      ],
    });

    const interpreter = new Interpreter(session);
    interpreter.runEvent(1, 2);

    expect(interpreter.state.gold).toBe(300);
    expect(interpreter.state.itemCount('item', 1)).toBe(2);
    expect(interpreter.state.messages.map((m) => m.lines[0])).toEqual(['rich', 'has potion']);
  });

  it('picks the page MZ would pick — last to first, conditions met', () => {
    putEvent(session, 1, {
      id: 5,
      pages: [
        { dsl: '- say: "page 1"' },
        { dsl: '- say: "page 2"', conditions: { switch1Valid: true, switch1Id: 20 } },
        { dsl: '- say: "page 3"', conditions: { selfSwitchValid: true, selfSwitchCh: 'A' } },
      ],
    });

    const interpreter = new Interpreter(session);
    expect(interpreter.properPageIndex(1, 5)).toBe(0);

    interpreter.state.switches.set(20, true);
    expect(interpreter.properPageIndex(1, 5)).toBe(1);

    interpreter.state.setSelfSwitch(1, 5, 'A', true);
    expect(interpreter.properPageIndex(1, 5)).toBe(2);

    interpreter.runEvent(1, 5);
    expect(interpreter.state.messages.map((m) => m.lines[0])).toEqual(['page 3']);
  });

  it('reports what it did not model instead of pretending it ran', () => {
    putEvent(session, 1, {
      id: 2,
      pages: [
        {
          dsl: `
- script: "$gameParty.gainItem($dataItems[1], 1)"
- moveRoute: { characterId: -1, route: [{ step: moveLeft }] }
- pluginCommand: { plugin: QuestSystem, command: complete, args: { id: "herb" } }
- if:
    script: "$gameSwitches.value(1)"
    then:
      - say: "never proven"
`,
        },
      ],
    });

    const interpreter = new Interpreter(session);
    interpreter.runEvent(1, 2);

    expect([...interpreter.unmodeled.keys()]).toEqual([
      'Script (355)',
      'Set Movement Route (205)',
      'Conditional Branch with a script condition (111 type 12)',
    ]);
    // A plugin command is recorded rather than noted: not running it is
    // expected, but which one was issued is assertable.
    expect(interpreter.pluginCalls).toEqual([{ plugin: 'QuestSystem', command: 'complete', args: { id: 'herb' } }]);
    expect(interpreter.state.messages).toEqual([]);
  });

  it('answers Battle Processing from the queue and runs that branch', () => {
    putEvent(session, 1, {
      id: 2,
      pages: [
        {
          dsl: `
- battle:
    troopId: 1
    canEscape: true
    canLose: true
    win:
      - say: "won"
    lose:
      - say: "lost"
`,
        },
      ],
    });

    const interpreter = new Interpreter(session, undefined, { battles: ['lose'] });
    interpreter.runEvent(1, 2);

    expect(interpreter.battles).toEqual([{ troopId: 1, outcome: 'lose' }]);
    expect(interpreter.state.messages.map((m) => m.lines[0])).toEqual(['lost']);
    // A lost battle pays nothing, so there is nothing to disclaim.
    expect([...interpreter.notes]).toEqual([]);
  });

  it('notes that a won battle paid no rewards, without calling the command unmodeled', () => {
    putEvent(session, 1, {
      id: 2,
      pages: [{ dsl: '- battle: { troopId: 1, canEscape: false, canLose: false, win: [{ say: "won" }] }' }],
    });

    const interpreter = new Interpreter(session, undefined, { battles: ['win'] });
    interpreter.runEvent(1, 2);

    // The outcome is *told* to this layer, not fought, so gold/EXP/drops/level
    // never land — and a scenario asserting "the player can afford the sword
    // after the fight" is asserting about a party that was never paid.
    expect([...interpreter.notes]).toEqual([
      'Battle rewards (gold, EXP, drops, level-up) are not modelled — the outcome is answered, not fought.',
    ]);
    // Not `unmodeled`: the command ran and picked the right branch. That
    // counter has to keep meaning "something was skipped", or a generated game
    // with one boss fight would trip it every run and teach a reader to ignore it.
    expect([...interpreter.unmodeled.keys()]).toEqual([]);
  });

  it('counts coverage over every command list in the project, not only the ones it ran', () => {
    putEvent(session, 1, {
      id: 2,
      pages: [{ dsl: '- say: "ran"' }, { dsl: '- say: "never ran"', conditions: { switch1Valid: true, switch1Id: 99 } }],
    });

    const interpreter = new Interpreter(session);
    interpreter.runEvent(1, 2, 1);
    const coverage = interpreter.coverage();

    const ran = coverage.lists.find((l) => l.key === 'Map001.json#event 2 page 1');
    const skipped = coverage.lists.find((l) => l.key === 'Map001.json#event 2 page 2');
    expect(ran).toMatchObject({ nodes: 1, visited: 1, messages: 1, messagesVisited: 1 });
    expect(skipped).toMatchObject({ nodes: 1, visited: 0, messagesVisited: 0 });
    // The fixture's own untouched event drags the project number below 100%.
    expect(coverage.percent).toBeGreaterThan(0);
    expect(coverage.percent).toBeLessThan(100);
    // …and its EV001 is structurally broken on purpose-of-history (a Break Loop
    // at the Loop's own indent), so it is named as unparsed rather than scored
    // 0% and quietly dragging the number down.
    expect(coverage.unparsed).toEqual(['Map001.json#event 1 page 1']);
  });

  it('names the list when a page will not decompile, instead of surfacing a bare parser error', () => {
    const interpreter = new Interpreter(session);
    expect(() => interpreter.runEvent(1, 1)).toThrow(/Map001\.json#event 1 page 1 does not decompile/);
  });
});
