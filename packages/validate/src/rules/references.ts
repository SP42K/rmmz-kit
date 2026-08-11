import path from 'node:path';
import { readdir } from 'node:fs/promises';
import type { ProjectSession, RefKind, SystemData, MapData } from '@rmmz-kit/core';
import { RefIndex } from '@rmmz-kit/core';
import type { Finding } from '../types.js';
import type { ListContext } from '../walk.js';
import { forEachCommandList, tryDecompile, walkNodes } from '../walk.js';

/**
 * Reference integrity (plan §4.4 "參照完整性"). Scoped to what RefIndex and
 * the L2 decompiler actually know about — Tier 1 command codes (§4.3). A
 * dangling weapon/armor/skill/state/troop/class id would need Tier 2/3
 * command support this repo doesn't have yet (see CLAUDE.md), so those
 * tables aren't checked; nothing here pretends otherwise.
 */
export async function checkReferences(session: ProjectSession): Promise<Finding[]> {
  const findings: Finding[] = [];
  checkDanglingIds(session, findings);
  checkTransferBounds(session, findings);
  await checkAssets(session, findings);
  return findings;
}

function idSet(session: ProjectSession, file: string): Set<number> {
  if (!session.listFiles().includes(file)) return new Set();
  const ids = new Set<number>();
  for (const entry of session.readFile<Array<{ id: number } | null>>(file)) {
    if (entry) ids.add(entry.id);
  }
  return ids;
}

/**
 * Switches/variables aren't a bounded table in MZ — any numeric id "works" at
 * runtime, it just shows blank in the editor. So an id with no name in
 * System.json isn't a broken reference, only a sign it was never allocated
 * (see idAllocator.ts's own caveat on this) — reported as a warning, not the
 * error a truly dangling item/actor/map/commonEvent id gets.
 */
function checkDanglingIds(session: ProjectSession, findings: Finding[]): void {
  const refIndex = RefIndex.build(session);
  const tables: Partial<Record<RefKind, Set<number>>> = {
    item: idSet(session, 'Items.json'),
    actor: idSet(session, 'Actors.json'),
    commonEvent: idSet(session, 'CommonEvents.json'),
    map: idSet(session, 'MapInfos.json'),
  };
  const system = session.listFiles().includes('System.json') ? session.readFile<SystemData>('System.json') : undefined;
  const namesByKind: Partial<Record<RefKind, string[]>> = {
    switch: system?.switches ?? [],
    variable: system?.variables ?? [],
  };

  for (const { kind, id, locations } of refIndex.entries()) {
    const names = namesByKind[kind];
    if (names) {
      if (!names[id]) {
        for (const loc of locations) {
          findings.push({
            rule: `references/unnamed-${kind}`,
            severity: 'warning',
            message: `${kind} ${id} is referenced but has no name in System.json (never allocated?)`,
            file: loc.file,
            path: loc.path,
          });
        }
      }
      continue;
    }
    const table = tables[kind];
    if (table && !table.has(id)) {
      for (const loc of locations) {
        findings.push({
          rule: `references/dangling-${kind}`,
          severity: 'error',
          message: `${kind} ${id} is referenced but does not exist`,
          file: loc.file,
          path: loc.path,
        });
      }
    }
  }
}

function mapFileName(id: number): string {
  return `Map${String(id).padStart(3, '0')}.json`;
}

function checkTransferBounds(session: ProjectSession, findings: Finding[]): void {
  forEachCommandList(session, (ctx) => {
    const nodes = tryDecompile(ctx.list);
    if (!nodes) return;
    walkNodes(nodes, (node) => {
      if (node.kind !== 'transfer') return;
      const file = mapFileName(node.mapId);
      // A nonexistent target map is already reported as references/dangling-map.
      if (!session.listFiles().includes(file)) return;
      const target = session.readFile<MapData>(file);
      if (node.x < 0 || node.x >= target.width || node.y < 0 || node.y >= target.height) {
        findings.push({
          rule: 'references/transfer-out-of-bounds',
          severity: 'error',
          message: `Transfer target (${node.x}, ${node.y}) is outside Map${node.mapId} (${target.width}x${target.height})`,
          file: ctx.file,
          path: ctx.path,
        });
      }
    });
  });
}

/**
 * Face / character / SE filenames are stored without extension. A missing
 * asset directory means the check can't say anything (not that every
 * reference in it is broken), so it's silently skipped rather than flagging
 * every reference — real signal only comes once the directory exists.
 */
async function checkAssets(session: ProjectSession, findings: Finding[]): Promise<void> {
  const dirCache = new Map<string, string[] | null>();
  async function listDir(rel: string): Promise<string[] | null> {
    if (!dirCache.has(rel)) {
      try {
        dirCache.set(rel, await readdir(path.join(session.rootPath, rel)));
      } catch {
        dirCache.set(rel, null);
      }
    }
    return dirCache.get(rel)!;
  }

  async function check(rel: string, name: string | undefined, ctx: { file: string; path: string }): Promise<void> {
    if (!name) return;
    const entries = await listDir(rel);
    if (!entries) return;
    const stripped = entries.map((f) => f.replace(/\.[^./]+$/, ''));
    if (stripped.includes(name)) return;
    const caseInsensitiveMatch = stripped.find((f) => f.toLowerCase() === name.toLowerCase());
    findings.push({
      rule: caseInsensitiveMatch ? 'references/asset-case-mismatch' : 'references/asset-missing',
      severity: caseInsensitiveMatch ? 'warning' : 'error',
      message: caseInsensitiveMatch
        ? `${rel}/${name} differs only in case from existing file "${caseInsensitiveMatch}" — breaks on case-sensitive filesystems`
        : `${rel}/${name} does not exist`,
      file: ctx.file,
      path: ctx.path,
    });
  }

  const tasks: Promise<void>[] = [];
  forEachCommandList(session, (ctx: ListContext) => {
    if (ctx.kind === 'mapEventPage' && ctx.image?.characterName) {
      tasks.push(check('img/characters', ctx.image.characterName, ctx));
    }
    const nodes = tryDecompile(ctx.list);
    if (!nodes) return;
    walkNodes(nodes, (node) => {
      if (node.kind === 'text') tasks.push(check('img/faces', node.face, ctx));
      if (node.kind === 'playSe') tasks.push(check('audio/se', node.name, ctx));
    });
  });
  await Promise.all(tasks);
}
