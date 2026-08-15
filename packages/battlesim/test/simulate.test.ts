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

  /**
   * F7 (report §6/§8). Who a single-target action hits is the player's call in
   * MZ, and the licensed playtest showed it is worth as much as the skill
   * choice — the whole +15.3pp that was left after F8, on the one matchup where
   * the sides were evenly matched. Before this the report named the skill
   * policy and said nothing about targeting, so a consumer had one number and
   * no way to know which direction it was wrong in.
   */
  describe('target policy', () => {
    // Four Ogres: a long fight against enemies that hit back, which is the only
    // shape where targeting shows up at all. Against a side that dies in two
    // turns anyway, both policies clear the same total HP with the same total
    // damage and the difference is noise.
    const spec = {
      party: [{ actorId: 1, level: 45, equips: [2, 1, 0, 0, 0] }, { actorId: 2, level: 45 }],
      enemies: [3, 3, 3, 3],
      trials: 200,
      maxTurns: 60,
      seed: 5,
    };

    it('focus fire ends the fight sooner and takes far less damage doing it', () => {
      const spread = simulate(session, spec);
      const focused = simulate(session, { ...spec, targetPolicy: 'focus' });

      // Same party, same enemies, same seed: the only difference is which of
      // the living Ogres each swing lands on. Killing them one at a time
      // removes an attacker per kill instead of leaving four alive to the end,
      // which is the mechanism behind F7's +15.3pp.
      expect(focused.turns.mean).toBeLessThan(spread.turns.mean);
      expect(focused.damage.byEnemies.hits).toBeLessThan(spread.damage.byEnemies.hits * 0.85);
    });

    it('leaves enemy targeting random, because Game_Enemy really is random', () => {
      // `Game_Unit.randomTarget` is what enemies use, so "focus" is a claim
      // about how a *player* plays. Letting it drive both sides made fights
      // longer, not shorter — enemies concentrating on one party member kill
      // it, and a four-Ogre fight against one survivor runs on.
      const solo = { ...spec, party: [{ actorId: 1, level: 45, equips: [2, 1, 0, 0, 0] }], enemies: [3] };
      const outcome = ({ turns, winRate, damage }: ReturnType<typeof simulate>) => ({ turns, winRate, damage });

      // One actor, one enemy: nothing left for either policy to choose between,
      // so only the two reported policy fields may differ.
      expect(outcome(simulate(session, { ...solo, targetPolicy: 'focus' }))).toEqual(outcome(simulate(session, solo)));
    });

    it('reports which one produced the numbers, and says the other exists', () => {
      const spread = simulate(session, spec);
      const focused = simulate(session, { ...spec, targetPolicy: 'focus' });

      expect(spread.targetPolicy).toBe('random');
      expect(spread.policy).toMatch(/uniform random among living/);
      expect(spread.policy).toMatch(/targetPolicy "focus"/);

      expect(focused.targetPolicy).toBe('focus');
      expect(focused.policy).toMatch(/lowest-HP living enemy/);
      expect(focused.policy).toMatch(/targetPolicy "random"/);

      // The skill half of the policy is still reported by both.
      for (const report of [spread, focused]) {
        expect(report.policy).toMatch(/costliest affordable damaging skill/);
        expect(report.policy).toMatch(/Nobody guards, uses items, or flees/);
      }
    });
  });

  it('rejects a spec with no enemies, an unknown troop, or both sources at once', () => {
    const party = [{ actorId: 1 }];
    expect(() => simulate(session, { party, enemies: [] })).toThrow(/no enemies/);
    expect(() => simulate(session, { party, troopId: 99 })).toThrow(/Troop 99 does not exist/);
    expect(() => simulate(session, { party, troopId: 1, enemies: [1] })).toThrow(/pick one/);
    expect(() => simulate(session, { party: [], troopId: 1 })).toThrow(/empty party/);
  });
});
