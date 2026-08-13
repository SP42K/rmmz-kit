import { describe, expect, it } from 'vitest';
import type { EventCommand } from '@rmmz-kit/core';
import { compile } from '../src/emit.js';
import { decompile } from '../src/decompile.js';
import { parseDsl } from '../src/dsl/parse.js';
import { printDsl } from '../src/dsl/print.js';
import { SIMPLE_COMMANDS, SIMPLE_KINDS, type Node } from '../src/ir.js';

/**
 * Tier 2 (plan §4.3, M7.5). The fuzz in roundtrip.test.ts already proves
 * decompile(compile(x)) is stable for every node kind; what is checked here is
 * the half a fuzz can't see — that the parameter arrays actually match what
 * `Game_Interpreter` reads, since a self-consistent compiler emitting the wrong
 * operand order round-trips perfectly and breaks the game.
 */
describe('Tier 2 command shapes', () => {
  function paramsOf(node: Node): unknown[][] {
    return compile([node])
      .filter((cmd) => cmd.code !== 0)
      .map((cmd) => cmd.parameters);
  }

  it('emits the operand order Game_Interpreter reads', () => {
    // operateValue(operation, operandType, operand) — 125/126/127.
    expect(paramsOf({ kind: 'gainGold', operation: 1, operandType: 0, value: 500 })).toEqual([[1, 0, 500]]);
    expect(paramsOf({ kind: 'gainItem', itemId: 7, operation: 0, operandType: 0, value: 2 })).toEqual([[7, 0, 0, 2]]);
    expect(
      paramsOf({ kind: 'gainWeapon', weaponId: 3, operation: 1, operandType: 0, value: 1, includeEquip: true })
    ).toEqual([[3, 1, 0, 1, true]]);
    // iterateActorEx(actorType, actorId, ...) leads, the operand follows.
    expect(
      paramsOf({ kind: 'changeHp', actorType: 0, actorId: 2, operation: 0, operandType: 0, value: 100, allowDeath: false })
    ).toEqual([[0, 2, 0, 0, 100, false]]);
    expect(
      paramsOf({ kind: 'changeParameter', actorType: 0, actorId: 1, paramId: 2, operation: 0, operandType: 0, value: 5 })
    ).toEqual([[0, 1, 2, 0, 0, 5]]);
  });

  it('emits picture parameters in the order command231/232/233/235 read (Tier 3 subset)', () => {
    // showPicture: [pictureId, name, origin, positionType, x, y, scaleX, scaleY, opacity, blendMode].
    expect(
      paramsOf({
        kind: 'showPicture', pictureId: 1, name: 'sakura_smile', origin: 1, positionType: 0,
        x: 640, y: 360, scaleX: 100, scaleY: 100, opacity: 255, blendMode: 0,
      })
    ).toEqual([[1, 'sakura_smile', 1, 0, 640, 360, 100, 100, 255, 0]]);
    // movePicture: the unused slot at index 1 rides along as `reserved`;
    // duration/wait/easingType are params[10..12], exactly what command232 reads.
    expect(
      paramsOf({
        kind: 'movePicture', pictureId: 1, reserved: 0, origin: 1, positionType: 0,
        x: 200, y: 360, scaleX: 100, scaleY: 100, opacity: 255, blendMode: 0,
        duration: 30, wait: true, easingType: 3,
      })
    ).toEqual([[1, 0, 1, 0, 200, 360, 100, 100, 255, 0, 30, true, 3]]);
    expect(paramsOf({ kind: 'rotatePicture', pictureId: 1, speed: 5 })).toEqual([[1, 5]]);
    expect(paramsOf({ kind: 'erasePicture', pictureId: 1 })).toEqual([[1]]);
  });

  it('decompiles an editor-shaped Show Picture to its typed node', () => {
    const commands: EventCommand[] = [
      { code: 231, indent: 0, parameters: [3, 'kyuubi_bust', 1, 0, 960, 540, 100, 100, 255, 0] },
      { code: 0, indent: 0, parameters: [] },
    ];
    expect(decompile(commands)).toEqual([
      {
        kind: 'showPicture', pictureId: 3, name: 'kyuubi_bust', origin: 1, positionType: 0,
        x: 960, y: 540, scaleX: 100, scaleY: 100, opacity: 255, blendMode: 0,
      },
    ]);
  });

  it('mirrors a movement route into 505 rows and terminates it with ROUTE_END', () => {
    const commands = compile([
      {
        kind: 'moveRoute',
        characterId: -1,
        repeat: false,
        skippable: true,
        wait: true,
        route: [{ code: 2 }, { code: 45, parameters: ['this.setOpacity(0)'] }],
      },
    ]);

    expect(commands.slice(0, -1)).toEqual([
      {
        code: 205,
        indent: 0,
        parameters: [
          -1,
          {
            list: [
              { code: 2, indent: null },
              { code: 45, indent: null, parameters: ['this.setOpacity(0)'] },
              { code: 0, indent: null },
            ],
            repeat: false,
            skippable: true,
            wait: true,
          },
        ],
      },
      { code: 505, indent: 0, parameters: [{ code: 2, indent: null }] },
      { code: 505, indent: 0, parameters: [{ code: 45, indent: null, parameters: ['this.setOpacity(0)'] }] },
      { code: 505, indent: 0, parameters: [{ code: 0, indent: null }] },
    ]);
  });

  it('indents battle branches by one and closes them with 604', () => {
    const commands = compile([
      {
        kind: 'battle',
        designation: 0,
        troopId: 3,
        canEscape: true,
        canLose: false,
        win: [{ kind: 'wait', frames: 30 }],
        escape: [],
      },
    ]);

    expect(commands).toEqual([
      { code: 301, indent: 0, parameters: [0, 3, true, false] },
      { code: 601, indent: 0, parameters: [] },
      { code: 230, indent: 1, parameters: [30] },
      { code: 602, indent: 0, parameters: [] },
      { code: 604, indent: 0, parameters: [] },
      { code: 0, indent: 0, parameters: [] },
    ]);
    // An absent branch and an empty one are different data, so they must stay
    // different nodes: `escape: []` is a 602 with nothing in it, `lose:
    // undefined` is no 603 at all.
    expect(decompile(commands)).toEqual([
      {
        kind: 'battle',
        designation: 0,
        troopId: 3,
        canEscape: true,
        canLose: false,
        win: [{ kind: 'wait', frames: 30 }],
        escape: [],
        lose: undefined,
      },
    ]);
  });

  it('spreads shop stock over 605 rows, keeping purchaseOnly on the 302', () => {
    const commands = compile([
      {
        kind: 'shop',
        goods: [
          { type: 0, id: 1, priceType: 0, price: 0 },
          { type: 1, id: 4, priceType: 1, price: 250 },
        ],
        purchaseOnly: true,
      },
    ]);

    expect(commands.slice(0, -1)).toEqual([
      { code: 302, indent: 0, parameters: [0, 1, 0, 0, true] },
      { code: 605, indent: 0, parameters: [1, 4, 1, 250] },
    ]);
    expect(() => compile([{ kind: 'shop', goods: [], purchaseOnly: false }])).toThrow(/at least one good/);
  });

  it('joins script and plugin-command payloads the way MZ does', () => {
    expect(compile([{ kind: 'script', lines: ['const a = 1;', 'console.log(a);'] }]).slice(0, -1)).toEqual([
      { code: 355, indent: 0, parameters: ['const a = 1;'] },
      { code: 655, indent: 0, parameters: ['console.log(a);'] },
    ]);
    // The editor's third parameter is the label shown in the event list; it is
    // the command key unless the author overrode it.
    expect(paramsOf({ kind: 'pluginCommand', plugin: 'TextPicture', command: 'set', args: { text: 'hi' } })).toEqual([
      ['TextPicture', 'set', 'set', { text: 'hi' }],
    ]);
  });

  it('leaves a command with more parameters than the table models as a RawNode', () => {
    // A plugin (or a future MZ version) adding a 6th operand to Change Gold:
    // the typed node has nowhere to keep it, so decompiling to one would drop
    // it silently. RawNode keeps everything.
    const commands: EventCommand[] = [
      { code: 125, indent: 0, parameters: [0, 0, 100, 'extra'] },
      { code: 0, indent: 0, parameters: [] },
    ];
    expect(decompile(commands)).toEqual([{ kind: 'raw', code: 125, parameters: [0, 0, 100, 'extra'] }]);
    expect(compile(decompile(commands))).toEqual(commands);
  });

  it('leaves a command whose parameter types disagree with the table as a RawNode', () => {
    const commands: EventCommand[] = [
      // Show Balloon Icon with a variable-id placeholder where MZ writes a number.
      { code: 213, indent: 0, parameters: [0, '\\v[3]', false] },
      { code: 0, indent: 0, parameters: [] },
    ];
    expect(decompile(commands)).toEqual([{ kind: 'raw', code: 213, parameters: [0, '\\v[3]', false] }]);
  });

  it('fills defaults in for a parameter array shorter than the table', () => {
    const commands: EventCommand[] = [
      { code: 128, indent: 0, parameters: [2, 0, 0, 1] }, // pre-includeEquip data
      { code: 0, indent: 0, parameters: [] },
    ];
    expect(decompile(commands)).toEqual([
      { kind: 'gainArmor', armorId: 2, operation: 0, operandType: 0, value: 1, includeEquip: false },
    ]);
  });
});

describe('Tier 2 DSL', () => {
  it('round-trips every flat-parameter command through YAML', () => {
    for (const kind of SIMPLE_KINDS) {
      const node: Record<string, unknown> = { kind };
      // Values distinct from the table defaults, so a printer that quietly
      // dropped a field would fail here instead of matching by luck.
      Object.entries(SIMPLE_COMMANDS[kind].fields as Record<string, unknown>).forEach(([name, value], i) => {
        node[name] = typeof value === 'number' ? i + 1 : typeof value === 'string' ? `${name}-${i}` : true;
      });
      expect(parseDsl(printDsl([node as unknown as Node])), kind).toEqual([node]);
    }
  });

  it('accepts a bare key for a command with no parameters', () => {
    expect(parseDsl('- fadeOut:\n- breakLoop:\n')).toEqual([{ kind: 'fadeOut' }, { kind: 'breakLoop' }]);
  });

  it('names movement route steps instead of numbering them', () => {
    const nodes = parseDsl(`
- moveRoute:
    characterId: -1
    wait: true
    route:
      - moveLeft
      - { step: jump, parameters: [0, 2] }
`);
    expect(nodes).toEqual([
      {
        kind: 'moveRoute',
        characterId: -1,
        repeat: false,
        skippable: false,
        wait: true,
        route: [{ code: 2 }, { code: 14, parameters: [0, 2] }],
      },
    ]);
    expect(parseDsl(printDsl(nodes))).toEqual(nodes);
    expect(() => parseDsl('- moveRoute: { route: [moveLeftt] }')).toThrow(/Unknown move route step/);
  });

  it('round-trips the structured Tier 2 commands through YAML', () => {
    const nodes = parseDsl(`
- battle:
    troopId: 2
    canEscape: true
    win:
      - say: We won!
    lose: []
- shop:
    goods:
      - { id: 1 }
      - { type: 1, id: 3, priceType: 1, price: 400 }
- script: |-
    $gameSwitches.setValue(5, true);
    $gameMap.requestRefresh();
- pluginCommand:
    plugin: TextPicture
    command: set
    args: { text: hello }
- playBgm: { name: Town1 }
`);

    expect(nodes[0]).toMatchObject({ kind: 'battle', designation: 0, troopId: 2, canEscape: true, canLose: false, lose: [] });
    expect(nodes[1]).toEqual({
      kind: 'shop',
      goods: [
        { type: 0, id: 1, priceType: 0, price: 0 },
        { type: 1, id: 3, priceType: 1, price: 400 },
      ],
      purchaseOnly: false,
    });
    expect(nodes[2]).toEqual({ kind: 'script', lines: ['$gameSwitches.setValue(5, true);', '$gameMap.requestRefresh();'] });
    expect(nodes[3]).toEqual({ kind: 'pluginCommand', plugin: 'TextPicture', command: 'set', label: undefined, args: { text: 'hello' } });
    expect(nodes[4]).toEqual({ kind: 'playBgm', name: 'Town1', volume: 90, pitch: 100, pan: 0 });

    expect(parseDsl(printDsl(nodes))).toEqual(nodes);
    expect(decompile(compile(nodes))).toEqual(nodes);
  });

  it('rejects a mistyped key instead of dropping it', () => {
    expect(() => parseDsl('- gainGold: { valeu: 100 }')).toThrow();
    expect(() => parseDsl('- battle: { troopId: 1, wn: [] }')).toThrow();
  });

  it('degrades a structured command it cannot hold whole to RawNode, never throwing and never dropping a parameter', () => {
    // The typed nodes for 301/302/355 are the shapes MZ writes; anything else
    // (a plugin's, a truncated list) has to survive verbatim, or decompiling an
    // arbitrary project both fails and loses data.
    const noClosing304: EventCommand[] = [
      { code: 301, indent: 0, parameters: [0, 1, false, false] },
      { code: 601, indent: 0, parameters: [] },
      { code: 230, indent: 1, parameters: [30] },
      { code: 0, indent: 0, parameters: [] },
    ];
    expect(decompile(noClosing304)).toEqual([
      { kind: 'raw', code: 301, parameters: [0, 1, false, false] },
      { kind: 'raw', code: 601, parameters: [], body: [{ kind: 'wait', frames: 30 }] },
    ]);

    const oddShapes: EventCommand[] = [
      { code: 302, indent: 0, parameters: [0, 1, 0, 0, false, 'plugin extra'] },
      { code: 355, indent: 0, parameters: [] },
      { code: 0, indent: 0, parameters: [] },
    ];
    expect(decompile(oddShapes)).toEqual([
      { kind: 'raw', code: 302, parameters: [0, 1, 0, 0, false, 'plugin extra'] },
      { kind: 'raw', code: 355, parameters: [] },
    ]);
    expect(compile(decompile(oddShapes))).toEqual(oddShapes);
  });
});
