import { describe, expect, it } from 'vitest';
import type { EventCommand } from '@rmmz-kit/core';
import { compile } from '../src/emit.js';
import { decompile } from '../src/decompile.js';

/**
 * Shapes the *editor* writes that this compiler got wrong, found by running it
 * over RPG Maker MZ's own `samplemaps` and `newdata` on a licensed machine
 * (report §5, 2498 real command lists).
 *
 * Every fixture here is **hand-written from the recorded shape**, not copied:
 * a parameter layout is a fact about the format, but MZ's sample content is
 * KADOKAWA's, and this repo ships none of it. What that costs is coverage —
 * these lists are minimal reproductions, not the real ones — so an opt-in
 * corpus run against an installed copy stays the way to re-measure the
 * percentages quoted in emit.ts.
 */
describe('shapes the editor writes', () => {
  /**
   * F5. The editor ends some Conditional Branch bodies with a `{code:0}` at the
   * body's own indent — the same filler it writes inside every choice branch.
   * `decompile` only tolerated it after 402/403, so five real lists threw
   * `Expected code 412 at indent 0 ... got code 0 indent 1`, which takes down
   * `rmmz://map/{id}` for the whole map, `apply_script` on any of its events,
   * and shows up as a false structure finding in `validate`.
   */
  describe('a {code:0} filler ending a Conditional Branch body (F5)', () => {
    // The shape of samplemaps/Map105.json#event 22 page 1: a switch check whose
    // then- and else-bodies each play an SE, transfer the player, and are then
    // padded with the filler.
    const se = { name: 'Move1', volume: 90, pitch: 100, pan: 0 };
    const editorList: EventCommand[] = [
      { code: 111, indent: 0, parameters: [0, 6, 0] },
      { code: 250, indent: 1, parameters: [se] },
      { code: 201, indent: 1, parameters: [0, 174, 11, 2, 0, 0] },
      { code: 0, indent: 1, parameters: [] },
      { code: 411, indent: 0, parameters: [] },
      { code: 250, indent: 1, parameters: [se] },
      { code: 201, indent: 1, parameters: [0, 174, 11, 20, 0, 0] },
      { code: 0, indent: 1, parameters: [] },
      { code: 412, indent: 0, parameters: [] },
      { code: 0, indent: 0, parameters: [] },
    ];

    it('decompiles instead of throwing, with both bodies intact', () => {
      const nodes = decompile(editorList);

      expect(nodes).toHaveLength(1);
      const node = nodes[0];
      expect(node.kind).toBe('if');
      if (node.kind !== 'if') return;
      // The filler is padding, not a command: it must not become a RawNode in
      // either body, or `apply_script` would write it back doubled.
      expect(node.then.map((n) => n.kind)).toEqual(['playSe', 'transfer']);
      expect(node.else?.map((n) => n.kind)).toEqual(['playSe', 'transfer']);
      expect(node.then[1]).toMatchObject({ kind: 'transfer', mapId: 174, x: 11, y: 2 });
      expect(node.else?.[1]).toMatchObject({ kind: 'transfer', mapId: 174, x: 11, y: 20 });
    });

    it('re-emits without the filler — semantically identical, not byte-identical', () => {
      const emitted = compile(decompile(editorList));

      expect(emitted).toEqual(editorList.filter((c) => !(c.code === 0 && c.indent === 1)));
      // ...and that normalized list is a fixed point, which is the property
      // `apply_script` actually depends on (edit, write, read back, edit again).
      expect(compile(decompile(emitted))).toEqual(emitted);
    });

    it('tolerates the same filler in a loop body and under an unmodeled structural command', () => {
      const inLoop: EventCommand[] = [
        { code: 112, indent: 0, parameters: [] },
        { code: 230, indent: 1, parameters: [5] },
        { code: 0, indent: 1, parameters: [] },
        { code: 413, indent: 0, parameters: [] },
        { code: 0, indent: 0, parameters: [] },
      ];
      expect(decompile(inLoop)).toEqual([{ kind: 'loop', body: [{ kind: 'wait', frames: 5 }] }]);

      // 9999 stands in for the class this is really about: a plugin-added or
      // Tier 3 structural command whose body MZ indents, which RawNode.body
      // absorbs.
      const underRaw: EventCommand[] = [
        { code: 9999, indent: 0, parameters: [1] },
        { code: 230, indent: 1, parameters: [5] },
        { code: 0, indent: 1, parameters: [] },
        { code: 0, indent: 0, parameters: [] },
      ];
      expect(decompile(underRaw)).toEqual([
        { kind: 'raw', code: 9999, parameters: [1], body: [{ kind: 'wait', frames: 5 }] },
      ]);
    });
  });

  /**
   * F6. The editor writes one 505 mirror row per route *step*, and none for the
   * route's trailing ROUTE_END. This wrote one for the terminator too, so every
   * emitted route pushed the following commands one row down and left a blank
   * line in the editor's event list — 68 of 2498 real lists differed, all of
   * them exactly this.
   */
  describe('505 mirror rows for a Set Movement Route (F6)', () => {
    // The shape of newdata-2/Map002.json#event 12 page 1: an SE, a route on the
    // player whose `list` is 7 long (6 steps + ROUTE_END) mirrored by 6 rows, a
    // 2-long route on this event mirrored by 1, then an SE and a transfer —
    // 13 commands, where this compiler used to write 15.
    // 1/2/3/4 = move down/left/right/up, 17 = move forward, 41/42 = turn.
    const se = { name: 'Move1', volume: 90, pitch: 100, pan: 0 };
    const playerSteps = [1, 1, 17, 17, 4, 41];
    const eventSteps = [42];
    const route = (steps: number[]) => ({
      list: [...steps.map((code) => ({ code, indent: null })), { code: 0, indent: null }],
      repeat: false,
      skippable: false,
      wait: true,
    });
    const mirrors = (steps: number[]): EventCommand[] =>
      steps.map((code) => ({ code: 505, indent: 0, parameters: [{ code, indent: null }] }));
    const editorList: EventCommand[] = [
      { code: 250, indent: 0, parameters: [se] },
      { code: 205, indent: 0, parameters: [-1, route(playerSteps)] },
      ...mirrors(playerSteps),
      { code: 205, indent: 0, parameters: [0, route(eventSteps)] },
      ...mirrors(eventSteps),
      { code: 250, indent: 0, parameters: [se] },
      { code: 201, indent: 0, parameters: [0, 4, 8, 6, 0, 0] },
      { code: 0, indent: 0, parameters: [] },
    ];

    it('round-trips byte-identically', () => {
      // 13 commands, not 15: one 505 per step, none for the two ROUTE_ENDs.
      expect(editorList).toHaveLength(13);
      expect(JSON.stringify(compile(decompile(editorList)))).toBe(JSON.stringify(editorList));
    });

    it('emits one mirror row per step, never one for the terminator', () => {
      const emitted = compile([
        { kind: 'moveRoute', characterId: -1, repeat: false, skippable: false, wait: true, route: [{ code: 1 }, { code: 4 }] },
      ]);

      const [head, ...rest] = emitted;
      expect(head.code).toBe(205);
      expect((head.parameters[1] as { list: unknown[] }).list).toHaveLength(3); // two steps + ROUTE_END
      expect(rest.filter((c) => c.code === 505).map((c) => c.parameters[0])).toEqual([
        { code: 1, indent: null },
        { code: 4, indent: null },
      ]);
    });

    it('still decompiles a list that mirrors the terminator too', () => {
      // What this compiler itself wrote before the fix: a project already
      // carrying those lists must keep opening, and re-emitting must drop the
      // extra row rather than accumulate one per edit.
      const withExtra: EventCommand[] = [
        { code: 205, indent: 0, parameters: [-1, route([1, 4])] },
        ...[1, 4, 0].map((code) => ({ code: 505, indent: 0, parameters: [{ code, indent: null }] })),
        { code: 0, indent: 0, parameters: [] },
      ];

      const emitted = compile(decompile(withExtra));

      expect(emitted.filter((c) => c.code === 505)).toHaveLength(2);
      expect(compile(decompile(emitted))).toEqual(emitted);
    });
  });
});
