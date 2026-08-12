import type { ProjectSession, EventCommand } from '@rmmz-kit/core';
import { decompile } from '@rmmz-kit/compiler';
import type { Finding } from '../types.js';
import { forEachCommandList, type ListContext } from '../walk.js';

/**
 * Structural checks (plan §4.4 "事件結構"). The compiler already guarantees
 * these for anything it emits itself; this is the defense line for data that
 * came from elsewhere (hand-edited in the MZ editor, or a future Tier 2/3
 * emitter this repo doesn't have yet).
 */
export function checkStructure(session: ProjectSession): Finding[] {
  const findings: Finding[] = [];
  forEachCommandList(session, (ctx) => {
    checkDecompilable(ctx, findings);
    checkOrphanContinuations(ctx, findings);
    checkBreakOutsideLoop(ctx, findings);
  });
  return findings;
}

/** decompile() is a recursive-descent parser that already throws on every 111/412, 112/413, 102/402/403/404 pairing or indent mistake and on a missing/extra terminator — reuse it rather than re-implementing bracket matching. */
function checkDecompilable(ctx: ListContext, findings: Finding[]): void {
  try {
    decompile(ctx.list);
  } catch (err) {
    findings.push({
      rule: 'structure/malformed-block',
      severity: 'error',
      message: (err as Error).message,
      file: ctx.file,
      path: ctx.path,
    });
  }
}

/**
 * Continuation code -> the command it may follow, and what to call it. MZ has
 * one per multi-row command; each is only valid directly after its opener or
 * after another row of the same kind, at the same indent.
 */
const CONTINUATIONS: Record<number, { opener: number; what: string }> = {
  401: { opener: 101, what: 'Show Text' },
  408: { opener: 108, what: 'Comment' },
  505: { opener: 205, what: 'Set Movement Route' },
  605: { opener: 302, what: 'Shop Processing' },
  655: { opener: 355, what: 'Script' },
};

/** decompile() only recognizes these as continuations when scanning forward from the opener it just consumed; one that appears anywhere else silently falls back to RawNode instead of erroring, so it needs its own check. */
function checkOrphanContinuations(ctx: ListContext, findings: Finding[]): void {
  ctx.list.forEach((cmd: EventCommand, i: number) => {
    const continuation = CONTINUATIONS[cmd.code];
    if (!continuation) return;
    const prev = ctx.list[i - 1];
    if (!prev || prev.indent !== cmd.indent || (prev.code !== continuation.opener && prev.code !== cmd.code)) {
      findings.push({
        rule: 'structure/orphan-continuation',
        severity: 'error',
        message: `Command ${i} (code ${cmd.code}) continues a ${continuation.what} block that isn't open here`,
        file: ctx.file,
        path: ctx.path,
      });
    }
  });
}

function checkBreakOutsideLoop(ctx: ListContext, findings: Finding[]): void {
  let depth = 0;
  ctx.list.forEach((cmd: EventCommand, i: number) => {
    if (cmd.code === 112) depth++;
    else if (cmd.code === 413) depth = Math.max(0, depth - 1);
    else if (cmd.code === 113 && depth === 0) {
      findings.push({
        rule: 'structure/break-outside-loop',
        severity: 'error',
        message: `Command ${i}: Break Loop (code 113) is not inside a Repeat Above block`,
        file: ctx.file,
        path: ctx.path,
      });
    }
  });
}
