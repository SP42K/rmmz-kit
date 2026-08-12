import type { ProjectSession } from '@rmmz-kit/core';
import { validateProject, type Finding } from '@rmmz-kit/validate';
import { runScenario, type Scenario, type ScenarioReport } from '@rmmz-kit/playtest';
import { simulate } from '@rmmz-kit/battlesim';
import { buildGame, type GameBuild } from './build.js';
import { checkSpec, type GameSpec, type SpecIssue } from './spec.js';
import { walkthroughScenarios } from './walkthrough.js';

/**
 * M10's orchestration (plan §3 M10:「這階段主要是編排與 prompt 工程，不是新架構」).
 * One call takes the spec the client wrote and answers the only question the
 * milestone's acceptance asks —「可完整通關且不卡關」— by running the whole
 * stack against it:
 *
 *   checkSpec → buildGame → validate (L4) → simulate_battle (L4.5) → run_scenario (L5)
 *
 * Nothing is committed. Every write went through `ProjectSession`, so a caller
 * that doesn't like the report rolls back and the project never saw it (§1.1
 * decision B) — which is also why this can be run repeatedly against the same
 * session to compare seeds.
 *
 * The three gates answer three different failure modes, and none of them
 * subsumes another:
 *
 * - **validate** catches the structurally broken game (a dangling reference, a
 *   page that can never trigger).
 * - **simulate** catches the unwinnable fight. A boss the party loses to every
 *   time is a wall, and no amount of event-layer testing sees it: `run_scenario`
 *   is *told* the outcome of a battle, it doesn't fight it.
 * - **run_scenario** catches the game that is fine on paper and unfinishable in
 *   play — the gate whose switch nobody sets, the reward that never lands.
 */

export interface GenerateOptions {
  /**
   * Win rate below which a generated battle is reported as a wall. Default 0.5.
   *
   * A judgement call, and deliberately not zero: a fight the party wins one run
   * in five is not *impossible*, but a generated game has no shop, no grinding
   * loop and no second route around it, so in practice it is where a player
   * stops. Callers who disagree can move it.
   */
  minWinRate?: number;
  /** Trials per battle. Default 200 — this is a "can it be won at all" gate, not the balance question §3 M6 runs 1000 for. */
  battleTrials?: number;
  /** Skip the battle gate (it is the slow one). */
  checkBattles?: boolean;
}

export interface BattleCheck {
  what: string;
  troopId: number;
  winRate: number;
  ok: boolean;
  /** The simulator's own prose findings (one-shot kills, stalemates). */
  warnings: string[];
  /**
   * Set when the fight could not be simulated at all — a party member whose
   * class row is missing, say. Reported rather than thrown: it is a fact about
   * the project the caller has to fix, and losing the rest of the report to it
   * would hide everything else that is also wrong.
   */
  error?: string;
}

export interface GameReport {
  /** Every gate passed: the spec is coherent, the data validates, the fights are winnable and the game plays through. */
  ok: boolean;
  /** One line for an operator; the detail is in the fields below. */
  summary: string;
  /** Spec-level problems. Non-empty means nothing was built and the session is untouched. */
  issues: SpecIssue[];
  build?: GameBuild;
  /** New findings only — anything the project was already carrying is excluded, the same amnesty M9's repair loop grants. */
  findings: Finding[];
  battles: BattleCheck[];
  scenarios: ScenarioReport[];
  /** The generated suite, verbatim, so the caller can hand it straight to `repair` as its regression set. */
  suite: Scenario[];
}

export async function generateGame(
  session: ProjectSession,
  spec: GameSpec,
  options: GenerateOptions = {}
): Promise<GameReport> {
  const issues = [...checkSpec(spec), ...checkAgainstProject(session, spec)];
  if (issues.length > 0) {
    return {
      ok: false,
      summary: `${issues.length} spec problem(s); nothing was built.`,
      issues,
      findings: [],
      battles: [],
      scenarios: [],
      suite: [],
    };
  }

  // Baseline before the build, for the reason M9's loop takes one: a project
  // that already fails a lint rule (the fixture's own EV001 does) would
  // otherwise report the generator's output as broken and send a repair loop
  // chasing somebody else's bug.
  const before = new Set((await validateProject(session)).map(keyOf));

  const build = buildGame(session, spec);
  const findings = (await validateProject(session)).filter((f) => !before.has(keyOf(f)));
  const blocking = findings.filter((f) => f.severity === 'error');

  const battles = options.checkBattles === false ? [] : checkBattles(session, spec, build, options);

  // The static gate short-circuits the dynamic one, exactly as the repair loop
  // does: playing through data the validator rejects reports the same bug again
  // in a worse voice.
  const suite = walkthroughScenarios(build);
  const scenarios = blocking.length > 0 ? [] : suite.map((scenario) => runScenario(session, scenario));

  const ok = blocking.length === 0 && battles.every((b) => b.ok) && scenarios.every((s) => s.pass);
  return { ok, summary: summarize(build, blocking, battles, scenarios, ok), issues, build, findings, battles, scenarios, suite };
}

function keyOf(finding: Finding): string {
  return [finding.rule, finding.file, finding.path ?? '', finding.message].join('|');
}

/**
 * The half of "is this spec coherent" that needs the project: an id the spec
 * names has to exist, because this generator arranges content, it does not
 * invent actors or enemies. Checked before the build so a bad id costs the
 * caller a message rather than a half-written session to roll back.
 */
function checkAgainstProject(session: ProjectSession, spec: GameSpec): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const rows = (file: string): Array<{ id?: number } | null> =>
    session.listFiles().includes(file) ? session.readFile<Array<{ id?: number } | null>>(file) : [];
  const exists = (file: string, id: number): boolean => rows(file)[id] != null;

  const need = (file: string, id: number, what: string, path: string) => {
    if (!exists(file, id)) issues.push({ code: 'missing-row', path, message: `${what} ${id} does not exist in ${file}` });
  };

  for (const [i, actorId] of (spec.party ?? [1]).entries()) need('Actors.json', actorId, 'Actor', `party[${i}]`);

  const troop = (value: number | { enemyId: number; count?: number }, path: string) => {
    if (typeof value === 'number') need('Troops.json', value, 'Troop', path);
    else need('Enemies.json', value.enemyId, 'Enemy', `${path}.enemyId`);
  };

  for (const [i, quest] of spec.quests.entries()) {
    const objective = quest.objective;
    if (objective.kind === 'fetch' && typeof objective.item === 'number') {
      need('Items.json', objective.item, 'Item', `quests[${i}].objective.item`);
    }
    if (objective.kind === 'defeat') troop(objective.troop, `quests[${i}].objective.troop`);
    if (quest.reward?.itemId !== undefined) need('Items.json', quest.reward.itemId, 'Item', `quests[${i}].reward.itemId`);
  }
  troop(spec.finale.troop, 'finale.troop');

  return issues;
}

function checkBattles(
  session: ProjectSession,
  spec: GameSpec,
  build: GameBuild,
  options: GenerateOptions
): BattleCheck[] {
  const minWinRate = options.minWinRate ?? 0.5;
  const trials = options.battleTrials ?? 200;
  const party = build.party.map((actorId) => ({ actorId }));

  const fights: Array<{ what: string; troopId: number }> = build.quests
    .filter((quest) => quest.objective.kind === 'defeat')
    .map((quest) => ({ what: quest.title, troopId: quest.objective.troopId! }));
  fights.push({ what: `${build.finale.name} (finale)`, troopId: build.finale.troopId });

  return fights.map(({ what, troopId }) => {
    try {
      // Seeded off the spec's own seed so a report is reproducible; the battle
      // gate must not be the one thing that flickers between two identical runs.
      const report = simulate(session, { party, troopId, trials, seed: spec.seed ?? 0 });
      return { what, troopId, winRate: report.winRate, ok: report.winRate >= minWinRate, warnings: report.warnings };
    } catch (err) {
      return { what, troopId, winRate: 0, ok: false, warnings: [], error: (err as Error).message };
    }
  });
}

function summarize(
  build: GameBuild,
  blocking: Finding[],
  battles: BattleCheck[],
  scenarios: ScenarioReport[],
  ok: boolean
): string {
  const scale = `${build.areas.length} area(s), ${build.quests.length} quest(s)`;
  if (ok) {
    const rates = battles.map((b) => `${b.what} ${(b.winRate * 100).toFixed(0)}%`).join(', ');
    return `"${build.title}" — ${scale}, completable end to end${rates ? ` (win rates: ${rates})` : ''}.`;
  }

  const reasons: string[] = [];
  if (blocking.length > 0) reasons.push(`${blocking.length} blocking validator finding(s)`);
  for (const battle of battles.filter((b) => !b.ok)) {
    reasons.push(battle.error ? `${battle.what} could not be simulated (${battle.error})` : `${battle.what} is won ${(battle.winRate * 100).toFixed(0)}% of the time`);
  }
  for (const scenario of scenarios.filter((s) => !s.pass)) {
    reasons.push(`${scenario.name} failed: ${scenario.failures[0] ?? 'unknown'}`);
  }
  if (reasons.length === 0) reasons.push('unknown');
  return `"${build.title}" — ${scale}, NOT completable: ${reasons.join('; ')}.`;
}
