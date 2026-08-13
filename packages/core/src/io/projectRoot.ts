import { readdir, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';

const PROJECT_FILE_NAME = 'Game.rmmzproject';

/**
 * `file` relative to `root`, always with `/` separators — the form every
 * root-relative match in this package is written against (`writeRaw`'s paths,
 * `deploy`'s EXCLUDED/prunable roots, `createProject`'s RUNTIME_SKIP).
 *
 * The realpath fallback is not decoration. Windows hands out two spellings of
 * the same directory — `C:\Users\RUNNER~1` and `C:\Users\runneradmin` — and
 * `os.tmpdir()` returns the 8.3 short one on a GitHub runner. Spell the two
 * ends differently and `path.relative` walks up to the common ancestor instead,
 * so every match below it misses *silently*: the project marker ships, nothing
 * is pruned, the AutoTest warning never fires. `realpathSync.native` resolves
 * both spellings, and only runs on the path that is already wrong.
 */
export function relativeUnderRoot(root: string, file: string): string {
  let rel = path.relative(root, file);
  if (rel.startsWith('..')) rel = path.relative(realpathSync.native(root), realpathSync.native(file));
  return rel.split(path.sep).join('/');
}

/**
 * Confirms `dirPath` is an RPG Maker MZ project root by looking for its
 * project marker file case-insensitively. k4zuki's reference implementation
 * hardcoded the lowercase `game.rmmzproject`, which silently fails to find
 * real projects (the editor writes `Game.rmmzproject`) on case-sensitive
 * filesystems. `fs.readdir` + manual compare works on every platform,
 * unlike `fs.access` with a fixed-case path.
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
