import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProject, openProject, type MapData, type Tileset } from '@rmmz-kit/core';
import { checkRuntime } from '../src/rules/runtime.js';
import { makeTestProject } from './testProject.js';

/**
 * Both rules here exist because the toolchain was run against a real licensed
 * MZ install and the result did not boot / could be walked through its own
 * walls. The fixture is the "never saved by the editor" project in miniature:
 * its System.json has four fields, exactly like the editor's own `NewData`
 * before a first save.
 */
describe('checkRuntime', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  const openFixture = async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    return openProject(dir);
  };

  it('names every System.json field the engine dereferences with no fallback', async () => {
    const session = await openFixture();
    const findings = checkRuntime(session).filter((f) => f.rule === 'runtime/missing-system-field');

    expect(findings.map((f) => f.path)).toEqual(['advanced', 'itemCategories', 'titleCommandWindow', 'sounds']);
    expect(findings.every((f) => f.severity === 'error')).toBe(true);
    // The one that cost an afternoon: it is a black screen, not a missing
    // feature, so the message has to say which call site dies.
    expect(findings[0].message).toContain('advanced');
  });

  it('says nothing once those fields are there', async () => {
    const session = await openFixture();
    session.updateFile<Record<string, unknown>>('System.json', (data) => ({
      ...data,
      advanced: { windowOpacity: 192, screenWidth: 816, screenHeight: 624, uiAreaWidth: 816, uiAreaHeight: 624 },
      itemCategories: [true, true, true, true],
      titleCommandWindow: { background: 0, offsetX: 0, offsetY: 0 },
      sounds: Array.from({ length: 24 }, () => ({ name: '', pan: 0, pitch: 100, volume: 90 })),
    }));

    expect(checkRuntime(session).filter((f) => f.rule === 'runtime/missing-system-field')).toEqual([]);
  });

  /**
   * F2 (report §8): `create_project`'s own output crashed in `Scene_Title` on a
   * licensed machine while this rule reported it clean — the template was
   * missing the field *and* the rule was not looking for it. Both halves are
   * pinned here, because fixing either one alone leaves the bug shipping.
   */
  describe('the created project boots (F2)', () => {
    it('a project from the bundled template has every field the rule names', async () => {
      const parent = await mkdtemp(path.join(tmpdir(), 'rmmz-tmpl-'));
      cleanups.push(() => rm(parent, { recursive: true, force: true }));
      const dir = path.join(parent, 'FromTemplate');
      await createProject(dir, { title: 'From Template', git: false });

      const session = await openProject(dir);
      expect(checkRuntime(session).filter((f) => f.severity === 'error')).toEqual([]);

      const system = session.readFile<Record<string, unknown>>('System.json');
      // Not crashes, but the editor writes them and their absence is either a
      // missing feature (message skip) or a coincidence (turn-based battle).
      expect(system.titleCommandWindow).toEqual({ background: 0, offsetX: 0, offsetY: 0 });
      expect(system.optMessageSkip).toBe(true);
      expect(system.battleSystem).toBe(0);
      expect(system.optSplashScreen).toBe(false);
    });

    it('catches a System.json whose titleCommandWindow was removed', async () => {
      const session = await openFixture();
      session.updateFile<Record<string, unknown>>('System.json', (data) => ({
        ...data,
        advanced: { windowOpacity: 192, screenWidth: 816, screenHeight: 624, uiAreaWidth: 816, uiAreaHeight: 624 },
        itemCategories: [true, true, true, true],
        sounds: Array.from({ length: 24 }, () => ({ name: '', pan: 0, pitch: 100, volume: 90 })),
      }));

      const findings = checkRuntime(session).filter((f) => f.rule === 'runtime/missing-system-field');

      expect(findings.map((f) => f.path)).toEqual(['titleCommandWindow']);
      expect(findings[0].severity).toBe('error');
      expect(findings[0].message).toContain('Scene_Title');
    });
  });

  it('flags a map nothing on which blocks the player, and stops once one tile does', async () => {
    const session = await openFixture();
    // The fixture's tileset has all-zero flags, which reads as "passable
    // everywhere, walls included" — the state a generated map re-pointed at a
    // stock tileset ends up in.
    expect(checkRuntime(session).filter((f) => f.rule === 'runtime/map-all-passable')).not.toEqual([]);

    const map = session.readFile<MapData>('Map001.json');
    session.updateFile<Array<Tileset | null>>('Tilesets.json', (data) => {
      // ★ on tile 0 so the empty upper layers abstain (as every stock tileset
      // does), then block the ground tile the map is drawn with.
      data[map.tilesetId]!.flags[0] = 0x10;
      data[map.tilesetId]!.flags[map.data[0]] = 0xf;
    });

    expect(checkRuntime(session).filter((f) => f.rule === 'runtime/map-all-passable')).toEqual([]);
  });
});
