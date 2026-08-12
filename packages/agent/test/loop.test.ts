import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openProject, type MapData, type ProjectSession } from '@rmmz-kit/core';
import { RepairLoop, runRepairLoop } from '../src/loop.js';
import { makeTestProject } from './testProject.js';
import { HERBALIST_PAGE1, HERBALIST_PAGE2, herbQuest, PATCH_PAGE1, PATCH_PAGE2, putEvent, SUITE } from './quest.js';

const execFileAsync = promisify(execFile);

/** The herbalist with its quest-starting switch removed — the bug every test here repairs. */
function breakHerbalist(session: ProjectSession): void {
  putEvent(session, 1, {
    id: 10,
    name: 'Herbalist',
    x: 3,
    y: 4,
    pages: [{ dsl: '- say: "There are herbs in the north forest."' }, HERBALIST_PAGE2],
  });
}

function fixHerbalist(session: ProjectSession): void {
  putEvent(session, 1, { id: 10, name: 'Herbalist', x: 3, y: 4, pages: [HERBALIST_PAGE1, HERBALIST_PAGE2] });
}

describe('repair loop', () => {
  let project: { dir: string; cleanup: () => Promise<void> };
  let session: ProjectSession;

  beforeEach(async () => {
    project = await makeTestProject();
    session = await openProject(project.dir);
    herbQuest(session);
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it('reports a clean start, so a generator writes its first draft against the real state', async () => {
    const status = await new RepairLoop(session, { scenarios: SUITE }).start();

    expect(status.outcome).toBe('clean');
    expect(status.feedback).toBe('');
    expect(status.summary).toContain('2 scenario(s) pass');
  });

  it('excuses findings that were already there, so pre-existing lint noise cannot block convergence', async () => {
    // The fixture's own EV001 is structurally broken (a Break Loop at the loop's
    // own indent) — a real project always has some of this, and a loop that
    // blames the generator for it spends all three attempts on someone else's bug.
    const loop = new RepairLoop(session, { scenarios: SUITE });
    expect((await loop.start()).outcome).toBe('clean');
    expect((await loop.check()).outcome).toBe('converged');
  });

  it('converges: bug → feedback → fix → commit', async () => {
    breakHerbalist(session);

    const seen: string[] = [];
    const result = await runRepairLoop(session, { scenarios: SUITE, commitMessage: 'fix: herbalist' }, (status) => {
      seen.push(status.feedback);
      if (status.outcome === 'repairing') fixHerbalist(session);
    });

    expect(result.outcome).toBe('converged');
    expect(result.attempt).toBe(1);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    // The first callback saw the baseline diagnosis, which named the failure.
    expect(seen[0]).toContain('switch 10: expected true, got false');
    // And it landed on disk, since convergence is the only thing that commits.
    const written = JSON.parse(await readFile(path.join(project.dir, 'data', 'Map001.json'), 'utf-8')) as MapData;
    expect(JSON.stringify(written.events[10])).toContain('There are herbs in the north forest —');
  });

  it('writes nothing when it never converges', async () => {
    breakHerbalist(session);

    const result = await runRepairLoop(session, { scenarios: SUITE, maxAttempts: 2 }, () => {
      /* a generator that never fixes anything */
    });

    expect(result.outcome).toBe('oscillating');
    const written = JSON.parse(await readFile(path.join(project.dir, 'data', 'Map001.json'), 'utf-8')) as MapData;
    expect(written.events[10]).toBeUndefined();
    expect(session.dirtyFiles()).toContain('Map001.json'); // still in memory, not the loop's to discard
  });

  it('stops on oscillation instead of burning the remaining attempts', async () => {
    breakHerbalist(session);
    const loop = new RepairLoop(session, { scenarios: SUITE, maxAttempts: 5 });
    await loop.start();

    expect((await loop.check()).outcome).toBe('repairing');
    const result = await loop.check(); // same failure set as attempt 1
    expect(result.outcome).toBe('oscillating');
    expect(result.repeatOf).toBe(1);
    expect(result.summary).toContain('escalate to a human');
  });

  it('detects an A/B oscillation, not just a stuck one', async () => {
    const loop = new RepairLoop(session, { scenarios: SUITE, maxAttempts: 6 });
    await loop.start();

    breakHerbalist(session); // failure A
    expect((await loop.check()).outcome).toBe('repairing');
    fixHerbalist(session);
    putEvent(session, 1, { id: 11, name: 'HerbPatch', x: 9, y: 2, pages: [{ dsl: '- say: "Picked a herb."' }, PATCH_PAGE2] }); // failure B
    expect((await loop.check()).outcome).toBe('repairing');
    putEvent(session, 1, { id: 11, name: 'HerbPatch', x: 9, y: 2, pages: [PATCH_PAGE1, PATCH_PAGE2] });
    breakHerbalist(session); // back to A

    const result = await loop.check();
    expect(result.outcome).toBe('oscillating');
    expect(result.repeatOf).toBe(1);
  });

  it('gives up at the attempt cap', async () => {
    breakHerbalist(session);
    const loop = new RepairLoop(session, { scenarios: SUITE, maxAttempts: 2 });
    await loop.start();

    // Two different failures, so oscillation never fires and the cap is what stops it.
    expect((await loop.check()).outcome).toBe('repairing');
    fixHerbalist(session);
    putEvent(session, 1, { id: 12, name: 'Gatekeeper', x: 8, y: 11, pages: [{ dsl: '- say: "Go on through."' }] });

    const result = await loop.check();
    expect(result.outcome).toBe('exhausted');
    expect(result.summary).toContain('Gave up after 2 attempts');
    // Terminal is terminal: calling again returns the verdict, not attempt 3.
    expect((await loop.check()).outcome).toBe('exhausted');
  });

  it('runs the whole suite every attempt, so a repair that breaks an earlier quest is caught', async () => {
    const loop = new RepairLoop(session, { scenarios: SUITE });
    await loop.start();

    // Dropping the patch's gating condition still passes the whole quest chain
    // — and makes the herb pickable before anyone asks for it, which only the
    // other scenario looks at. Plan §3 M9's 「跑全套，不是只跑失敗那條」.
    putEvent(session, 1, {
      id: 11,
      name: 'HerbPatch',
      x: 9,
      y: 2,
      pages: [{ ...PATCH_PAGE1, conditions: {} }, PATCH_PAGE2],
    });

    const result = await loop.check();
    expect(result.outcome).toBe('repairing');
    expect(result.feedback).toContain('SCENARIO "herb patch is inert before the quest" — FAILED');
    expect(result.feedback).toContain('SCENARIO "herb quest" — passed.');
  });

  it('short-circuits the suite when the validator rejects the project', async () => {
    const loop = new RepairLoop(session, { scenarios: SUITE });
    await loop.start();
    putEvent(session, 1, { id: 13, name: 'Broken', pages: [{ dsl: '- callCommonEvent: 999' }] });

    const result = await loop.check();
    expect(result.feedback).toContain('STATIC GATE');
    expect(result.feedback).toContain('references/dangling-commonEvent');
    // The location is translated into what the edit tools take, not left as a JSON path.
    expect(result.feedback).toContain('edit map 1 event 13');
    expect(result.scenarios).toEqual([]);
  });

  it('names what the last edit moved — and when it moved nothing', async () => {
    breakHerbalist(session);
    const loop = new RepairLoop(session, { scenarios: SUITE });
    await loop.start();

    // An edit that touches nothing the failing scenario reads.
    putEvent(session, 1, { id: 14, name: 'Bystander', pages: [{ dsl: '- say: "Nice weather."' }] });
    expect((await loop.check()).feedback).toContain('state is identical to the baseline');

    // An edit that moves state but still does not fix it — the diff is how a
    // generator sees that, rather than re-reading its own DSL.
    putEvent(session, 1, {
      id: 10,
      name: 'Herbalist',
      x: 3,
      y: 4,
      pages: [{ dsl: '- gainGold: { operation: 0, value: 5 }' }, HERBALIST_PAGE2],
    });
    expect((await loop.check()).feedback).toContain('gold: 0 -> 5');
  });

  it('commits onto its own branch when asked', async () => {
    breakHerbalist(session);
    const result = await runRepairLoop(session, { scenarios: SUITE, branch: 'repair/herb' }, (status) => {
      if (status.outcome === 'repairing') fixHerbalist(session);
    });

    expect(result.outcome).toBe('converged');
    expect(result.branch).toBe('repair/herb');
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: project.dir });
    expect(stdout.trim()).toBe('repair/herb');
  });
});
