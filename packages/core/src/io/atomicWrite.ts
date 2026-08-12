import { randomBytes } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Writes `content` to `filePath` atomically: write to a temp file in the same
 * directory, then rename over the target. Rename is atomic only within the
 * same filesystem/volume, which is why the temp file lives next to the target.
 * A crash before rename leaves the original file untouched; a crash after
 * rename leaves the new content fully written. There is no partial-write state.
 *
 * The temp file is fsync'd before the rename, because without it the rename
 * can reach disk ahead of the data blocks and a power loss leaves a truncated
 * or zero-length data file — the exact corruption this function exists to
 * prevent. The *directory* entry is not fsync'd (Windows can't), so a power
 * loss can still lose the rename itself and leave the old content: stale, but
 * never corrupt, which is the tradeoff we want.
 */
export async function atomicWriteFile(filePath: string, content: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`);

  const handle = await open(tmpPath, 'w');
  try {
    try {
      // The encoding is ignored when `content` is bytes (an imported asset).
      await handle.writeFile(content, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, filePath);
  } catch (err) {
    // Never leave a stray .tmp behind in the project's data/ directory.
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}
