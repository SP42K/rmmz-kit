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

/** decompile() only recognizes 401/408 as continuations when scanning forward from a 101/108 it just consumed; a 401/408 that appears anywhere else silently falls back to RawNode instead of erroring, so it needs its own check. */
function checkOrphanContinuations(ctx: ListContext, findings: Finding[]): void {
  ctx.list.forEach((cmd: EventCommand, i: number) => {
    if (cmd.code !== 401 && cmd.code !== 408) return;
    const opener = cmd.code === 401 ? 101 : 108;
    const prev = ctx.list[i - 1];
    if (!prev || prev.indent !== cmd.indent || (prev.code !== opener && prev.code !== cmd.code)) {
      findings.push({
        rule: 'structure/orphan-continuation',
        severity: 'error',
        message: `Command ${i} (code ${cmd.code}) continues a ${opener === 101 ? 'Show Text' : 'Comment'} block that isn't open here`,
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
