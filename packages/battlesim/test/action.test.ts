import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openProject } from '@rmmz-kit/core';
import type { Skill } from '@rmmz-kit/core';
import { FormulaEvaluator, applyAction, actorBattler, enemyBattler, loadDatabase, Rng, type Database } from '../src/index.js';
import { makeTestProject } from './testProject.js';

// One fixture copy for the whole file: the simulator never writes, and a
// git-init'd copy per test costs more than every test here put together.
let db: Database;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const project = await makeTestProject();
  cleanup = project.cleanup;
  db = loadDatabase(await openProject(project.dir));
});
afterAll(() => cleanup());

/** A certain-hit (hitType 0), 100%-success skill: no hit/evade/crit rolls, so damage is exact. */
function testSkill(over: Partial<Skill> & { damage?: Partial<Skill['damage']> } = {}): Skill {
  return {
    id: 99,
    name: 'Test',
    description: '',
    iconIndex: 0,
    stypeId: 0,
    mpCost: 0,
    tpCost: 0,
    scope: 1,
    occasion: 1,
    speed: 0,
    successRate: 100,
    repeats: 1,
    tpGain: 0,
    hitType: 0,
    animationId: 0,
    effects: [],
    note: '',
    message1: '',
    message2: '',
    requiredWtypeId1: 0,
    requiredWtypeId2: 0,
    messageType: 0,
    traits: [],
    ...over,
    damage: {
      type: 1,
      elementId: 0,
      formula: 'a.atk * 4 - b.def * 2',
      variance: 0,
      critical: false,
      ...over.damage,
    },
  };
}

describe('battler', () => {
  it('builds an actor from class curve + equipment and an enemy from its params row', () => {
    const warrior = actorBattler(db, { actorId: 1, level: 1, equips: [1, 1, 0, 0, 0] });

    expect(warrior.mhp).toBe(450);
    expect(warrior.atk).toBe(25); // 15 from the class curve + 10 from the Sword
    expect(warrior.def).toBe(20); // 12 + 8 from the Shield
    expect(warrior.hit).toBeCloseTo(0.95); // class trait 22/0
    expect(actorBattler(db, { actorId: 1, level: 99 }).atk).toBe(150);

    const slime = enemyBattler(db, 1);
    expect(slime.mhp).toBe(200);
    expect(slime.elementRate(2)).toBe(2); // weak to fire
    expect(slime.elementRate(9)).toBe(1); // no trait -> neutral
  });

  it('ticks state turns and regeneration at turn end, and dies at 0 HP', () => {
    const rng = new Rng(1);
    const warrior = actorBattler(db, { actorId: 1, level: 1 });

    warrior.addState(2, rng); // Poison: hrg -10%/turn, 3-5 turns
    expect(warrior.hrg).toBeCloseTo(-0.1);
    warrior.onTurnEnd(rng);
    expect(warrior.hp).toBe(450 - 45);

    for (let turn = 0; turn < 5; turn++) warrior.onTurnEnd(rng);
    expect(warrior.isStateAffected(2)).toBe(false);

    // Slip damage clamps at 1 HP (Slip Death off is the editor default).
    warrior.gainHp(warrior.mhp, rng);
    warrior.addState(2, rng);
    warrior.gainHp(-(warrior.hp - 20), rng);
    warrior.onTurnEnd(rng);
    expect(warrior.hp).toBe(1);

    warrior.gainHp(-warrior.hp, rng);
    expect(warrior.isDead()).toBe(true);
    warrior.removeState(1);
    expect(warrior.hp).toBe(1); // Game_BattlerBase.revive()
  });
});

describe('damage', () => {
  it('reproduces makeDamageValue: formula, element rate, guard, and 0 on a broken formula', () => {
    const rng = new Rng(0);
    const formula = new FormulaEvaluator(rng);
    const warrior = actorBattler(db, { actorId: 1, level: 1, equips: [1, 1, 0, 0, 0] });

    // 25 atk * 4 - 15 def * 2 = 70
    const slime = enemyBattler(db, 1);
    expect(applyAction(formula, rng, warrior, testSkill(), slime).damage).toBe(70);
    expect(slime.hp).toBe(130);

    // Element 2 is the Slime's x2 weakness.
    const weak = enemyBattler(db, 1);
    expect(applyAction(formula, rng, warrior, testSkill({ damage: { elementId: 2 } }), weak).damage).toBe(140);

    // Guarding halves it (grd is 1.0 with no trait, so the divisor is 2).
    const guarding = enemyBattler(db, 1);
    guarding.guarding = true;
    expect(applyAction(formula, rng, warrior, testSkill(), guarding).damage).toBe(35);

    const broken = enemyBattler(db, 1);
    expect(applyAction(formula, rng, warrior, testSkill({ damage: { formula: 'b.nope(' } }), broken).damage).toBe(0);
    expect(applyAction(formula, rng, warrior, testSkill({ damage: { formula: 'process.exit(1)' } }), broken).damage).toBe(0);
    // Sandbox escapes via host-object graph traversal must fail too — if one
    // works, the process exits and this whole test file dies loudly.
    expect(
      applyAction(formula, rng, warrior, testSkill({ damage: { formula: "a.constructor.constructor('return process')().exit(1)" } }), broken).damage
    ).toBe(0);
    expect(
      applyAction(formula, rng, warrior, testSkill({ damage: { formula: "Math.floor.constructor('return process')().exit(1)" } }), broken).damage
    ).toBe(0);
  });

  it('drain (type 5) clamps to the target\'s HP and heals the attacker', () => {
    const rng = new Rng(5);
    const formula = new FormulaEvaluator(rng);
    const warrior = actorBattler(db, { actorId: 1, level: 1, equips: [1, 1, 0, 0, 0] });
    warrior.gainHp(-300, rng); // 450 -> 150
    const slime = enemyBattler(db, 1);
    slime.gainHp(-(slime.hp - 10), rng); // leave 10 HP

    const hit = applyAction(formula, rng, warrior, testSkill({ damage: { type: 5, formula: '70' } }), slime);
    expect(hit.damage).toBe(10); // clamped to what the slime had left
    expect(slime.isDead()).toBe(true);
    expect(warrior.hp).toBe(160); // 150 + the 10 actually drained
  });

  it('keeps variance inside MZ\'s +/-N% band and actually varies', () => {
    const rng = new Rng(7);
    const formula = new FormulaEvaluator(rng);
    const warrior = actorBattler(db, { actorId: 1, level: 1, equips: [1, 1, 0, 0, 0] });
    const skill = testSkill({ damage: { variance: 20 } });

    const rolls: number[] = [];
    for (let i = 0; i < 300; i++) {
      const slime = enemyBattler(db, 1);
      rolls.push(applyAction(formula, rng, warrior, skill, slime).damage);
    }

    expect(Math.min(...rolls)).toBeGreaterThanOrEqual(56); // 70 - 20%
    expect(Math.max(...rolls)).toBeLessThanOrEqual(84); // 70 + 20%
    expect(new Set(rolls).size).toBeGreaterThan(5);
  });

  it('applies effects: state infliction and HP recovery', () => {
    const rng = new Rng(3);
    const formula = new FormulaEvaluator(rng);
    const warrior = actorBattler(db, { actorId: 1, level: 1 });
    const slime = enemyBattler(db, 1);

    const poison = testSkill({ effects: [{ code: 21, dataId: 2, value1: 1, value2: 0 }] });
    expect(applyAction(formula, rng, warrior, poison, slime).statesAdded).toEqual([2]);

    warrior.gainHp(-400, rng);
    const potion = testSkill({
      damage: { type: 0, formula: '0' },
      effects: [{ code: 11, dataId: 0, value1: 0, value2: 100 }],
    });
    applyAction(formula, rng, warrior, potion, warrior);
    expect(warrior.hp).toBe(150);
  });
});
