import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const PROJECT_FILE_NAME = 'Game.rmmzproject';

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

export async function listDataFiles(dirPath: string): Promise<string[]> {
  const dataDir = path.join(dirPath, 'data');
  const entries = await readdir(dataDir);
  return entries.filter((name) => name.endsWith('.json')).sort();
}
