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
});
