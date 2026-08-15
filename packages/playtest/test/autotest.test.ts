import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { autoTestSource } from '../src/autotest.js';

/**
 * AutoTest.js runs inside MZ, and MZ's runtime (rmmz_*.js) ships with the paid
 * editor — this repo cannot execute the real thing, so what is checkable here
 * is that the plugin loads, hooks the prototypes it claims to hook, and drives
 * them the way MZ's own API is shaped. That catches the failure mode an
 * injected plugin actually has (a typo or a renamed member taking the whole
 * game down on boot); it does not prove behaviour against a real Game_Map.
 *
 * The stubs below are deliberately dumb: each one is the smallest object with
 * the member AutoTest.js touches. A richer fake would be a second engine to
 * keep correct, and it still would not be MZ.
 */
function loadPlugin() {
  const calls: {
    updateMain: number;
    setup: unknown[][];
    transfers: unknown[][];
    channels: number;
    newGames: number;
    goto: unknown[];
    chosen: number[];
  } = {
    updateMain: 0,
    setup: [],
    transfers: [],
    channels: 0,
    newGames: 0,
    goto: [],
    chosen: [],
  };

  const switches = { _data: [] as boolean[], setValue(id: number, v: boolean) { this._data[id] = v; }, value(id: number) { return !!this._data[id]; } };
  const variables = { _data: [] as number[], setValue(id: number, v: number) { this._data[id] = v; }, value(id: number) { return this._data[id] ?? 0; } };
  const selfSwitches = {
    _data: {} as Record<string, boolean>,
    setValue(key: unknown[], v: boolean) { this._data[String(key)] = v; },
    value(key: unknown[]) { return !!this._data[String(key)]; },
  };

  const state = { eventRunning: false, messageBusy: false, choice: false, gameActive: false };

  // The macrotask AutoTest.js yields between frames. Counting channels is how
  // the test sees that waitIdle yields *per frame*; hopping through the host's
  // setImmediate keeps the resolution a real task rather than a microtask, so
  // an await that never yielded would hang instead of silently passing.
  function FakeMessageChannel(this: Record<string, unknown>) {
    calls.channels++;
    const port1: { onmessage: null | (() => void); close: () => void } = { onmessage: null, close: () => {} };
    this.port1 = port1;
    this.port2 = {
      close: () => {},
      postMessage: () => setImmediate(() => port1.onmessage?.()),
    };
  }

  const context: Record<string, unknown> = {
    MessageChannel: FakeMessageChannel,
    Scene_Map: function Scene_Map() {},
    DataManager: { setupNewGame: () => { calls.newGames++; } },
    Game_Message: function () {} as unknown as { prototype: Record<string, unknown> },
    Game_Interpreter: function () {} as unknown as { prototype: Record<string, unknown> },
    Window_Message: function () {} as unknown as { prototype: Record<string, unknown> },
    $gameSwitches: switches,
    $gameVariables: variables,
    $gameSelfSwitches: selfSwitches,
    $gameMessage: {
      isBusy: () => state.messageBusy,
      isChoice: () => state.choice,
      onChoice: (index: number) => calls.chosen.push(index),
    },
    $gameParty: {
      gold: () => 42,
      items: () => [{ id: 1 }],
      weapons: () => [],
      armors: () => [],
      numItems: () => 3,
      members: () => [{ actorId: () => 1, level: 5, hp: 100, mp: 20, states: () => [{ id: 4 }] }],
    },
    $gamePlayer: {
      x: 2,
      y: 3,
      direction: () => 2,
      isTransferring: () => false,
      reserveTransfer: (...args: unknown[]) => calls.transfers.push(args),
    },
    $gameMap: {
      mapId: () => 1,
      isEventRunning: () => state.eventRunning,
      event: (id: number) => (id === 5 ? { list: () => ['active page list'], event: () => ({ pages: [{ list: ['page 1 list'] }] }) } : null),
      _interpreter: { setup: (...args: unknown[]) => calls.setup.push(args) },
    },
    $dataItems: [null, { id: 1 }],
    $dataCommonEvents: [null, { id: 1, list: ['common list'] }],
    SceneManager: {
      updateMain: () => { calls.updateMain++; },
      // The real one is `window.top.document.hasFocus()`, which is false for
      // every automation driver — see report §8 F3.
      isGameActive: () => state.gameActive,
      goto: (scene: unknown) => calls.goto.push(scene),
      _scene: null as unknown,
    },
    Graphics: { frameCount: 123 },
  };
  (context.Game_Message as { prototype: Record<string, unknown> }).prototype = {
    add(_text: string) {},
    speakerName: () => 'Herbalist',
    faceName: () => 'Actor1',
  };
  (context.Game_Interpreter as { prototype: Record<string, unknown> }).prototype = {
    executeCommand() { return true; },
    eventId: () => 5,
    _index: 0,
  };
  (context.Window_Message as { prototype: Record<string, unknown> }).prototype = { isTriggered: () => false };
  context.window = context;

  vm.createContext(context);
  vm.runInContext(autoTestSource(), context, { filename: 'AutoTest.js' });
  return { at: (context as { __AT: any }).__AT, context, calls, state };
}

describe('AutoTest.js', () => {
  it('exposes the whole API the plan specifies', () => {
    const { at } = loadPlugin();
    for (const name of [
      'teleport',
      'runEvent',
      'runCommonEvent',
      'setSwitch',
      'setVar',
      'dumpState',
      'seed',
      'step',
      'waitIdle',
      'newGame',
      'answerChoice',
      'captureMessages',
      'coverage',
    ]) {
      expect(typeof at[name], name).toBe('function');
    }
  });

  it('reads and writes game state through MZ\'s own objects', () => {
    const { at, context } = loadPlugin();
    at.setSwitch(7, true);
    at.setVar(3, 12);
    at.setSelfSwitch(1, 5, 'A', true);

    expect(at.getSwitch(7)).toBe(true);
    expect(at.getVar(3)).toBe(12);
    expect(at.getSelfSwitch(1, 5, 'A')).toBe(true);
    expect((context.$gameSwitches as { _data: boolean[] })._data[7]).toBe(true);
  });

  it('captures Show Text through the Game_Message hook and clears the buffer', () => {
    const { at, context } = loadPlugin();
    const message = Object.create((context.Game_Message as { prototype: object }).prototype);
    message.add('Hello');
    message.add('again');

    expect(at.captureMessages()).toEqual([
      { speaker: 'Herbalist', face: 'Actor1', text: 'Hello' },
      { speaker: 'Herbalist', face: 'Actor1', text: 'again' },
    ]);
    expect(at.captureMessages()).toEqual([]);
  });

  it('counts each command list\'s executed commands through the interpreter hook', () => {
    const { at, context } = loadPlugin();
    const interpreter = Object.create((context.Game_Interpreter as { prototype: object }).prototype);
    interpreter._index = 0;
    interpreter.executeCommand();
    interpreter._index = 1;
    interpreter.executeCommand();
    interpreter.executeCommand(); // same index again — covered once, not twice

    expect(at.coverage()).toEqual({ 'map 1#event 5': 2 });
  });

  it('sets up the requested page on the map interpreter instead of walking to it', () => {
    const { at, calls } = loadPlugin();
    at.runEvent(1, 5);
    at.runEvent(1, 5, 1);

    expect(calls.setup).toEqual([
      [['active page list'], 5],
      [['page 1 list'], 5],
    ]);
    expect(() => at.runEvent(2, 5)).toThrow(/not loaded/);
    expect(() => at.runEvent(1, 9)).toThrow(/no event 9/);
  });

  it('seeds Math.random reproducibly', () => {
    const { at, context } = loadPlugin();
    // Math is the vm context's own intrinsic, not a property of the object we
    // handed it, so the roll has to happen inside the context.
    const roll = () => vm.runInContext('Math.random()', context) as number;
    at.seed(42);
    const first = [roll(), roll()];
    at.seed(42);
    expect([roll(), roll()]).toEqual(first);
    expect(first[0]).not.toBe(first[1]);
  });

  it('steps logical frames and stops waiting once the game is idle', async () => {
    const { at, calls, state } = loadPlugin();
    at.step(3);
    expect(calls.updateMain).toBe(3);

    state.eventRunning = true;
    expect(await at.waitIdle(5)).toBe(false);
    expect(calls.updateMain).toBe(8);

    state.eventRunning = false;
    expect(await at.waitIdle(5)).toBe(true);
    expect(calls.updateMain).toBe(8);
  });

  it('restores Window_Message.isTriggered after auto-advancing messages', async () => {
    const { at, context, state } = loadPlugin();
    const prototype = (context.Window_Message as { prototype: { isTriggered: () => boolean } }).prototype;
    const before = prototype.isTriggered;
    state.eventRunning = true;
    await at.waitIdle(2);
    expect(prototype.isTriggered).toBe(before);
  });

  /**
   * F3/F4 (report §8). Against a real licensed runtime the plugin looked like
   * it worked — frames advanced, no error — and did nothing: `updateScene`
   * skips `_scene.update()` while `isGameActive()` is false, which it always is
   * for a driver, and the synchronous loop never let `loadMapData`'s fetch
   * resolve. Both halves are pinned here because both are invisible except
   * against an engine this repo cannot run.
   */
  describe('works in an environment with no focus and no free event loop', () => {
    it('forces isGameActive true for the duration of step(), then restores it', () => {
      const { at, context, calls } = loadPlugin();
      const manager = context.SceneManager as { isGameActive: () => boolean; updateMain: () => void };
      const before = manager.isGameActive;
      let activeDuringFrame: boolean | null = null;
      manager.updateMain = () => {
        calls.updateMain++;
        activeDuringFrame = manager.isGameActive();
      };

      at.step(1);

      // Without this the frame is a no-op: the counter climbs, the interpreter
      // does not move, and every assertion downstream reads a stale game.
      expect(activeDuringFrame).toBe(true);
      expect(manager.isGameActive).toBe(before);
      expect(manager.isGameActive()).toBe(false);
    });

    it('forces it true across waitIdle\'s awaits, then restores it', async () => {
      const { at, context, calls, state } = loadPlugin();
      const manager = context.SceneManager as { isGameActive: () => boolean; updateMain: () => void };
      const before = manager.isGameActive;
      const seen: boolean[] = [];
      manager.updateMain = () => {
        calls.updateMain++;
        seen.push(manager.isGameActive());
      };
      state.eventRunning = true;

      await at.waitIdle(3);

      expect(seen).toEqual([true, true, true]);
      expect(manager.isGameActive).toBe(before);
    });

    it('yields one macrotask per frame, through MessageChannel', async () => {
      const { at, calls, state } = loadPlugin();
      state.eventRunning = true;

      const promise = at.waitIdle(4);
      // Synchronous up to the first await only: proof the loop actually
      // suspends instead of burning all four frames in one turn.
      expect(calls.updateMain).toBe(1);
      expect(await promise).toBe(false);

      expect(calls.updateMain).toBe(4);
      expect(calls.channels).toBe(4);
    });

    it('never yields through setTimeout, which a background tab clamps to ~1s', () => {
      expect(autoTestSource()).toMatch(/new MessageChannel\(\)/);
      // A *call*, not the word: the comment above nextMacrotask names the trap.
      expect(autoTestSource()).not.toMatch(/setTimeout\s*\(/);
    });
  });

  describe('the two things a driver otherwise cannot reach', () => {
    it('starts a new game the way Scene_Title.commandNewGame does', () => {
      const { at, calls, context } = loadPlugin();

      at.newGame();

      expect(calls.newGames).toBe(1);
      expect(calls.goto).toEqual([context.Scene_Map]);
    });

    it('answers a waiting Show Choices through the choice window when there is one', () => {
      const { at, context, state, calls } = loadPlugin();
      const selected: number[] = [];
      let okCalls = 0;
      (context.SceneManager as { _scene: unknown })._scene = {
        _choiceListWindow: { select: (i: number) => selected.push(i), processOk: () => { okCalls++; } },
      };

      expect(() => at.answerChoice(0)).toThrow(/no Show Choices/);

      state.choice = true;
      at.answerChoice(1);

      // Through the window, because that is what closes the message the way a
      // player's Enter closes it — onChoice alone picks the branch and leaves
      // the window open.
      expect(selected).toEqual([1]);
      expect(okCalls).toBe(1);
      expect(calls.chosen).toEqual([]);
    });

    it('falls back to Game_Message.onChoice when the scene has no choice window', () => {
      const { at, state, calls } = loadPlugin();
      state.choice = true;

      at.answerChoice(2);

      expect(calls.chosen).toEqual([2]);
    });
  });

  it('dumps the full state rather than a whitelist', () => {
    const { at } = loadPlugin();
    at.setSwitch(2, true);
    expect(at.dumpState()).toMatchObject({
      mapId: 1,
      player: { x: 2, y: 3, direction: 2 },
      gold: 42,
      items: [{ id: 1, count: 3 }],
      party: [{ id: 1, level: 5, hp: 100, states: [4] }],
      frames: 123,
    });
  });
});
