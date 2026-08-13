import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { assertProjectRoot, listDataFiles } from './io/projectRoot.js';
import { parseJson, stringifyCompact } from './io/format.js';
import { NAMESPACES_FILE } from './namespaces.js';

/**
 * Deployment export (plan §3 M11). Sits in core, not its own package: it is
 * L0 work — copy a directory tree, minus the files the shipped game doesn't
 * need — and the plan itself notes M11 "只依賴 L0/L1".
 *
 * Deliberately a plain function over a *path*, not a ProjectSession: what gets
 * deployed is what is on disk, the same call `playtest` makes and for the same
 * reason. Deploying a session's uncommitted memory would ship a build that
 * matches no commit; the MCP tool reports dirty files instead so the caller
 * commits first.
 */

export type DeployTarget = 'web' | 'windows';

export interface DeployOptions {
  /** Where to write the package. Must be outside the project, and empty unless `overwrite`. */
  outDir: string;
  /** 'web' (default) writes the playable directory; 'windows' wraps it in an NW.js shell. */
  target?: DeployTarget;
  /** Drop img//audio/ files nothing in the project refers to. Default true. */
  excludeUnusedAssets?: boolean;
  /** An unpacked NW.js distribution (nw.exe + its libraries). Required by target 'windows'. */
  nwPath?: string;
  /** Replace a non-empty outDir instead of refusing. Its previous contents are deleted. */
  overwrite?: boolean;
}

export interface DeployReport {
  target: DeployTarget;
  outDir: string;
  /** Files written into the package. */
  files: number;
  bytes: number;
  /** Asset files left out because nothing referenced them, root-relative. */
  pruned: string[];
  warnings: string[];
}

/**
 * Files a *player* never needs, and one (`save/`) they must not receive: the
 * editor's project marker would let a leaked build be reopened as a project,
 * and shipping the developer's save files is how a test playthrough ends up in
 * a release. `.git`/`node_modules` are this toolchain's, not the game's.
 */
const EXCLUDED = new Set(['.git', '.gitignore', 'node_modules', 'save', 'game.rmmzproject']);

/** MZ hardcodes these filenames (IconSet, Window, Balloon, Damage, …), so nothing in data/ refers to them. */
const NEVER_PRUNE = ['img/system/'];

const PRUNABLE_ROOTS = ['img/', 'audio/'];

export async function deployProject(rootPath: string, options: DeployOptions): Promise<DeployReport> {
  await assertProjectRoot(rootPath);
  const target = options.target ?? 'web';
  const outDir = path.resolve(options.outDir);
  const root = path.resolve(rootPath);

  // Copying a directory into itself is an infinite tree; `cp` would either
  // recurse until the filesystem complains or half-write a bundle containing a
  // bundle. Cheaper to refuse than to explain afterwards.
  const relToRoot = path.relative(root, outDir);
  if (relToRoot === '' || (!relToRoot.startsWith('..') && !path.isAbsolute(relToRoot))) {
    throw new Error(`Deploy output must be outside the project: ${outDir}`);
  }
  // And not the other way round either, now that `overwrite` deletes what it
  // finds: deploying D:/project into D:/ used to merely litter, and would now
  // take the project with it.
  const relToOut = path.relative(outDir, root);
  if (!relToOut.startsWith('..') && !path.isAbsolute(relToOut)) {
    throw new Error(`Deploy output must not contain the project: ${outDir}`);
  }
  await assertEmpty(outDir, options.overwrite ?? false);

  const gameDir = target === 'windows' ? path.join(outDir, 'www') : outDir;
  const report: DeployReport = { target, outDir, files: 0, bytes: 0, pruned: [], warnings: [] };

  // The reference scan can refuse the whole deploy (an unparseable data file),
  // so it runs before anything is written — otherwise a failed windows deploy
  // leaves a few hundred MB of NW.js runtime in outDir and no game.
  const keep = (options.excludeUnusedAssets ?? true) ? await referencedNames(root, report) : null;

  // Replace, don't merge: a redeploy after deleting an actor lists that actor's
  // face in `report.pruned` while the previous build's copy is still sitting in
  // outDir, so the report and the directory that actually ships disagree. Runs
  // after the scan above, for the reason that scan runs first — a refused deploy
  // must leave the previous build intact.
  if (options.overwrite) await rm(outDir, { recursive: true, force: true });

  if (target === 'windows') {
    await copyNwShell(root, outDir, options.nwPath, report);
  }

  await mkdir(gameDir, { recursive: true });
  await cp(root, gameDir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(root, src);
      if (rel === '') return true;
      // Matched case-insensitively, for the same reason `findProjectFile` looks
      // for the marker that way: `Game.rmmzproject` is what the editor writes,
      // but a lowercase one is a project this toolchain accepts — and shipping
      // it is exactly what this exclusion exists to prevent.
      const lower = rel.toLowerCase();
      if (EXCLUDED.has(lower.split('/')[0]) || lower.endsWith('.rmmzsave')) return false;
      // The allocator's namespace registry is dev metadata like the project
      // marker: the game never fetches it, and it names every quest flag.
      if (lower === `data/${NAMESPACES_FILE.toLowerCase()}`) return false;
      const stats = statSync(src);
      if (stats.isDirectory()) return true;
      if (keep && isPrunable(rel) && !keep.has(assetKey(rel))) {
        report.pruned.push(rel);
        return false;
      }
      report.files += 1;
      report.bytes += stats.size;
      if (rel === 'js/plugins/AutoTest.js') {
        report.warnings.push('AutoTest.js is in this build — window.__AT lets anyone drive the game. Disable it in js/plugins.js before shipping.');
      }
      return true;
    },
  });

  return report;
}

async function assertEmpty(outDir: string, overwrite: boolean): Promise<void> {
  if (overwrite) return;
  const entries = await readdir(outDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  if (entries.length > 0) {
    throw new Error(`Deploy output directory is not empty: ${outDir} (pass overwrite to replace its contents)`);
  }
}

/**
 * The NW.js runtime is a third-party binary distribution this repo neither
 * ships nor downloads (the same licensing wall M8 hit with MZ's own runtime),
 * so the caller points at an unpacked copy and this only does the shell
 * assembly the editor does: nw.exe renamed to the game, `www/` beside it, and
 * the package.json NW.js reads to find the entry point.
 */
async function copyNwShell(root: string, outDir: string, nwPath: string | undefined, report: DeployReport): Promise<void> {
  if (!nwPath) {
    throw new Error(
      'target "windows" needs nwPath: the path to an unpacked NW.js distribution (nw.exe and its libraries). ' +
        'This tool cannot download one — get it from nwjs.io, or deploy target "web" and wrap it yourself.'
    );
  }
  const nwDir = path.resolve(nwPath);
  if (!(await stat(nwDir).then((s) => s.isDirectory(), () => false))) {
    throw new Error(`nwPath is not a directory: ${nwDir}`);
  }

  await cp(nwDir, outDir, {
    recursive: true,
    filter: (src) => {
      const stats = statSync(src);
      if (!stats.isDirectory()) {
        report.files += 1;
        report.bytes += stats.size;
      }
      return true;
    },
  });

  const title = await readGameTitle(root);
  const exeName = `${title.replace(/[\\/:*?"<>|]/g, '_') || 'Game'}.exe`;
  await rename(path.join(outDir, 'nw.exe'), path.join(outDir, exeName)).catch(() => {
    report.warnings.push('No nw.exe in nwPath — the shell was copied as-is, so nothing was renamed to the game executable.');
  });

  // NW.js reads this, not index.html: without `main` it opens a blank window.
  await writeFile(
    path.join(outDir, 'package.json'),
    stringifyCompact({
      name: title || 'game',
      main: 'www/index.html',
      'js-flags': '--expose-gc',
      window: { title, width: 816, height: 624, icon: 'www/icon/icon.png' },
    }),
    'utf-8'
  );
  report.files += 1;
}

async function readGameTitle(root: string): Promise<string> {
  const text = await readFile(path.join(root, 'data', 'System.json'), 'utf-8').catch(() => null);
  if (!text) return '';
  const system = parseJson(text) as { gameTitle?: unknown };
  return typeof system.gameTitle === 'string' ? system.gameTitle : '';
}

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function isPrunable(rel: string): boolean {
  return PRUNABLE_ROOTS.some((dir) => rel.startsWith(dir)) && !NEVER_PRUNE.some((dir) => rel.startsWith(dir));
}

/** `img/faces/Actor1.png` -> `actor1`. MZ stores asset references without the extension. */
function assetKey(rel: string): string {
  return path.basename(rel, path.extname(rel)).toLowerCase();
}

/**
 * Every string in the project's data, lowercased. Not RefIndex, which the plan
 * names here: RefIndex is an index of numeric *ids* (switch 7, Map012) built
 * from event commands, and asset references are strings living mostly outside
 * events entirely — an actor's faceName, a tileset's tilesetNames, System's
 * title screen and its 24 system SEs. Teaching RefIndex string kinds would mean
 * enumerating every asset-bearing field of every table, which is exactly the
 * per-table modeling §4.5 says not to build.
 *
 * So the collector is deliberately blunt: take *every* string, and keep any
 * asset whose basename matches one. It over-keeps (an item named "Slime" keeps
 * img/enemies/Slime.png), and that is the correct direction to be wrong in —
 * a kept-but-unused file is a few KB, a pruned-but-used one is a game that
 * fails to load a sprite in front of a player, silently, in a build nobody
 * runs before release.
 */
async function referencedNames(root: string, report: DeployReport): Promise<Set<string>> {
  const names = new Set<string>();
  for (const file of await listDataFiles(root)) {
    // A data file we can't parse means "we don't know what this project
    // references", and the only safe answer to that is not to prune at all.
    const text = await readFile(path.join(root, 'data', file), 'utf-8');
    try {
      collectStrings(parseJson(text), names);
    } catch (err) {
      throw new Error(`Cannot deploy with asset pruning: data/${file} is not valid JSON (${(err as Error).message})`);
    }
  }

  // Plugin parameters are free-form text (often JSON-in-a-string), so they are
  // scanned as loose tokens rather than parsed — over-keeping again. Assets a
  // plugin builds by string concatenation are still invisible to this, which is
  // what the warning is for.
  const plugins = await readFile(path.join(root, 'js', 'plugins.js'), 'utf-8').catch(() => null);
  if (plugins) {
    for (const token of plugins.match(/[\w!$][\w!$ -]*/g) ?? []) names.add(token.trim().toLowerCase());
    if (/"name"\s*:/.test(plugins)) {
      report.warnings.push('Assets referenced only from plugin code (not plugin parameters) cannot be detected — check the build if a plugin loads images by name.');
    }
  }
  return names;
}

function collectStrings(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    if (value) into.add(value.toLowerCase());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
}
