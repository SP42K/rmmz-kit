import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openProject } from '@rmmz-kit/core';
import type { ProjectSession } from '@rmmz-kit/core';
import { simulate } from '../src/index.js';
import { makeTestProject } from './testProject.js';

// One fixture copy for the whole file — see action.test.ts.
let session: ProjectSession;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const project = await makeTestProject();
  cleanup = project.cleanup;
  session = await openProject(project.dir);
});
afterAll(() => cleanup());

describe('simulate', () => {
  it('reports a winnable fight, and is reproducible for a seed', () => {
    const spec = {
      party: [{ actorId: 1, level: 5, equips: [1, 1, 0, 0, 0] }],
      troopId: 1, // one Slime
      trials: 300,
    };

    const report = simulate(session, spec);
    expect(report.party).toEqual(['Reid']);
    expect(report.enemies).toEqual(['Slime']);
    expect(report.winRate).toBeGreaterThan(0.9);
    expect(report.winRate + report.defeatRate + report.stalemateRate).toBeCloseTo(1);
    expect(report.ttk.enemies).not.toBeNull();
    expect(report.ttk.enemies!).toBeGreaterThan(1);
    expect(report.damage.byParty.hits).toBeGreaterThan(0);
    expect(report.damage.byParty.median).toBeGreaterThan(0);
    expect(report.damage.byParty.misses).toBeGreaterThan(0); // 95% hit rate over ~1k swings

    expect(simulate(session, spec)).toEqual(report);
    expect(simulate(session, { ...spec, seed: 42 })).not.toEqual(report);
  });

  it('scales with the party: a level 5 solo loses the fight a level 40 party wins', () => {
    const weak = simulate(session, {
      party: [{ actorId: 1, level: 5, equips: [1, 1, 0, 0, 0] }],
      troopId: 3, // the Ogre
      trials: 200,
    });
    const strong = simulate(session, {
      party: [
        { actorId: 1, level: 40, equips: [2, 1, 0, 0, 0] },
        { actorId: 2, level: 40 },
      ],
      troopId: 3,
      trials: 200,
    });

    expect(weak.winRate).toBeLessThan(0.1);
    expect(strong.winRate).toBeGreaterThan(weak.winRate);
  });

  it('flags a one-shot kill and a stalemate', () => {

    const overkill = simulate(session, {
      party: [{ actorId: 1, level: 99, equips: [2, 1, 0, 0, 0] }],
      enemies: [1],
      trials: 100,
    });
    expect(overkill.oneShotKillRate).toBe(1);
    expect(overkill.warnings.join(' ')).toMatch(/one-shot kill/);

    const stall = simulate(session, {
      party: [{ actorId: 1, level: 5, equips: [1, 1, 0, 0, 0] }],
      troopId: 3,
      trials: 50,
      maxTurns: 2,
    });
    // Not quite 1: a pair of critical hits can end even a 2-turn fight.
    expect(stall.stalemateRate).toBeGreaterThan(0.9);
    expect(stall.warnings.join(' ')).toMatch(/stall/);
  });

  it('rejects a spec with no enemies, an unknown troop, or both sources at once', () => {
    const party = [{ actorId: 1 }];
    expect(() => simulate(session, { party, enemies: [] })).toThrow(/no enemies/);
    expect(() => simulate(session, { party, troopId: 99 })).toThrow(/Troop 99 does not exist/);
    expect(() => simulate(session, { party, troopId: 1, enemies: [1] })).toThrow(/pick one/);
    expect(() => simulate(session, { party: [], troopId: 1 })).toThrow(/empty party/);
  });
});
