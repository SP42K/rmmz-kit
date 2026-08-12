import type { EnemyAction, ProjectSession, Skill } from '@rmmz-kit/core';
import {
  ATTACK_SKILL_ID,
  GUARD_SKILL_ID,
  Battler,
  actorBattler,
  enemyBattler,
  loadDatabase,
  type Database,
  type PartyMemberSpec,
} from './battler.js';
import { FormulaEvaluator, applyAction } from './action.js';
import { Rng } from './rng.js';

/**
 * L4.5 battle simulator, part 3: the turn loop and the N-trial report the plan
 * (§3 M6) specifies — win rate, average turns, TTK, damage distribution, and
 * whether the matchup contains a one-shot kill or can stall forever.
 *
 * The loop is MZ's turn-based flow (`BattleManager` with
 * `$dataSystem.battleSystem === 0`), not TPB: everyone picks an action at the
 * start of the turn, the turn resolves in speed order, then states tick. TPB
 * is deliberately not simulated — it is non-deterministic by design, which is
 * why the plan's own M8 notes force turn-based mode for testing too.
 *
 * The action *choice* is a heuristic, not an engine port — MZ leaves it to the
 * player. It is stated in the report (`policy`) because it is the one input a
 * balance number is most sensitive to: a party that never heals loses fights a
 * real player wins.
 */

export interface BattleSpec {
  party: PartyMemberSpec[];
  /** Enemy side, either as a troop id or a raw list of enemy ids. Exactly one is required. */
  troopId?: number;
  enemies?: number[];
  /** Default 1000, per the plan's N=1000. */
  trials?: number;
  /** A trial that reaches this many turns counts as a stalemate. Default 30. */
  maxTurns?: number;
  /** Default 0. Same seed + same data = same report. */
  seed?: number;
}

export interface DamageStats {
  hits: number;
  misses: number;
  criticals: number;
  mean: number;
  median: number;
  p90: number;
  max: number;
}

export interface BattleReport {
  trials: number;
  seed: number;
  maxTurns: number;
  party: string[];
  enemies: string[];
  winRate: number;
  defeatRate: number;
  stalemateRate: number;
  /** Turns taken, across every trial (a stalemate contributes `maxTurns`). */
  turns: { mean: number; median: number; max: number };
  /**
   * Time-to-kill: mean turns for that side to be wiped out, over the trials
   * where it happened. `null` when it never did.
   */
  ttk: { enemies: number | null; party: number | null };
  damage: { byParty: DamageStats; byEnemies: DamageStats };
  /** Trials where a battler at full HP was killed by a single hit. */
  oneShotKillRate: number;
  policy: string;
  /** Human-readable calls to action — the "一擊必殺 / 無限僵持" findings the plan asks for. */
  warnings: string[];
}

const POLICY =
  'Actors: heal when an ally is under 50% HP and a healing skill is affordable, otherwise the ' +
  'costliest affordable damaging skill. Enemies: MZ rating-weighted selection over their action list. ' +
  'Nobody guards, uses items, or flees.';

export function simulate(session: ProjectSession, spec: BattleSpec): BattleReport {
  const db = loadDatabase(session);
  const trials = spec.trials ?? 1000;
  const maxTurns = spec.maxTurns ?? 30;
  const seed = spec.seed ?? 0;
  const enemyIds = resolveEnemies(db, spec);
  if (spec.party.length === 0) throw new Error('Battle spec has an empty party');
  if (enemyIds.length === 0) throw new Error('Battle spec has no enemies');

  const rng = new Rng(seed);
  const formula = new FormulaEvaluator(rng);
  const results: TrialResult[] = [];
  for (let i = 0; i < trials; i++) {
    results.push(runBattle(db, spec.party, enemyIds, maxTurns, rng, formula));
  }

  return buildReport(
    spec.party.map((member) => actorBattler(db, member).name),
    enemyIds.map((id) => enemyBattler(db, id).name),
    results,
    { trials, seed, maxTurns }
  );
}

function resolveEnemies(db: Database, spec: BattleSpec): number[] {
  if (spec.enemies && spec.troopId !== undefined) {
    throw new Error('Battle spec sets both troopId and enemies; pick one');
  }
  if (spec.enemies) return spec.enemies;
  if (spec.troopId === undefined) throw new Error('Battle spec needs either troopId or enemies');
  const troop = db.troops[spec.troopId];
  if (!troop) throw new Error(`Troop ${spec.troopId} does not exist`);
  return troop.members.filter((member) => !member.hidden).map((member) => member.enemyId);
}

interface TrialResult {
  outcome: 'win' | 'defeat' | 'stalemate';
  turns: number;
  damageByParty: number[];
  damageByEnemies: number[];
  missesByParty: number;
  missesByEnemies: number;
  criticalsByParty: number;
  criticalsByEnemies: number;
  oneShotKill: boolean;
}

function runBattle(
  db: Database,
  partySpec: PartyMemberSpec[],
  enemyIds: number[],
  maxTurns: number,
  rng: Rng,
  formula: FormulaEvaluator
): TrialResult {
  const party = partySpec.map((member) => actorBattler(db, member));
  const enemies = enemyIds.map((id) => enemyBattler(db, id));
  const result: TrialResult = {
    outcome: 'stalemate',
    turns: maxTurns,
    damageByParty: [],
    damageByEnemies: [],
    missesByParty: 0,
    missesByEnemies: 0,
    criticalsByParty: 0,
    criticalsByEnemies: 0,
    oneShotKill: false,
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
    // MZ makes every action first, then sorts by speed: a battler killed
    // before it acts still had its skill (and so its speed) chosen.
    const actors = [...party, ...enemies].filter((battler) => battler.isAlive());
    const queue = actors.map((subject) => {
      const allies = party.includes(subject) ? party : enemies;
      const foes = allies === party ? enemies : party;
      // `turn - 1`: MZ picks actions during startInput, *before* startTurn's
      // increaseTurn, so turn conditions see turnCount() = 0 on the first
      // round — that is why the editor's "Turn 0" means "opening move".
      const skill = chooseSkill(db, rng, subject, allies, foes, turn - 1);
      // MZ's `isGuard()` reads the *pending* action, so guarding is in effect
      // for the whole turn — including against battlers that act first.
      subject.guarding = skill?.id === GUARD_SKILL_ID;
      return { subject, allies, foes, skill, speed: actionSpeed(rng, subject, skill) };
    });
    queue.sort((a, b) => b.speed - a.speed);

    for (const turnAction of queue) {
      const { subject, allies, foes, skill } = turnAction;
      if (subject.isDead() || !skill || !subject.canMove()) continue;

      const forced = forcedTarget(rng, subject, allies, foes);
      // Restrictions 1-3 replace the whole action with a cost-free plain
      // Attack (Game_Action.prepare -> setConfusion -> setAttack) — a
      // confused healer swings at someone, it does not misfire its Heal.
      const used = forced ? db.skills[ATTACK_SKILL_ID] ?? skill : skill;
      subject.gainMp(-used.mpCost); // Game_Battler.paySkillCost — no TP, see battler.ts
      const targets = forced ?? resolveTargets(rng, used, subject, allies, foes);
      const repeats = Math.max(1, used.repeats);
      for (let i = 0; i < repeats; i++) {
        for (const target of targets) {
          if (target.isDead() && used.scope !== 9 && used.scope !== 10) continue;
          const fullHp = target.hp === target.mhp;
          const hit = applyAction(formula, rng, subject, used, target);
          record(result, party.includes(subject), hit);
          if (fullHp && target.isDead() && hit.damage > 0) result.oneShotKill = true;
        }
      }

      if (enemies.every((enemy) => enemy.isDead())) {
        return { ...result, outcome: 'win', turns: turn };
      }
      if (party.every((member) => member.isDead())) {
        return { ...result, outcome: 'defeat', turns: turn };
      }
    }

    // Turn end can't end the battle: slip damage clamps at 1 HP (battler.ts).
    for (const battler of [...party, ...enemies]) battler.onTurnEnd(rng);
  }

  return result;
}

function record(result: TrialResult, byParty: boolean, hit: { missed: boolean; evaded: boolean; critical: boolean; damage: number }): void {
  if (hit.missed || hit.evaded) {
    if (byParty) result.missesByParty++;
    else result.missesByEnemies++;
    return;
  }
  if (hit.critical) {
    if (byParty) result.criticalsByParty++;
    else result.criticalsByEnemies++;
  }
  if (hit.damage > 0) {
    if (byParty) result.damageByParty.push(hit.damage);
    else result.damageByEnemies.push(hit.damage);
  }
}

/** `Game_Action.speed()`: agi plus a roll, so turn order is only mostly by agility. */
function actionSpeed(rng: Rng, subject: Battler, skill: Skill | null): number {
  const agi = subject.agi;
  return agi + rng.int(Math.floor(5 + agi / 4)) + (skill?.speed ?? 0);
}

/**
 * Restrictions 1–3 (confusion/rage) override the chosen action with a plain
 * attack at a forced target; 4 is handled by `canMove()` at the call site.
 */
function forcedTarget(rng: Rng, subject: Battler, allies: Battler[], foes: Battler[]): Battler[] | null {
  const restriction = subject.restriction();
  if (restriction < 1 || restriction > 3) return null;
  const pool =
    restriction === 1 ? alive(foes) : restriction === 3 ? alive(allies) : [...alive(foes), ...alive(allies)];
  return pool.length > 0 ? [rng.pick(pool)] : null;
}

const alive = (battlers: Battler[]) => battlers.filter((battler) => battler.isAlive());

function chooseSkill(
  db: Database,
  rng: Rng,
  subject: Battler,
  allies: Battler[],
  foes: Battler[],
  turn: number
): Skill | null {
  return subject.isActor
    ? chooseActorSkill(db, subject, allies)
    : chooseEnemySkill(db, rng, subject, foes, turn);
}

/**
 * ponytail: fixed policy, not an AI. Heal below 50%, otherwise hit with the
 * most expensive skill that is affordable — good enough to answer "is this
 * fight winnable", and swappable for a policy parameter if a caller ever needs
 * to compare two strategies.
 */
function chooseActorSkill(db: Database, subject: Battler, allies: Battler[]): Skill | null {
  const usable = subject.skills
    .map((id) => db.skills[id])
    .filter((skill): skill is Skill => skill != null && skill.mpCost <= subject.mp && skill.occasion <= 1);
  if (usable.length === 0) return db.skills[ATTACK_SKILL_ID] ?? null;

  const wounded = alive(allies).some((ally) => ally.hpRate < 0.5);
  const heals = usable.filter((skill) => skill.damage.type === 3 || skill.effects.some((e) => e.code === 11));
  if (wounded && heals.length > 0) {
    return heals.reduce((best, skill) => (skill.mpCost > best.mpCost ? skill : best));
  }

  const offensive = usable.filter((skill) => skill.damage.type === 1 || skill.damage.type === 5);
  if (offensive.length === 0) return db.skills[ATTACK_SKILL_ID] ?? null;
  return offensive.reduce((best, skill) => (skill.mpCost > best.mpCost ? skill : best));
}

/** `Game_Enemy.selectAllActions()`: everything within 3 rating points of the best, weighted by rating. */
function chooseEnemySkill(db: Database, rng: Rng, subject: Battler, foes: Battler[], turn: number): Skill | null {
  const valid = subject.actions.filter((action) => {
    const skill = db.skills[action.skillId];
    return skill != null && skill.mpCost <= subject.mp && meetsCondition(action, subject, foes, turn);
  });
  if (valid.length === 0) return db.skills[ATTACK_SKILL_ID] ?? null;

  const ratingZero = Math.max(...valid.map((action) => action.rating)) - 3;
  const candidates = valid.filter((action) => action.rating > ratingZero);
  const sum = candidates.reduce((total, action) => total + action.rating - ratingZero, 0);
  let roll = rng.int(sum);
  for (const action of candidates) {
    roll -= action.rating - ratingZero;
    if (roll < 0) return db.skills[action.skillId] ?? null;
  }
  return db.skills[candidates[0].skillId] ?? null;
}

/**
 * `Game_Enemy.meetsCondition()`. Type 5 (party level) reads the simulated
 * party, type 6 (switch) is treated as satisfied — a simulator has no
 * `$gameSwitches`, and "this enemy never uses its scripted move" would be the
 * more misleading of the two answers.
 */
function meetsCondition(action: EnemyAction, subject: Battler, foes: Battler[], turn: number): boolean {
  const { conditionParam1: p1, conditionParam2: p2 } = action;
  switch (action.conditionType) {
    case 1:
      return p2 === 0 ? turn === p1 : turn > 0 && turn >= p1 && turn % p2 === p1 % p2;
    case 2:
      return subject.hpRate >= p1 && subject.hpRate <= p2;
    case 3:
      return subject.mpRate >= p1 && subject.mpRate <= p2;
    case 4:
      return subject.isStateAffected(p1);
    case 5:
      // Game_Enemy.meetsPartyLevelCondition: $gameParty.highestLevel() >= p1.
      return Math.max(...foes.map((foe) => foe.level)) >= p1;
    default:
      return true;
  }
}

/** `Game_Action.makeTargets()`, minus the tgr-weighted random pick (every alive target is equally likely). */
function resolveTargets(rng: Rng, skill: Skill, subject: Battler, allies: Battler[], foes: Battler[]): Battler[] {
  const random = (pool: Battler[], count: number) => {
    const living = alive(pool);
    if (living.length === 0) return [];
    // MZ picks each of the N targets independently, so the same enemy can be
    // hit twice by a "2 random enemies" skill.
    return Array.from({ length: count }, () => rng.pick(living));
  };

  switch (skill.scope) {
    case 0:
      return [];
    case 1:
      return random(foes, 1);
    case 2:
      return alive(foes);
    case 3:
    case 4:
    case 5:
    case 6:
      return random(foes, skill.scope - 2);
    case 7: {
      const living = alive(allies);
      if (living.length === 0) return [];
      // A healer aims at whoever needs it most; anything else at the user.
      const heals = skill.damage.type === 3 || skill.effects.some((e) => e.code === 11);
      return heals ? [living.reduce((worst, ally) => (ally.hpRate < worst.hpRate ? ally : worst))] : [subject];
    }
    case 8:
      return alive(allies);
    case 9: {
      const dead = allies.filter((ally) => ally.isDead());
      return dead.length > 0 ? [dead[0]] : [];
    }
    case 10:
      return allies.filter((ally) => ally.isDead());
    case 11:
      return [subject];
    case 12: {
      // "1 Ally (Unconditional)": like scope 7 but the dead stay in the pool
      // (this is MZ 1.1+'s revive-capable single-target scope).
      const heals = skill.damage.type === 3 || skill.effects.some((e) => e.code === 11);
      return heals ? [allies.reduce((worst, ally) => (ally.hpRate < worst.hpRate ? ally : worst))] : [subject];
    }
    case 13:
      return allies;
    case 14:
      return [...alive(allies), ...alive(foes)];
    default:
      return random(foes, 1);
  }
}

function buildReport(
  partyNames: string[],
  enemyNames: string[],
  results: TrialResult[],
  meta: { trials: number; seed: number; maxTurns: number }
): BattleReport {
  const rate = (predicate: (r: TrialResult) => boolean) =>
    results.filter(predicate).length / Math.max(1, results.length);
  const wins = results.filter((r) => r.outcome === 'win');
  const defeats = results.filter((r) => r.outcome === 'defeat');

  const report: BattleReport = {
    trials: meta.trials,
    seed: meta.seed,
    maxTurns: meta.maxTurns,
    party: partyNames,
    enemies: enemyNames,
    winRate: rate((r) => r.outcome === 'win'),
    defeatRate: rate((r) => r.outcome === 'defeat'),
    stalemateRate: rate((r) => r.outcome === 'stalemate'),
    turns: {
      mean: mean(results.map((r) => r.turns)),
      median: percentile(results.map((r) => r.turns), 0.5),
      max: Math.max(...results.map((r) => r.turns)),
    },
    ttk: {
      enemies: wins.length > 0 ? mean(wins.map((r) => r.turns)) : null,
      party: defeats.length > 0 ? mean(defeats.map((r) => r.turns)) : null,
    },
    damage: {
      byParty: damageStats(
        results.flatMap((r) => r.damageByParty),
        sum(results.map((r) => r.missesByParty)),
        sum(results.map((r) => r.criticalsByParty))
      ),
      byEnemies: damageStats(
        results.flatMap((r) => r.damageByEnemies),
        sum(results.map((r) => r.missesByEnemies)),
        sum(results.map((r) => r.criticalsByEnemies))
      ),
    },
    oneShotKillRate: rate((r) => r.oneShotKill),
    policy: POLICY,
    warnings: [],
  };

  const pct = (value: number) => `${Math.round(value * 100)}%`;
  if (report.damage.byParty.hits === 0) {
    report.warnings.push('The party never landed a damaging hit — check the skills\' damage formulas and hit rates.');
  }
  if (report.stalemateRate > 0.05) {
    report.warnings.push(
      `${pct(report.stalemateRate)} of battles hit the ${meta.maxTurns}-turn limit with both sides alive — this matchup can stall.`
    );
  }
  if (report.oneShotKillRate > 0.05) {
    report.warnings.push(
      `${pct(report.oneShotKillRate)} of battles contain a one-shot kill (a full-HP battler killed by a single hit).`
    );
  }
  if (report.winRate > 0 && report.winRate < 1 && report.ttk.enemies !== null && report.ttk.enemies > meta.maxTurns * 0.6) {
    report.warnings.push(`Wins take ${report.ttk.enemies.toFixed(1)} turns on average — long enough to feel like a slog.`);
  }
  return report;
}

function damageStats(values: number[], misses: number, criticals: number): DamageStats {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    hits: values.length,
    misses,
    criticals,
    mean: mean(values),
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
  };
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const mean = (values: number[]) => (values.length > 0 ? sum(values) / values.length : 0);

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}
