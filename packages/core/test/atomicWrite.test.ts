import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from '../src/io/atomicWrite.js';

describe('atomicWriteFile', () => {
  it('replaces file content on success', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rmmz-atomic-'));
    const target = path.join(dir, 'data.json');
    await writeFile(target, 'old');

    await atomicWriteFile(target, 'new');

    expect(await readFile(target, 'utf-8')).toBe('new');
    // no leftover temp files
    expect(await readdir(dir)).toEqual(['data.json']);

    await rm(dir, { recursive: true, force: true });
  });

  it('leaves the original file untouched if the write is interrupted before rename', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rmmz-atomic-crash-'));
    const target = path.join(dir, 'data.json');
    await writeFile(target, 'original content');

    // Simulate a crash mid-write: the temp file gets created, but nothing
    // ever renames it over the target. This is what an atomic rename buys:
    // even a temp file that never completes leaves the real file intact.
    await writeFile(path.join(dir, '.data.json.deadbeef.tmp'), 'half-written garbage');

    expect(await readFile(target, 'utf-8')).toBe('original content');

    await rm(dir, { recursive: true, force: true });
  });

  it('cleans up the temp file and rethrows if rename fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rmmz-atomic-fail-'));
    // Renaming into a directory that doesn't exist forces rename() to fail.
    const target = path.join(dir, 'missing-subdir', 'data.json');

    await expect(atomicWriteFile(target, 'content')).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });
});
