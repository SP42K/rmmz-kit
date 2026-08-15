import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openProject, type Class, type ProjectSession, type Weapon } from '@rmmz-kit/core';
import { actorBattler, loadDatabase, simulate } from '../src/index.js';
import { makeTestProject } from './testProject.js';

/**
 * `TRAIT_ATTACK_TIMES` (34), report §8 F8.
 *
 * The licensed-machine run compared this simulator against a real playtest of
 * the same matchups. The one where it was worst off — 8.10 simulated turns
 * against 5.47 played — was the one where the party's weapon carried this
 * trait: MZ's stock Cestus grants +1, so a normal attack lands twice and the
 * fight is over in two thirds of the turns. It was not modeled, and it had been
 * filed in `battler.ts` under the same line as extra *action* times (61), which
 * is a different mechanic and still is not modeled.
 *
 * The fixture's weapons carry no such trait, so the test grants one: what is
 * being checked is the arithmetic (`Game_Action.numRepeats`), not MZ's content.
 */
describe('extra attack times', () => {
  let session: ProjectSession;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    const project = await makeTestProject();
    cleanup = project.cleanup;
    session = await openProject(project.dir);
  });
  afterAll(() => cleanup());

  /** +N attack times on the Sword (weapon 1), or none. */
  function withCestus(times: number): ProjectSession {
    session.updateFile<Array<Weapon | null>>('Weapons.json', (weapons) => {
      weapons[1]!.traits = times > 0 || times < 0 ? [{ code: 34, dataId: 0, value: times }] : [];
    });
    return session;
  }

  /**
   * The action policy prefers the costliest affordable damaging skill, and the
   * fixture's Warrior learns one at level 1 — so a party that keeps its skills
   * never takes a normal attack, and this trait would never come up. Taking the
   * learnings away is what makes the matchup below an *attack* matchup.
   */
  function unarmedPolicy(): void {
    session.updateFile<Array<Class | null>>('Classes.json', (classes) => {
      classes[1]!.learnings = [];
    });
  }

  it('sums trait 34 and floors it at zero', () => {
    const db = loadDatabase(withCestus(1));
    expect(actorBattler(db, { actorId: 1, level: 5, equips: [1, 1, 0, 0, 0] }).attackTimesAdd()).toBe(1);
    // Unequipped, the same actor is back to one hit.
    expect(actorBattler(db, { actorId: 1, level: 5 }).attackTimesAdd()).toBe(0);

    const negative = loadDatabase(withCestus(-3));
    expect(actorBattler(negative, { actorId: 1, level: 5, equips: [1, 1, 0, 0, 0] }).attackTimesAdd()).toBe(0);
  });

  it('doubles a normal attack, so the same fight ends in fewer turns', () => {
    unarmedPolicy();
    // Level 20 vs the Ogre: a long fight, where a doubled attack shows up in
    // the turn count rather than in a win rate already pinned at 0 or 1.
    const spec = { party: [{ actorId: 1, level: 20, equips: [1, 1, 0, 0, 0] }], troopId: 3, trials: 200, seed: 7 };

    const plain = simulate(withCestus(0), spec);
    const doubled = simulate(withCestus(1), spec);

    // Swings *per turn* is the direct claim; total hits only rises about 25%,
    // because the doubled party finishes the fight in fewer turns — which is
    // exactly the effect the licensed playtest saw and this simulator missed.
    const perTurn = (r: typeof plain) => r.damage.byParty.hits / r.turns.mean;
    expect(perTurn(doubled)).toBeGreaterThan(perTurn(plain) * 1.8);
    expect(doubled.turns.mean).toBeLessThan(plain.turns.mean * 0.8);
    expect(doubled.winRate).toBeGreaterThanOrEqual(plain.winRate);
  });

  it('adds nothing to a skill — numRepeats only counts it for a normal attack', () => {
    // The Mage keeps her learnings, so she never takes a normal attack: the
    // trait on her weapon slot must make no difference at all.
    const spec = { party: [{ actorId: 2, level: 20, equips: [1, 0, 0, 0, 0] }], troopId: 3, trials: 100, seed: 3 };

    expect(simulate(withCestus(3), spec)).toEqual(simulate(withCestus(0), spec));
  });
});
