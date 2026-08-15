import type {
  Actor,
  Armor,
  Class,
  Enemy,
  EnemyAction,
  ProjectSession,
  Skill,
  State,
  Trait,
  Troop,
  Weapon,
} from '@rmmz-kit/core';
import type { Rng } from './rng.js';

/**
 * L4.5 battle simulator, part 1: the minimal `Game_Battler` subset the plan
 * (§3 M6) asks for — eight params, states, element rates, hit/evade/crit.
 *
 * Everything here is a port of `rmmz_objects.js`'s `Game_BattlerBase` /
 * `Game_Actor` / `Game_Enemy`, each member named after the engine method it
 * came from so a divergence can be checked line by line. What is *not*
 * modeled is listed at
 * the bottom of this comment rather than silently approximated:
 *
 * - buffs/debuffs (`paramBuffRate`, trait 12 / effects 31–34) — every param is
 *   read at its unbuffed value;
 * - TP entirely (no TP costs, no `tpGain`, no TP-triggered enemy actions);
 * - extra **action** times (`TRAIT_ACTION_PLUS`, 61 — `makeActionTimes`'s
 *   per-slot probability roll): every battler still takes exactly one action
 *   per turn. Extra **attack** times (`TRAIT_ATTACK_TIMES`, 34) *are* modeled,
 *   see `attackTimesAdd` — the two used to be conflated here as one unmodeled
 *   item, and they are not the same mechanic: 34 adds hits to a normal attack
 *   and every stock claw/cestus carries it, 61 adds whole actions and almost
 *   nothing does (report §8 F8);
 * - counter/reflect/substitute (sparams cnt/mrf, trait 63) and dual wield;
 * - equip slots beyond "slot 0 is the weapon, the rest are armor".
 *
 * Each of those changes damage-per-turn by a bounded, known amount; a quest
 * balance question ("does this boss one-shot a level 5 party?") is answerable
 * without them, which is the ratio the plan is buying at 10% of L5's cost.
 */

/** Trait codes (`Game_BattlerBase.TRAIT_*`). */
const TRAIT_ELEMENT_RATE = 11;
const TRAIT_STATE_RATE = 13;
const TRAIT_STATE_RESIST = 14;
const TRAIT_PARAM = 21;
const TRAIT_XPARAM = 22;
const TRAIT_SPARAM = 23;
const TRAIT_ATTACK_ELEMENT = 31;
const TRAIT_ATTACK_TIMES = 34;

/** Fixed ids MZ hardcodes in `Game_BattlerBase` rather than storing in System.json. */
export const DEATH_STATE_ID = 1;
export const ATTACK_SKILL_ID = 1;
export const GUARD_SKILL_ID = 2;

const PARAM_COUNT = 8;

export interface Database {
  actors: Array<Actor | null>;
  classes: Array<Class | null>;
  skills: Array<Skill | null>;
  weapons: Array<Weapon | null>;
  armors: Array<Armor | null>;
  enemies: Array<Enemy | null>;
  states: Array<State | null>;
  troops: Array<Troop | null>;
}

/**
 * Snapshots the tables the simulator reads out of the session. A table the
 * project doesn't have yet is an empty array, not a throw — `readFile()` would
 * throw for it, and "this project has no Enemies.json" is better reported as
 * "enemy 3 does not exist" from the one place that asks for it.
 */
export function loadDatabase(session: ProjectSession): Database {
  const files = new Set(session.listFiles());
  const table = <T>(name: string): Array<T | null> =>
    files.has(name) ? session.readFile<Array<T | null>>(name) : [];
  return {
    actors: table<Actor>('Actors.json'),
    classes: table<Class>('Classes.json'),
    skills: table<Skill>('Skills.json'),
    weapons: table<Weapon>('Weapons.json'),
    armors: table<Armor>('Armors.json'),
    enemies: table<Enemy>('Enemies.json'),
    states: table<State>('States.json'),
    troops: table<Troop>('Troops.json'),
  };
}

interface TraitHolder {
  traits?: Trait[];
}

export class Battler {
  hp: number;
  mp: number;
  /** stateId -> turns left. `Infinity` for a state with no auto removal (death, mostly). */
  readonly states = new Map<number, number>();
  /** Set while a Guard action is pending — see `Game_BattlerBase.isGuard()`. */
  guarding = false;

  constructor(
    readonly name: string,
    readonly isActor: boolean,
    readonly level: number,
    private readonly db: Database,
    /** Static trait sources: actor+class+equips, or the enemy row. States are added on top. */
    private readonly objects: TraitHolder[],
    private readonly base: number[],
    private readonly plus: number[],
    /** Skill ids an actor may act with. Unused for enemies, which pick from `actions`. */
    readonly skills: number[],
    /** An enemy's rating-weighted action table (`Game_Enemy.selectAllActions`). Empty for actors. */
    readonly actions: EnemyAction[] = []
  ) {
    this.hp = this.mhp;
    this.mp = this.mmp;
  }

  private traitObjects(): TraitHolder[] {
    const objects: TraitHolder[] = [...this.objects];
    for (const stateId of this.states.keys()) {
      const state = this.db.states[stateId];
      if (state) objects.push(state);
    }
    return objects;
  }

  private traits(code: number, dataId?: number): Trait[] {
    const found: Trait[] = [];
    for (const object of this.traitObjects()) {
      for (const trait of object.traits ?? []) {
        if (trait.code === code && (dataId === undefined || trait.dataId === dataId)) found.push(trait);
      }
    }
    return found;
  }

  private traitsSum(code: number, dataId: number): number {
    return this.traits(code, dataId).reduce((sum, trait) => sum + trait.value, 0);
  }

  private traitsPi(code: number, dataId: number): number {
    return this.traits(code, dataId).reduce((product, trait) => product * trait.value, 1);
  }

  /**
   * `Game_BattlerBase.param()`. MZ (unlike MV) has no upper cap —
   * `paramMax()` is Infinity and `paramMin()` is 1, except MMP's 0. That is an
   * undocumented-format assumption (plan §6 R1) but a cheap one: it only shows
   * up for a battler whose base+equip params reach four digits.
   */
  param(paramId: number): number {
    // `?? 0`: a row upserted with a short/missing params array reads as 0
    // (and so hits paramMin below), not NaN — NaN hp never reaches 0, which
    // silently turns every trial into a stalemate.
    const value =
      Math.max(0, (this.base[paramId] ?? 0) + (this.plus[paramId] ?? 0)) * this.traitsPi(TRAIT_PARAM, paramId);
    return Math.round(Math.max(value, paramId === 1 ? 0 : 1));
  }

  get mhp(): number { return this.param(0); }
  get mmp(): number { return this.param(1); }
  get atk(): number { return this.param(2); }
  get def(): number { return this.param(3); }
  get mat(): number { return this.param(4); }
  get mdf(): number { return this.param(5); }
  get agi(): number { return this.param(6); }
  get luk(): number { return this.param(7); }

  /** `Game_BattlerBase.xparam()` — additive, and 0 when no trait grants it. */
  xparam(xparamId: number): number {
    return this.traitsSum(TRAIT_XPARAM, xparamId);
  }

  get hit(): number { return this.xparam(0); }
  get eva(): number { return this.xparam(1); }
  get cri(): number { return this.xparam(2); }
  get cev(): number { return this.xparam(3); }
  get mev(): number { return this.xparam(4); }
  get hrg(): number { return this.xparam(7); }
  get mrg(): number { return this.xparam(8); }

  /** `Game_BattlerBase.sparam()` — multiplicative, and 1.0 when no trait grants it. */
  sparam(sparamId: number): number {
    return this.traitsPi(TRAIT_SPARAM, sparamId);
  }

  get grd(): number { return this.sparam(1); }
  get rec(): number { return this.sparam(2); }
  get pdr(): number { return this.sparam(6); }
  get mdr(): number { return this.sparam(7); }

  get hpRate(): number { return this.hp / this.mhp; }
  get mpRate(): number { return this.mmp > 0 ? this.mp / this.mmp : 0; }

  elementRate(elementId: number): number {
    return this.traitsPi(TRAIT_ELEMENT_RATE, elementId);
  }

  stateRate(stateId: number): number {
    return this.traitsPi(TRAIT_STATE_RATE, stateId);
  }

  attackElements(): number[] {
    return [...new Set(this.traits(TRAIT_ATTACK_ELEMENT).map((trait) => trait.dataId))];
  }

  /**
   * `Game_BattlerBase.attackTimesAdd()` — extra hits added to a *normal attack*
   * only (`Game_Action.numRepeats`), never to a skill. Floored at 0 the way MZ
   * floors it, so a negative trait cannot subtract the one guaranteed hit.
   *
   * Not an optional refinement: MZ's own stock Cestus carries +1, so a party
   * equipped from the default database hits twice per attack. Ignoring it put
   * the simulator 2.6 turns above a real playtest on the one matchup where it
   * mattered (report §6/§8 F8).
   */
  attackTimesAdd(): number {
    return Math.max(this.traitsSum(TRAIT_ATTACK_TIMES, 0), 0);
  }

  isStateAffected(stateId: number): boolean {
    return this.states.has(stateId);
  }

  isDead(): boolean {
    return this.isStateAffected(DEATH_STATE_ID);
  }

  isAlive(): boolean {
    return !this.isDead();
  }

  /** `Game_BattlerBase.restriction()`: 0 none, 1 attack an enemy, 2 attack anyone, 3 attack an ally, 4 cannot move. */
  restriction(): number {
    let restriction = 0;
    for (const stateId of this.states.keys()) {
      const state = this.db.states[stateId];
      if (state) restriction = Math.max(restriction, state.restriction);
    }
    return restriction;
  }

  canMove(): boolean {
    return this.restriction() < 4;
  }

  addState(stateId: number, rng: Rng): boolean {
    const state = this.db.states[stateId];
    if (!state || this.traits(TRAIT_STATE_RESIST, stateId).length > 0) return false;
    const turns =
      state.autoRemovalTiming > 0
        ? state.minTurns + rng.int(state.maxTurns - state.minTurns + 1)
        : Number.POSITIVE_INFINITY;
    this.states.set(stateId, turns);
    if (stateId === DEATH_STATE_ID) this.hp = 0;
    return true;
  }

  removeState(stateId: number): void {
    if (this.states.delete(stateId) && stateId === DEATH_STATE_ID && this.hp === 0) {
      this.hp = 1; // Game_BattlerBase.revive() — an effect-22 revive must not leave a 0-HP "alive" battler
    }
  }

  gainHp(value: number, rng: Rng): void {
    this.hp = Math.max(0, Math.min(this.mhp, this.hp + value));
    this.refresh(rng);
  }

  gainMp(value: number): void {
    this.mp = Math.max(0, Math.min(this.mmp, this.mp + value));
  }

  /** `Game_BattlerBase.refresh()`: hp 0 is what *causes* the death state, not the other way round. */
  refresh(rng: Rng): void {
    if (this.hp === 0) this.addState(DEATH_STATE_ID, rng);
    else this.removeState(DEATH_STATE_ID);
  }

  /**
   * Turn end: `Game_Battler.regenerateAll()` then `updateStateTurns()` +
   * `removeStatesAuto()`. MZ splits removal between action end (timing 1) and
   * turn end (timing 2); both are done here, because with one action per turn
   * the two points are the same tick.
   */
  onTurnEnd(rng: Rng): void {
    if (this.isDead()) return;
    if (this.hrg !== 0) {
      // Game_Battler.regenerateHp clamps slip damage to -maxSlipDamage(),
      // which with the Slip Death option off (the editor default) is hp-1:
      // poison wears a battler down to 1 HP but never kills. System.json
      // isn't read here, so optSlipDeath=true projects diverge (plan §6 R1).
      const value = Math.max(Math.floor(this.mhp * this.hrg), -Math.max(this.hp - 1, 0));
      this.gainHp(value, rng);
    }
    if (this.mrg !== 0) this.gainMp(Math.floor(this.mmp * this.mrg));
    for (const [stateId, turns] of [...this.states]) {
      if (!Number.isFinite(turns)) continue;
      const left = turns - 1;
      if (left <= 0) this.states.delete(stateId);
      else this.states.set(stateId, left);
    }
  }
}

export interface PartyMemberSpec {
  actorId: number;
  /** Defaults to the actor's `initialLevel`. */
  level?: number;
  /** Equipment ids by slot (slot 0 = weapon, rest = armor). Defaults to the actor's own `equips`. */
  equips?: number[];
  /** Skill ids this actor may use. Defaults to Attack plus everything the class has learned by `level`. */
  skills?: number[];
}

export function actorBattler(db: Database, spec: PartyMemberSpec): Battler {
  const actor = db.actors[spec.actorId];
  if (!actor) throw new Error(`Actor ${spec.actorId} does not exist`);
  const klass = db.classes[actor.classId];
  if (!klass) throw new Error(`Actor ${spec.actorId} (${actor.name}) has class ${actor.classId}, which does not exist`);

  const maxLevel = (klass.params[0]?.length ?? 1) - 1;
  const level = Math.max(1, Math.min(spec.level ?? actor.initialLevel ?? 1, maxLevel));
  const base: number[] = [];
  for (let paramId = 0; paramId < PARAM_COUNT; paramId++) base.push(klass.params[paramId]?.[level] ?? 0);

  // Slot 0 is the weapon slot and the rest are armor — true for a default MZ
  // project, wrong for a dual-wield actor (trait 55 makes slot 1 a weapon too).
  const equipIds = spec.equips ?? actor.equips ?? [];
  const equips = equipIds
    .map((id, slot) => (id > 0 ? (slot === 0 ? db.weapons[id] : db.armors[id]) : null))
    .filter((item): item is Weapon | Armor => item != null);

  const plus = new Array(PARAM_COUNT).fill(0);
  for (const equip of equips) {
    for (let paramId = 0; paramId < PARAM_COUNT; paramId++) plus[paramId] += equip.params[paramId] ?? 0;
  }

  const learned = (klass.learnings ?? []).filter((l) => l.level <= level).map((l) => l.skillId);
  const skills = spec.skills ?? [ATTACK_SKILL_ID, ...learned];

  return new Battler(actor.name, true, level, db, [actor, klass, ...equips], base, plus, skills);
}

export function enemyBattler(db: Database, enemyId: number): Battler {
  const enemy = db.enemies[enemyId];
  if (!enemy) throw new Error(`Enemy ${enemyId} does not exist`);
  return new Battler(
    enemy.name,
    false,
    0,
    db,
    [enemy],
    // `?? []`: upsert_database does no field validation, so a hand-upserted
    // row can lack these — better a 1-in-every-stat weakling than a TypeError.
    (enemy.params ?? []).slice(0, PARAM_COUNT),
    new Array(PARAM_COUNT).fill(0),
    [ATTACK_SKILL_ID],
    enemy.actions ?? []
  );
}
