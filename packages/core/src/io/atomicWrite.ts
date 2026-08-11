import { randomBytes } from 'node:crypto';
import { rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Writes `content` to `filePath` atomically: write to a temp file in the same
 * directory, then rename over the target. Rename is atomic only within the
 * same filesystem/volume, which is why the temp file lives next to the target.
 * A crash before rename leaves the original file untouched; a crash after
 * rename leaves the new content fully written. There is no partial-write state.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`);

  await writeFile(tmpPath, content, 'utf-8');
  try {
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}
