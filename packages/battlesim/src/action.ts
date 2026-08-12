import vm from 'node:vm';
import type { Effect, Skill } from '@rmmz-kit/core';
import { Battler } from './battler.js';
import type { Rng } from './rng.js';

/**
 * L4.5 battle simulator, part 2: `Game_Action`'s hit/evade/crit rolls and
 * `makeDamageValue()` — the whole reason this milestone is cheap (plan §3 M6:
 * MZ's damage formula is an `eval` string, so it runs in Node without ever
 * starting the game).
 *
 * The order of operations in `makeDamageValue` is load-bearing and is
 * reproduced exactly: element rate, then pdr/mdr, then rec for healing, then
 * critical (×3), then variance, then guard, then round. Reordering variance
 * and guard alone shifts average damage by several percent, which is the
 * entire measurement the acceptance criterion (<10% off a real playtest) is
 * about.
 *
 * Effects: only HP/MP recovery (11/12) and add/remove state (21/22) are
 * applied. TP, growth, learn-skill and common-event effects are ignored —
 * none of them changes the outcome of a single battle.
 */

export interface HitResult {
  missed: boolean;
  evaded: boolean;
  critical: boolean;
  /** HP taken off the target. Negative for healing, 0 for a miss or a non-HP skill. */
  damage: number;
  statesAdded: number[];
}

const noHit = (evaded: boolean): HitResult => ({
  missed: !evaded,
  evaded,
  critical: false,
  damage: 0,
  statesAdded: [],
});

/**
 * MZ evaluates `damage.formula` with `eval` in a scope holding `a`, `b` and
 * `v`. `node:vm` gives the same thing without letting a project's formula
 * reach this process's scope — the formula string comes out of a data file an
 * agent may have just written, so it is not trusted input.
 *
 * Isolation depends on the context holding no host-realm object at all: any
 * host function or prototype handed in lets `x.constructor.constructor(...)`
 * reach the host `Function` and escape. So the contextified sandbox keeps its
 * own intrinsics (a vm context gets a fresh `Math` of its own), the seeded
 * `Math.random` and the `v` proxy are installed by a function compiled
 * *inside* the context (a closure over a host callback is not reachable by
 * reflection), and `a`/`b` are null-prototype snapshots of plain numbers.
 */
export class FormulaEvaluator {
  private readonly sandbox: { a?: object; b?: object };
  private readonly context: vm.Context;
  private readonly scripts = new Map<string, vm.Script | null>();

  constructor(rng: Rng, variables: number[] = []) {
    this.sandbox = Object.create(null) as { a?: object; b?: object };
    this.context = vm.createContext(this.sandbox);
    // `Math.random` is seeded so a formula that rolls its own dice
    // (`a.atk * (1 + Math.random())`) stays reproducible along with the rest;
    // `v[n]` reads as whatever the caller passed and 0 otherwise, rather than
    // NaN-ing the whole formula.
    const install = new vm.Script(
      '(rand, getVar) => { Math.random = () => rand(); globalThis.v = new Proxy({}, { get: (_t, key) => getVar(key) }); }'
    ).runInContext(this.context) as (
      rand: () => number,
      getVar: (key: string | symbol) => number
    ) => void;
    install(
      () => rng.next(),
      (key) => (typeof key === 'string' ? variables[Number(key)] ?? 0 : 0)
    );
  }

  /** `Game_Action.evalDamageFormula()`, including its "any failure is 0 damage" contract. */
  eval(formula: string, a: Battler, b: Battler, sign: number): number {
    let script = this.scripts.get(formula);
    if (script === undefined) {
      try {
        script = new vm.Script(formula);
      } catch {
        script = null;
      }
      this.scripts.set(formula, script);
    }
    if (script === null) return 0;

    this.sandbox.a = formulaView(a);
    this.sandbox.b = formulaView(b);
    try {
      const value = Math.max(script.runInContext(this.context, { timeout: 1000 }), 0) * sign;
      return isNaN(value) ? 0 : value;
    } catch {
      return 0;
    }
  }
}

/**
 * The battler surface a damage formula sees (`a.atk`, `b.def`, `a.level`,
 * `a.hp`...), copied into a null-prototype bag of numbers so no live host
 * object ever crosses into the vm context (see FormulaEvaluator's doc).
 */
function formulaView(battler: Battler): object {
  return Object.assign(Object.create(null), {
    level: battler.level,
    hp: battler.hp,
    mp: battler.mp,
    mhp: battler.mhp,
    mmp: battler.mmp,
    atk: battler.atk,
    def: battler.def,
    mat: battler.mat,
    mdf: battler.mdf,
    agi: battler.agi,
    luk: battler.luk,
  });
}

const isPhysical = (skill: Skill) => skill.hitType === 1;
const isMagical = (skill: Skill) => skill.hitType === 2;
const isHpEffect = (skill: Skill) => [1, 3, 5].includes(skill.damage.type);
const isRecover = (skill: Skill) => [3, 4].includes(skill.damage.type);

/** `Game_Action.apply()`: roll hit, roll evade, roll crit, then damage and effects. */
export function applyAction(
  formula: FormulaEvaluator,
  rng: Rng,
  subject: Battler,
  skill: Skill,
  target: Battler
): HitResult {
  const hitRate = isPhysical(skill) ? skill.successRate * 0.01 * subject.hit : skill.successRate * 0.01;
  if (rng.next() >= hitRate) return noHit(false);

  const evaRate = isPhysical(skill) ? target.eva : isMagical(skill) ? target.mev : 0;
  if (rng.next() < evaRate) return noHit(true);

  const critRate = skill.damage.critical ? subject.cri * (1 - target.cev) : 0;
  const critical = rng.next() < critRate;

  let damage = 0;
  if (skill.damage.type > 0) {
    let value = makeDamageValue(formula, rng, subject, skill, target, critical);
    if (isHpEffect(skill)) {
      // Game_Action.executeHpDamage: a drain (type 5) can't take more than
      // the target has, and what it takes comes back to the subject.
      if (skill.damage.type === 5) value = Math.min(target.hp, value);
      target.gainHp(-value, rng);
      if (skill.damage.type === 5) subject.gainHp(value, rng);
      damage = value;
    } else {
      // Game_Action.executeMpDamage clamps all non-recover MP damage to what
      // the target has; a drain (type 6) credits the subject.
      if (skill.damage.type !== 4) value = Math.min(target.mp, value);
      target.gainMp(-value);
      if (skill.damage.type === 6) subject.gainMp(value);
    }
  }

  const statesAdded: number[] = [];
  for (const effect of skill.effects) {
    applyEffect(rng, subject, skill, target, effect, statesAdded);
  }
  return { missed: false, evaded: false, critical, damage, statesAdded };
}

/** `Game_Action.makeDamageValue()`. */
function makeDamageValue(
  formula: FormulaEvaluator,
  rng: Rng,
  subject: Battler,
  skill: Skill,
  target: Battler,
  critical: boolean
): number {
  const baseValue = formula.eval(skill.damage.formula, subject, target, isRecover(skill) ? -1 : 1);
  let value = baseValue * calcElementRate(subject, skill, target);
  if (isPhysical(skill)) value *= target.pdr;
  if (isMagical(skill)) value *= target.mdr;
  if (baseValue < 0) value *= target.rec;
  if (critical) value *= 3;
  value = applyVariance(rng, value, skill.damage.variance);
  value = value / (value > 0 && target.guarding ? 2 * target.grd : 1);
  return Math.round(value);
}

/** `Game_Action.calcElementRate()`: -1 means "use the attacker's own attack elements". */
function calcElementRate(subject: Battler, skill: Skill, target: Battler): number {
  const elementId = skill.damage.elementId;
  if (elementId >= 0) return target.elementRate(elementId);
  const elements = subject.attackElements();
  return elements.length > 0 ? Math.max(...elements.map((id) => target.elementRate(id))) : 1;
}

/** `Game_Action.applyVariance()`: two rolls summed, so the spread is triangular, not flat. */
function applyVariance(rng: Rng, damage: number, variance: number): number {
  const amp = Math.floor(Math.max((Math.abs(damage) * variance) / 100, 0));
  const offset = rng.int(amp + 1) + rng.int(amp + 1) - amp;
  return damage >= 0 ? damage + offset : damage - offset;
}

function applyEffect(
  rng: Rng,
  subject: Battler,
  skill: Skill,
  target: Battler,
  effect: Effect,
  statesAdded: number[]
): void {
  switch (effect.code) {
    case 11: // recover HP: value1 is a fraction of mhp, value2 a flat amount
      target.gainHp(Math.floor((target.mhp * effect.value1 + effect.value2) * target.rec), rng);
      break;
    case 12: // recover MP
      target.gainMp(Math.floor((target.mmp * effect.value1 + effect.value2) * target.rec));
      break;
    case 21: {
      // Attack-state effects (dataId 0) come from trait 32, which we don't model.
      if (effect.dataId === 0) break;
      let chance = effect.value1;
      if (skill.hitType !== 0) {
        chance *= target.stateRate(effect.dataId);
        chance *= Math.max(1 + (subject.luk - target.luk) * 0.001, 0);
      }
      if (rng.next() < chance && target.addState(effect.dataId, rng)) statesAdded.push(effect.dataId);
      break;
    }
    case 22:
      if (rng.next() < effect.value1) target.removeState(effect.dataId);
      break;
    default:
      break;
  }
}
