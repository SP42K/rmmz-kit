import type { Finding } from '@rmmz-kit/validate';
import type { ScenarioReport } from '@rmmz-kit/playtest';
import type { RepairAttempt, RepairOutcome, RepairResult } from './loop.js';

/**
 * Plan §3 M9: 「錯誤訊息品質是修復率的決定變數，投資在這裡比投資在 prompt 上划算」.
 * This file is that investment, so it is the one place in the package where
 * formatting detail is the point rather than noise.
 *
 * Three things a bare `Finding[]` / `ScenarioReport[]` dump does not give a
 * generator, and each costs a repair attempt when it is missing:
 *
 * - **Where to edit.** A finding's `file` + `path` names the command, but the
 *   agent edits through `apply_script`/`upsert_map_event`, which are addressed
 *   by map/event/page. `locate()` translates the path back into that address.
 * - **What the run actually did**, not just which assertion failed. A trajectory
 *   plus the messages shown distinguishes "the switch was never set" from "the
 *   event never ran at all" — the two most common causes, with opposite fixes.
 * - **What its last edit moved.** The state diff against the previous attempt is
 *   how a generator sees that its change had no effect on the failing check,
 *   which is the signal that it is about to oscillate.
 *
 * Every list is capped. A feedback body that does not fit in an agent's working
 * attention is the same as no feedback.
 */

const MAX_FINDINGS = 10;
const MAX_WARNINGS = 5;
const MAX_STEPS = 20;
const MAX_MESSAGES = 8;
const MAX_DIFF = 12;

export function formatFeedback(attempt: RepairAttempt, maxAttempts: number, previous?: RepairAttempt): string {
  if (attempt.ok) return '';
  const header =
    attempt.n === 0
      ? 'Baseline — what is already failing before you generate anything.'
      : `Attempt ${attempt.n} of ${maxAttempts}.`;

  const body = attempt.phase === 'static' ? staticBody(attempt) : dynamicBody(attempt, previous);
  const next =
    attempt.n >= maxAttempts
      ? 'This was the last attempt; the loop stops here.'
      : 'Fix the above with the edit tools, then run the check again.';

  return [header, '', ...body, '', next].join('\n');
}

export function formatSummary(
  outcome: RepairOutcome,
  attempt: RepairAttempt,
  maxAttempts: number,
  extra: Partial<RepairResult>
): string {
  const failedScenarios = attempt.scenarios.filter((r) => !r.pass).length;
  switch (outcome) {
    case 'clean':
      return `Nothing failing: ${attempt.scenarios.length} scenario(s) pass and the validator reports no new blocking findings.`;
    case 'converged':
      return `Converged after ${attempt.n} attempt(s); ${attempt.scenarios.length} scenario(s) pass. Committed ${extra.commit ?? '(nothing to write)'}${extra.branch ? ` on ${extra.branch}` : ''}.`;
    case 'oscillating':
      return `Stopping: attempt ${attempt.n} failed exactly the way attempt ${extra.repeatOf} did. The loop is not converging — escalate to a human.`;
    case 'exhausted':
      return `Gave up after ${maxAttempts} attempts: ${attempt.blocking.length} blocking finding(s), ${failedScenarios} failing scenario(s).`;
    case 'repairing':
      return attempt.phase === 'static'
        ? `${attempt.blocking.length} blocking finding(s) from the validator.`
        : `${failedScenarios} of ${attempt.scenarios.length} scenario(s) failed.`;
  }
}

function staticBody(attempt: RepairAttempt): string[] {
  const lines = ['STATIC GATE — L4 validator rejected the project:'];
  for (const [i, f] of attempt.blocking.slice(0, MAX_FINDINGS).entries()) {
    const where = locate(f);
    lines.push(`  ${i + 1}. [${f.rule}] ${f.message}`);
    lines.push(`     ${f.file}${f.path ? ` at ${f.path}` : ''}${where ? ` — edit ${where}` : ''}`);
  }
  if (attempt.blocking.length > MAX_FINDINGS) {
    lines.push(`  ... and ${attempt.blocking.length - MAX_FINDINGS} more of the same kind.`);
  }
  if (attempt.warnings.length > 0) {
    lines.push('', 'Warnings (not blocking, but usually the same bug seen from another angle):');
    for (const w of attempt.warnings.slice(0, MAX_WARNINGS)) lines.push(`  - [${w.rule}] ${w.message} (${w.file})`);
    if (attempt.warnings.length > MAX_WARNINGS) lines.push(`  ... and ${attempt.warnings.length - MAX_WARNINGS} more.`);
  }
  lines.push('', 'The regression suite was not run — a project the validator rejects has nothing worth running it against.');
  return lines;
}

function dynamicBody(attempt: RepairAttempt, previous?: RepairAttempt): string[] {
  const lines: string[] = [];
  // Paired by index, not by name: `runScenario` defaults an unnamed scenario's
  // name to the literal 'scenario', and the MCP schema makes the name optional,
  // so matching on it would diff scenario 2 against scenario 1's previous run.
  // Every attempt runs the same suite in the same order, so the index is exact.
  for (const [i, report] of attempt.scenarios.entries()) {
    if (report.pass) {
      lines.push(`SCENARIO "${report.name}" — passed.`);
      continue;
    }
    lines.push(`SCENARIO "${report.name}" — FAILED:`);
    for (const failure of report.failures) lines.push(`  ${failure}`);
    lines.push(`  trajectory: ${trajectory(report)}`);
    if (report.messages.length > 0) lines.push(`  messages shown: ${messages(report)}`);

    const before = previous?.scenarios[i];
    const diff = stateDiff(before, report);
    if (diff.length > 0) {
      lines.push(`  state changed since ${label(previous!.n)}:`);
      for (const line of diff.slice(0, MAX_DIFF)) lines.push(`    ${line}`);
      if (diff.length > MAX_DIFF) lines.push(`    ... and ${diff.length - MAX_DIFF} more keys.`);
    } else if (before) {
      // The single most useful line in the whole report: the edit did nothing.
      lines.push(`  state is identical to ${label(previous!.n)} — your last edit changed nothing this scenario reads.`);
    }

    if (report.unmodeled.length > 0) {
      lines.push(
        `  not modeled by the event layer (so this run proves less than it looks): ${report.unmodeled
          .map((u) => `${u.command} x${u.count}`)
          .join(', ')}`
      );
    }
    lines.push('');
  }
  return lines;
}

/** `start()`'s diagnosis is attempt 0; calling it that in prose reads like an off-by-one. */
function label(n: number): string {
  return n === 0 ? 'the baseline' : `attempt ${n}`;
}

/** Steps in order, with the failing one marked — "it never got there" vs "it got there and did the wrong thing". */
function trajectory(report: ScenarioReport): string {
  const shown = report.steps.slice(0, MAX_STEPS).map((s) => {
    if (s.error) return `${s.index}:${s.action} THREW(${s.error})`;
    if (!s.ok) return `${s.index}:${s.action} FAILED`;
    return `${s.index}:${s.action}`;
  });
  if (report.steps.length > MAX_STEPS) shown.push(`... +${report.steps.length - MAX_STEPS}`);
  return shown.join(' → ');
}

function messages(report: ScenarioReport): string {
  const lines = report.messages.slice(0, MAX_MESSAGES).map((m) => JSON.stringify(m.lines.join(' ')));
  if (report.messages.length > MAX_MESSAGES) lines.push(`+${report.messages.length - MAX_MESSAGES} more`);
  return lines.join(' / ');
}

export function stateDiff(before: ScenarioReport | undefined, after: ScenarioReport): string[] {
  if (!before) return [];
  const out: string[] = [];
  diffValues('', before.state, after.state, out);
  return out;
}

function diffValues(prefix: string, a: unknown, b: unknown, out: string[]): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (isRecord(a) && isRecord(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diffValues(prefix ? `${prefix}.${key}` : key, a[key], b[key], out);
    }
    return;
  }
  out.push(`${prefix}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A finding's `path` is a JSON pointer into the file; the agent's tools take
 * map/event/page. Translating between them is mechanical and the agent should
 * not have to spend an attempt doing it.
 */
function locate(finding: Finding): string | null {
  const path = finding.path ?? '';
  const map = /^Map(\d+)\.json$/.exec(finding.file);
  const event = /^event (\d+)/.exec(path);
  if (map && event) {
    // Both walk.ts and RefIndex already number pages the way the tools do
    // (1-based), so this is a re-labelling, not a conversion.
    const page = / page (\d+)/.exec(path);
    const target = `map ${Number(map[1])} event ${Number(event[1])}`;
    return page ? `${target} page ${Number(page[1])}` : target;
  }
  const common = /^commonEvent (\d+)/.exec(path);
  if (common) return `common event ${Number(common[1])}`;
  return null;
}
