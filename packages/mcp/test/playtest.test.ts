import { afterEach, describe, expect, it } from 'vitest';
import { openProject, type ProjectSession } from '@rmmz-kit/core';
import * as tools from '../src/tools.js';
import { makeTestProject } from './testProject.js';

/** M8's two tools (plan §4.5's `playtest` and `coverage`, the latter folded into the scenario report). */
describe('playtest tools', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  async function session(): Promise<ProjectSession> {
    const project = await makeTestProject();
    const opened = await openProject(project.dir);
    // The server is process-global on purpose (see tools.playtest); stopping it
    // per test is what keeps that from leaking a port into the next one.
    cleanups.push(async () => {
      await tools.playtest(opened, 'stop');
      await project.cleanup();
    });
    return opened;
  }

  it('starts one server, reports it, and stops it', async () => {
    const s = await session();

    const started = (await tools.playtest(s, 'start')) as { url: string; running: boolean };
    expect(started.running).toBe(true);

    // Second start is the same server, not a second orphaned port.
    expect((await tools.playtest(s, 'start')) as { url: string }).toMatchObject({ url: started.url });
    expect(await tools.playtest(s, 'status')).toMatchObject({ running: true });

    const res = await fetch(`${started.url}data/System.json`);
    expect(res.status).toBe(200);

    expect(await tools.playtest(s, 'stop')).toEqual({ running: false });
    expect(await tools.playtest(s, 'status')).toEqual({ running: false });
  });

  it('stages AutoTest.js and enables it in js/plugins.js', async () => {
    const s = await session();

    const result = (await tools.playtest(s, 'install-autotest')) as { file: string; plugins: string[] };
    expect(result.file).toBe('js/plugins/AutoTest.js');
    expect(result.plugins).toContain('AutoTest');

    expect(await s.readRaw('js/plugins/AutoTest.js')).toContain('window.__AT');
    expect(await s.readRaw('js/plugins.js')).toContain('"AutoTest"');
    // Staged like every other change — nothing on disk until commit().
    expect(s.rawWriteFiles()).toEqual(expect.arrayContaining(['js/plugins/AutoTest.js', 'js/plugins.js']));
  });

  it('runs a scenario against an event the same session just wrote', async () => {
    const s = await session();

    tools.upsertMapEvent(s, 1, { id: 20, name: 'Chest', x: 4, y: 4, pages: [{}] });
    tools.applyScript(
      s,
      { map: 1, event: 20, page: 1 },
      `
- say: "You found 50 gold!"
- gainGold: { operation: 0, value: 50 }
- setSelfSwitch: { ch: A, value: true }
`
    );

    const report = tools.runScenarioTool(s, {
      name: 'chest',
      steps: [
        { action: 'runEvent', map: 1, event: 20 },
        { action: 'expect', expect: { gold: { value: 50 }, message: 'You found', selfSwitch: { map: 1, event: 20, ch: 'A', value: true } } },
      ],
    });

    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.coverage.lists.some((l) => l.key === 'Map001.json#event 20 page 1' && l.visited === 3)).toBe(true);
  });
});
