import { readdir, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';

const PROJECT_FILE_NAME = 'Game.rmmzproject';

/**
 * Windows has more than one spelling for the same file, and `path.relative`
 * treats a difference in spelling as a difference in *location*:
 *
 * - **Extended-length form.** `fs.cp` hands its `filter` paths like
 *   `\\?\C:\Users\...`, while the root the caller passed is a plain `C:\...`.
 *   `path.relative` sees two different roots and returns the whole second path.
 * - **8.3 short names.** `os.tmpdir()` is `C:\Users\RUNNER~1\...` on a GitHub
 *   runner for a directory `fs` reports as `C:\Users\runneradmin\...`.
 *
 * Neither is exotic — between them they are why seven deploy/createProject
 * tests failed the first time this repo ran its suite on Windows CI.
 */
function plainWin32Path(value: string): string {
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`;
  if (value.startsWith('\\\\?\\')) return value.slice(4);
  return value;
}

/**
 * `file` relative to `root`, always with `/` separators — the form every
 * root-relative match in this package is written against (`deploy`'s EXCLUDED
 * and prunable roots, `createProject`'s RUNTIME_SKIP).
 *
 * Getting this wrong fails *silently in the worst direction*: nothing matches,
 * so the project marker ships in the build, no unused asset is pruned, and
 * `runtimeFrom` copies the source project's plugin list. Hence two passes —
 * strip the extended-length prefix first (cheap, string-only), and only if the
 * answer still escapes the root pay for `realpathSync.native`, which is the one
 * call that collapses the short and long spellings of a directory.
 */
export function relativeUnderRoot(root: string, file: string): string {
  let rel = path.relative(plainWin32Path(root), plainWin32Path(file));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    rel = path.relative(plainWin32Path(realpathSync.native(root)), plainWin32Path(realpathSync.native(file)));
  }
  return rel.split(path.sep).join('/');
}

/**
 * Confirms `dirPath` is an RPG Maker MZ project root by looking for its
 * project marker file case-insensitively — which case the editor actually
 * writes was an open question until a licensed install answered it: **MZ 1.9.x
 * writes lowercase `game.rmmzproject`**. The comment here used to assert
 * `Game.rmmzproject`, so the reasoning was inverted even though the behaviour
 * was already right; `PROJECT_FILE_NAME` is only ever compared
 * case-insensitively, and `deploy`'s exclusion list lowercases before matching.
 *
 * Getting the case wrong fails silently in the worst direction on a
 * case-sensitive filesystem: nothing matches, so `openProject` refuses a real
 * project and the marker ships inside a build. `fs.readdir` + manual compare
 * works on every platform, unlike `fs.access` with a fixed-case path.
 */
export async function findProjectFile(dirPath: string): Promise<string | null> {
  const entries = await readdir(dirPath);
  const match = entries.find((name) => name.toLowerCase() === PROJECT_FILE_NAME.toLowerCase());
  return match ?? null;
}

export async function assertProjectRoot(dirPath: string): Promise<void> {
  const stats = await stat(dirPath).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }
  const projectFile = await findProjectFile(dirPath);
  if (!projectFile) {
    throw new Error(`Not an RPG Maker MZ project (no ${PROJECT_FILE_NAME} found): ${dirPath}`);
  }
}

/** `1` -> `Map001.json`. Zero-padded to 3 digits, which is what the editor writes (ids past 999 just get longer). */
export function mapFileName(id: number): string {
  return `Map${String(id).padStart(3, '0')}.json`;
}

export async function listDataFiles(dirPath: string): Promise<string[]> {
  const dataDir = path.join(dirPath, 'data');
  const entries = await readdir(dataDir);
  return entries.filter((name) => name.endsWith('.json')).sort();
}
