import { GitRepo, type ProjectSession } from '@rmmz-kit/core';
import { validateProject, type Finding, type Severity } from '@rmmz-kit/validate';
import { runScenario, type Scenario, type ScenarioReport } from '@rmmz-kit/playtest';
import { formatFeedback, formatSummary } from './feedback.js';

/**
 * L6 repair loop (plan §3 M9).
 *
 *   plan → generate(DSL) → compile → validate
 *     ├─ static errors  → feedback → regenerate (capped)
 *     └─ pass → run the regression suite
 *          ├─ assertion failure → failure trajectory + state diff → repair (capped)
 *          └─ pass → commit
 *
 * **The generator is not in this package, and cannot be.** The thing that turns
 * feedback back into a DSL is an LLM, and in this architecture the LLM is the
 * MCP *client* — so the loop is written as a state machine the client drives
 * (`start()` / `check()`, exposed as the `repair` tool) with `runRepairLoop()`
 * as the callback-shaped convenience for programmatic callers and tests. What
 * lives here is everything else the plan lists as 必要配套, plus the part it
 * names as the determining variable for repair rate: the quality of the error
 * message (see feedback.ts).
 *
 * Three deviations from the plan's sketch, all forced by this repo's own
 * architecture rather than chosen:
 *
 * - **No "commit to a temp branch, then playtest".** `runScenario` runs against
 *   the *in-memory* session (M8's decision), so the dynamic gate needs no commit
 *   at all. The loop therefore commits exactly once, on convergence.
 * - **No `git reset` on failure**, for the same reason: a failed attempt never
 *   wrote anything, so there is nothing to reset. The loop deliberately does not
 *   call `session.rollback()` either — rollback drops *every* in-memory change
 *   since the last commit, including edits made before the loop started, which
 *   is not the loop's to throw away. Its caller has the `rollback` tool.
 * - **Branch isolation is optional** (`spec.branch`), not mandatory. R4's
 *   "oscillation ruins the project" is already answered by committing only on
 *   convergence; the branch is for keeping a converged-but-unreviewed result off
 *   the main line, which is a different (and the caller's) concern.
 */

export interface RepairSpec {
  /**
   * The regression suite. Every attempt runs *all* of it — plan §3 M9:
   * 「每次修復都跑全套，不是只跑失敗那條」. A repair that fixes the failing quest
   * by breaking an earlier one is the exact failure this catches.
   */
  scenarios?: Scenario[];
  /** Repair attempts before giving up. Plan §3 M9 caps at 3; that is the default. */
  maxAttempts?: number;
  /** Findings at this severity or worse block an attempt. Default 'error'. */
  blockOn?: Severity;
  /** Create and switch to this branch before the convergence commit. */
  branch?: string;
  commitMessage?: string;
}

export type RepairOutcome =
  /** Nothing was wrong to begin with (only ever returned by `start()`). */
  | 'clean'
  /** Something failed and attempts remain — `feedback` is what to act on. */
  | 'repairing'
  /** Static gate and every scenario passed; committed. */
  | 'converged'
  | 'exhausted'
  /** This attempt's failure set was already seen — stop and escalate to a human. */
  | 'oscillating';

export interface RepairAttempt {
  /** 0 for `start()`'s diagnosis, which does not consume an attempt. */
  n: number;
  ok: boolean;
  /**
   * Which gate failed. The static gate short-circuits the dynamic one: a
   * project the validator rejects has nothing worth running a suite against.
   */
  phase: 'static' | 'dynamic' | 'none';
  blocking: Finding[];
  warnings: Finding[];
  scenarios: ScenarioReport[];
  /** Canonical form of the failure set, for oscillation detection. */
  signature: string;
  feedback: string;
}

export interface RepairResult {
  outcome: RepairOutcome;
  attempt: number;
  maxAttempts: number;
  /** What the generator should act on next. Empty when the loop is done. */
  feedback: string;
  /** One line an operator reads instead of the feedback body. */
  summary: string;
  blocking: Finding[];
  scenarios: ScenarioReport[];
  /** Set on 'converged': the commit hash, or null if nothing needed writing. */
  commit?: string | null;
  branch?: string;
  /** Set on 'oscillating': the attempt this failure set was first seen at. */
  repeatOf?: number;
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export class RepairLoop {
  readonly attempts: RepairAttempt[] = [];
  private readonly maxAttempts: number;
  private readonly blockRank: number;
  /**
   * Findings already present before the loop started. They do not block: a
   * project with pre-existing lint noise would otherwise never converge, and
   * the loop would spend all three attempts blaming the generator for someone
   * else's bug. Scenario failures get no such amnesty — the suite *is* the
   * spec being repaired against.
   */
  private baseline = new Set<string>();
  /** signature → attempt number it was first seen at. */
  private readonly seen = new Map<string, number>();
  private last: RepairResult | null = null;
  private finished = false;

  constructor(
    private readonly session: ProjectSession,
    private readonly spec: RepairSpec = {}
  ) {
    this.maxAttempts = spec.maxAttempts ?? 3;
    this.blockRank = SEVERITY_RANK[spec.blockOn ?? 'error'];
  }

  /**
   * Snapshot the pre-existing findings and report what is already failing, so
   * the generator writes its *first* draft against the real state of the
   * project rather than discovering it on attempt 1. Does not consume an
   * attempt, and never terminates the loop.
   */
  async start(): Promise<RepairResult> {
    this.baseline = new Set(keysOf(await validateProject(this.session)));
    const attempt = await this.grade(0);
    return this.record(attempt.ok ? 'clean' : 'repairing', attempt);
  }

  /** Grade whatever is in the session right now as one repair attempt. */
  async check(): Promise<RepairResult> {
    // Idempotent once terminal: an agent that calls again after 'exhausted'
    // should get the verdict back, not a fresh attempt past the cap.
    if (this.finished) return this.last!;
    if (this.last === null) await this.start();

    const attempt = await this.grade(this.attempts.filter((a) => a.n > 0).length + 1);

    if (attempt.ok) return this.record('converged', attempt, await this.commit(attempt));

    const first = this.seen.get(attempt.signature);
    if (first !== undefined) return this.record('oscillating', attempt, { repeatOf: first });
    this.seen.set(attempt.signature, attempt.n);

    if (attempt.n >= this.maxAttempts) return this.record('exhausted', attempt);
    return this.record('repairing', attempt);
  }

  /** The last result, or null if the loop has not run. */
  status(): RepairResult | null {
    return this.last;
  }

  private async grade(n: number): Promise<RepairAttempt> {
    const findings = await validateProject(this.session);
    const relevant = findings.filter((f) => !this.baseline.has(keyOf(f)));
    const blocking = relevant.filter((f) => SEVERITY_RANK[f.severity] <= this.blockRank);
    const warnings = relevant.filter((f) => SEVERITY_RANK[f.severity] > this.blockRank);

    // Static gate first, and it short-circuits: running a suite over data the
    // validator rejects reports the same bug a second time, in a worse voice.
    const scenarios = blocking.length > 0 ? [] : (this.spec.scenarios ?? []).map((s) => runScenario(this.session, s));
    const failed = scenarios.filter((r) => !r.pass);

    const attempt: RepairAttempt = {
      n,
      ok: blocking.length === 0 && failed.length === 0,
      phase: blocking.length > 0 ? 'static' : failed.length > 0 ? 'dynamic' : 'none',
      blocking,
      warnings,
      scenarios,
      signature: signatureOf(blocking, scenarios),
      feedback: '',
    };
    attempt.feedback = formatFeedback(attempt, this.maxAttempts, previousDynamic(this.attempts));
    this.attempts.push(attempt);
    return attempt;
  }

  private async commit(attempt: RepairAttempt): Promise<Partial<RepairResult>> {
    const git = new GitRepo(this.session.rootPath);
    let branch: string | undefined;
    if (this.spec.branch && (await git.isRepo())) {
      // Switch before the write, not after: the point is that the converged
      // data lands on that branch, and `git checkout -b` carries the working
      // tree over anyway (nothing is on disk yet — this session commits once).
      if ((await git.currentBranch()) !== this.spec.branch) await git.checkoutNew(this.spec.branch);
      branch = this.spec.branch;
    }
    const message = this.spec.commitMessage ?? `repair: converged after ${attempt.n} attempt(s)`;
    return { commit: await this.session.commit(message), branch };
  }

  private record(outcome: RepairOutcome, attempt: RepairAttempt, extra: Partial<RepairResult> = {}): RepairResult {
    this.finished = outcome !== 'repairing' && outcome !== 'clean';
    this.last = {
      outcome,
      attempt: attempt.n,
      maxAttempts: this.maxAttempts,
      feedback: outcome === 'converged' || outcome === 'clean' ? '' : attempt.feedback,
      summary: formatSummary(outcome, attempt, this.maxAttempts, extra),
      blocking: attempt.blocking,
      scenarios: attempt.scenarios,
      ...extra,
    };
    return this.last;
  }
}

/**
 * Drive the loop with a generator callback — the shape a non-MCP caller (or a
 * test) wants. `generate` receives the current feedback and is expected to
 * mutate the session; it is called at least once, before the first attempt is
 * graded, because the plan's pipeline generates before it validates.
 */
export async function runRepairLoop(
  session: ProjectSession,
  spec: RepairSpec,
  generate: (status: RepairResult) => void | Promise<void>
): Promise<RepairResult> {
  const loop = new RepairLoop(session, spec);
  let status = await loop.start();
  for (;;) {
    await generate(status);
    status = await loop.check();
    if (status.outcome !== 'repairing') return status;
  }
}

/**
 * What makes two failures "the same failure". Message included on purpose: one
 * rule firing on two different ids is two different bugs, and treating them as
 * one would report a loop that is making progress as oscillating.
 */
function keyOf(finding: Finding): string {
  return [finding.rule, finding.file, finding.path ?? '', finding.message].join('|');
}

function keysOf(findings: Finding[]): string[] {
  return findings.map(keyOf);
}

/** Sorted so attempt order inside one gate can't masquerade as a different failure set. */
function signatureOf(blocking: Finding[], scenarios: ScenarioReport[]): string {
  const keys = [
    ...keysOf(blocking),
    ...scenarios.filter((r) => !r.pass).flatMap((r) => r.failures.map((f) => `${r.name}|${f}`)),
  ];
  return keys.sort().join('\n');
}

/** The most recent attempt that actually reached the dynamic gate — what a state diff is against. */
function previousDynamic(attempts: RepairAttempt[]): RepairAttempt | undefined {
  return [...attempts].reverse().find((a) => a.scenarios.length > 0);
}
