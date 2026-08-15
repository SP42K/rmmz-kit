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
 *
 * So is the *target* choice, which the licensed-machine run showed is worth as
 * much as the skill choice and used not to be reported at all (§8 F7): picking
 * uniformly among living enemies spreads damage over all of them, while a real
 * player — and MZ's own auto-battle `evaluate()` — focuses fire and removes an
 * attacker a turn sooner. On the one matchup where the sides were evenly
 * matched that was +15.3 percentage points of win rate, all of the divergence
 * left after F8. `targetPolicy` is therefore a *spec* option rather than a
 * hidden constant: `'random'` (the default, unchanged) and `'focus'` bracket
 * the real answer instead of leaving a caller with one number and no error bar.
 * Neither is `evaluate()` — modelling that means modelling every skill's value
 * to every battler, which is L5's job, not a heuristic's.
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
  /**
   * How a single-target action picks among living enemies. `'random'` (default)
   * is uniform; `'focus'` always takes the lowest-HP living one, which is what
   * a player does and what `Game_Action.evaluate` approximates. Run both to
   * bracket a matchup — see the note at the top of this file.
   */
  targetPolicy?: TargetPolicy;
}

export type TargetPolicy = 'random' | 'focus';

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
  /** Which targeting policy produced these numbers — echoed so a report is self-describing. */
  targetPolicy: TargetPolicy;
  policy: string;
  /** Human-readable calls to action — the "一擊必殺 / 無限僵持" findings the plan asks for. */
  warnings: string[];
}

const TARGET_POLICY: Record<TargetPolicy, string> = {
  random:
    'Targets: uniform random among living, so damage spreads across the enemy side — MZ leaves ' +
    'targeting to the player, and a player (like Game_Action.evaluate) focuses fire, which ends ' +
    'an even matchup sooner than this reports. Re-run with targetPolicy "focus" for the other bound.',
  focus:
    'Targets: always the lowest-HP living enemy, an upper bound on focus fire — MZ\'s own ' +
    'evaluate() weighs more than remaining HP. Re-run with targetPolicy "random" for the other bound.',
};

function policyText(targets: TargetPolicy): string {
  return (
    'Actors: heal when an ally is under 50% HP and a healing skill is affordable, otherwise the ' +
    'costliest affordable damaging skill. Enemies: MZ rating-weighted selection over their action list. ' +
    'Nobody guards, uses items, or flees. ' +
    TARGET_POLICY[targets]
  );
}

export function simulate(session: ProjectSession, spec: BattleSpec): BattleReport {
  const db = loadDatabase(session);
  const trials = spec.trials ?? 1000;
  const maxTurns = spec.maxTurns ?? 30;
  const seed = spec.seed ?? 0;
  const targetPolicy = spec.targetPolicy ?? 'random';
  const enemyIds = resolveEnemies(db, spec);
  if (spec.party.length === 0) throw new Error('Battle spec has an empty party');
  if (enemyIds.length === 0) throw new Error('Battle spec has no enemies');

  const rng = new Rng(seed);
  const formula = new FormulaEvaluator(rng);
  const results: TrialResult[] = [];
  for (let i = 0; i < trials; i++) {
    results.push(runBattle(db, spec.party, enemyIds, maxTurns, rng, formula, targetPolicy));
  }

  return buildReport(
    spec.party.map((member) => actorBattler(db, member).name),
    enemyIds.map((id) => enemyBattler(db, id).name),
    results,
    { trials, seed, maxTurns, targetPolicy }
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
  formula: FormulaEvaluator,
  targetPolicy: TargetPolicy
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
      const targets = forced ?? resolveTargets(rng, used, subject, allies, foes, targetPolicy);
      // `Game_Action.numRepeats()`: the item's own repeats, plus the subject's
      // attackTimesAdd for a *normal attack* only, floored. Max(1, ...) is this
      // simulator's own guard against a data row with repeats 0 or missing.
      const repeats = Math.max(
        1,
        Math.floor(used.repeats + (used.id === ATTACK_SKILL_ID ? subject.attackTimesAdd() : 0))
      );
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
 * A fixed policy, not an AI. Heal below 50%, otherwise hit with the
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

/**
 * `Game_Action.makeTargets()`, minus the tgr-weighted pick.
 *
 * Which living enemy a single-target action lands on is the player's call in
 * MZ, so it is this simulator's policy, not a port — and a consequential one:
 * `'random'` spreads damage and leaves every enemy attacking to the end,
 * `'focus'` removes them one at a time. See the file header for what the
 * difference measured against a real playtest (§8 F7).
 */
function resolveTargets(
  rng: Rng,
  skill: Skill,
  subject: Battler,
  allies: Battler[],
  foes: Battler[],
  targetPolicy: TargetPolicy
): Battler[] {
  const choose = (pool: Battler[], count: number) => {
    const living = alive(pool);
    if (living.length === 0) return [];
    // Actors only. `Game_Unit.randomTarget` is what enemies genuinely use, so
    // letting focus drive both sides would not be "the player plays better",
    // it would be a different game — and it measures that way: enemies
    // concentrating on one party member kill it and make the fight *longer*.
    const focus =
      targetPolicy === 'focus' && subject.isActor
        ? living.reduce((worst, one) => (one.hp < worst.hp ? one : worst))
        : null;
    // MZ picks each of the N targets independently, so the same enemy can be
    // hit twice by a "2 random enemies" skill. The roll is drawn even under
    // 'focus' and then discarded, so the two policies share one RNG stream:
    // comparing them isolates targeting instead of also reshuffling every
    // later hit, crit and variance roll, which is what makes them a bracket
    // rather than two unrelated runs.
    return Array.from({ length: count }, () => {
      const rolled = rng.pick(living);
      return focus ?? rolled;
    });
  };

  switch (skill.scope) {
    case 0:
      return [];
    case 1:
      return choose(foes, 1);
    case 2:
      return alive(foes);
    case 3:
    case 4:
    case 5:
    case 6:
      return choose(foes, skill.scope - 2);
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
      return choose(foes, 1);
  }
}

function buildReport(
  partyNames: string[],
  enemyNames: string[],
  results: TrialResult[],
  meta: { trials: number; seed: number; maxTurns: number; targetPolicy: TargetPolicy }
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
    targetPolicy: meta.targetPolicy,
    policy: policyText(meta.targetPolicy),
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
