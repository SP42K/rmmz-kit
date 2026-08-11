import { stat } from 'node:fs/promises';

/**
 * MZ has no documented lock file (verified: the editor itself only detects
 * conflicts reactively, popping a "Project data has been modified externally"
 * dialog after the fact — see docs/rmmz-automation-implementation-plan.md R3).
 * We do the same: snapshot each tracked file's mtime at open, and compare
 * again before commit. If anything changed on disk since we opened it —
 * the editor autosaving, a human editing, another process — we refuse to
 * write over it rather than silently clobbering unseen changes.
 */
export class EditorLockSnapshot {
  private readonly mtimes = new Map<string, number>();

  static async capture(filePaths: string[]): Promise<EditorLockSnapshot> {
    const snapshot = new EditorLockSnapshot();
    await Promise.all(
      filePaths.map(async (filePath) => {
        // A file that isn't there is recorded as -1 rather than throwing:
        // capture() runs on the failure path of commit() too, and must not
        // mask the real error. -1 never matches a real mtime, so a file that
        // reappears still reads as drift.
        const stats = await stat(filePath).catch(() => null);
        snapshot.mtimes.set(filePath, stats?.mtimeMs ?? -1);
      })
    );
    return snapshot;
  }

  /** Returns the file paths whose mtime no longer matches the snapshot. */
  async findDrift(): Promise<string[]> {
    const drifted: string[] = [];
    for (const [filePath, capturedMtime] of this.mtimes) {
      const stats = await stat(filePath).catch(() => null);
      if (!stats || stats.mtimeMs !== capturedMtime) {
        drifted.push(filePath);
      }
    }
    return drifted;
  }
}
