//=============================================================================
// AutoTest.js — rmmz-kit headless/automation hooks (plan §3 M8)
//=============================================================================
/*:
 * @target MZ
 * @plugindesc Exposes window.__AT so a driver can drive the game's state machine directly instead of pressing keys.
 * @author rmmz-kit
 *
 * @help
 * Install with the MCP `playtest` tool's `install-autotest` action, or copy this
 * file to js/plugins/ and add it to js/plugins.js.
 *
 * Everything here goes through MZ's own objects ($gameSwitches, $gameMap's
 * interpreter, SceneManager's logical frame) rather than synthesising input:
 * plan §4.6 rejects the walk-there-and-press-Enter route because MZ draws to a
 * canvas, so there is no DOM to assert against and no way to sync without
 * sleeping. Bypassing the UI costs input-layer coverage (key bindings, menu
 * navigation) — which is not where generated content breaks.
 *
 * Turn this OFF before shipping: it is a remote control for the whole game.
 */
(() => {
  'use strict';

  const messages = [];
  const coverage = Object.create(null);

  // Show Text goes through Game_Message.add whatever draws it, so this catches
  // the text a scene never got round to rendering as well as the text it did.
  const addText = Game_Message.prototype.add;
  Game_Message.prototype.add = function (text) {
    messages.push({ speaker: this.speakerName(), face: this.faceName(), text });
    addText.call(this, text);
  };

  // Coverage is keyed the way the headless event-layer runner keys it, so the
  // two halves of M8 report the same shape: one entry per command list.
  const executeCommand = Game_Interpreter.prototype.executeCommand;
  Game_Interpreter.prototype.executeCommand = function () {
    const key = `map ${$gameMap ? $gameMap.mapId() : 0}#event ${this.eventId()}`;
    const seen = coverage[key] || (coverage[key] = {});
    seen[this._index] = (seen[this._index] || 0) + 1;
    return executeCommand.call(this);
  };

  function currentInterpreter() {
    // A running event owns the interpreter; when nothing is running, the map's
    // is idle and free to be set up with a list of our choosing.
    return $gameMap._interpreter;
  }

  const AT = {
    /** Reserve a transfer; it lands on the next logical frame, so follow with step()/waitIdle(). */
    teleport(mapId, x, y, direction = 2) {
      $gamePlayer.reserveTransfer(mapId, x, y, direction, 0);
    },

    /**
     * Run an event's page right now without walking to it. `page` is 1-based;
     * omitted, MZ's own last-to-first condition match picks it.
     */
    runEvent(mapId, eventId, page) {
      if ($gameMap.mapId() !== mapId) {
        throw new Error(`runEvent: map ${mapId} is not loaded (current: ${$gameMap.mapId()}); teleport first`);
      }
      const event = $gameMap.event(eventId);
      if (!event) throw new Error(`runEvent: map ${mapId} has no event ${eventId}`);
      // Optional chaining, or an out-of-range page is a bare TypeError from the
      // property read and the message below never gets to say which page.
      const list = page ? event.event().pages[page - 1]?.list : event.list();
      if (!list) throw new Error(`runEvent: map ${mapId} event ${eventId} has no page ${page || '(matching one)'}`);
      currentInterpreter().setup(list, eventId);
    },

    runCommonEvent(id) {
      const data = $dataCommonEvents[id];
      if (!data) throw new Error(`runCommonEvent: common event ${id} does not exist`);
      currentInterpreter().setup(data.list, 0);
    },

    setSwitch(id, value) {
      $gameSwitches.setValue(id, value);
    },
    getSwitch(id) {
      return $gameSwitches.value(id);
    },
    setVar(id, value) {
      $gameVariables.setValue(id, value);
    },
    getVar(id) {
      return $gameVariables.value(id);
    },
    setSelfSwitch(mapId, eventId, ch, value) {
      $gameSelfSwitches.setValue([mapId, eventId, ch], value);
    },
    getSelfSwitch(mapId, eventId, ch) {
      return $gameSelfSwitches.value([mapId, eventId, ch]);
    },
    partyHasItem(itemId) {
      return $gameParty.numItems($dataItems[itemId]) > 0;
    },

    /**
     * Full snapshot, not a whitelist: the caller is a test driver, and the one
     * field it cannot ask for is the one the bug is hiding in.
     */
    dumpState() {
      return {
        mapId: $gameMap.mapId(),
        player: { x: $gamePlayer.x, y: $gamePlayer.y, direction: $gamePlayer.direction() },
        switches: $gameSwitches._data.slice(),
        variables: $gameVariables._data.slice(),
        selfSwitches: Object.assign({}, $gameSelfSwitches._data),
        gold: $gameParty.gold(),
        items: $gameParty.items().map((item) => ({ id: item.id, count: $gameParty.numItems(item) })),
        weapons: $gameParty.weapons().map((item) => ({ id: item.id, count: $gameParty.numItems(item) })),
        armors: $gameParty.armors().map((item) => ({ id: item.id, count: $gameParty.numItems(item) })),
        party: $gameParty.members().map((actor) => ({
          id: actor.actorId(),
          level: actor.level,
          hp: actor.hp,
          mp: actor.mp,
          states: actor.states().map((state) => state.id),
        })),
        eventRunning: $gameMap.isEventRunning(),
        messageBusy: $gameMessage.isBusy(),
        frames: Graphics.frameCount,
      };
    },

    /** Fixed randomness (mulberry32) — MZ's own Math.randomInt goes through Math.random. */
    seed(n) {
      let state = n >>> 0;
      Math.random = function () {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    },

    /**
     * Advance N logical frames. `SceneManager.updateMain` is the tick without
     * the rAF/frame-pacing around it, so a test runs as fast as the CPU allows
     * instead of at 60fps (plan §3 M8's "60fps 主迴圈太慢" row).
     */
    step(frames = 1) {
      for (let i = 0; i < frames; i++) SceneManager.updateMain();
    },

    /**
     * Step until no event is running and no message is waiting for input.
     * Messages auto-advance while waiting (Window_Message treats every frame as
     * a confirm press) — otherwise the very first Show Text deadlocks the run.
     */
    waitIdle(maxFrames = 600) {
      const wasTriggered = Window_Message.prototype.isTriggered;
      Window_Message.prototype.isTriggered = () => true;
      try {
        for (let i = 0; i < maxFrames; i++) {
          if (!$gameMap.isEventRunning() && !$gameMessage.isBusy() && !$gamePlayer.isTransferring()) return true;
          SceneManager.updateMain();
        }
      } finally {
        Window_Message.prototype.isTriggered = wasTriggered;
      }
      return false;
    },

    /** Everything Show Text has produced since the last call; clears the buffer. */
    captureMessages() {
      return messages.splice(0, messages.length);
    },

    /** Per command list: how many of its commands have executed at least once. */
    coverage() {
      const out = {};
      for (const key of Object.keys(coverage)) out[key] = Object.keys(coverage[key]).length;
      return out;
    },
  };

  window.__AT = AT;
})();
