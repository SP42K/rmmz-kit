import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { utimes, readFile } from 'node:fs/promises';
import path from 'node:path';
import { openProject } from '../src/session.js';
import { makeTestProject } from './testProject.js';

const execFileAsync = promisify(execFile);

// Built-in module exports are non-configurable, so vi.spyOn can't patch
// `rename` directly (see atomicWrite.ts's import). vi.mock intercepts the
// module at resolution time instead, wrapping only `rename` while every
// other call (readFile, utimes, mkdtemp, ...) passes through untouched.
const renameMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  renameMock.mockImplementation(actual.rename);
  return { ...actual, rename: renameMock };
});

describe('ProjectSession', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  it('reads fixture data files into memory on open', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    expect(session.listFiles()).toContain('System.json');
    const system = session.readFile<{ gameTitle: string }>('System.json');
    expect(typeof system.gameTitle).toBe('string');
  });

  it('100 in-memory edits + one commit: only the touched file changes on disk, git diff has exactly one commit touching exactly that file', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    for (let i = 0; i < 100; i++) {
      session.updateFile<{ gameTitle: string }>('System.json', (data) => {
        data.gameTitle = `Title ${i}`;
      });
    }
    const hash = await session.commit('feat: rename game 100 times');
    expect(hash).not.toBeNull();

    const { stdout } = await execFileAsync('git', ['show', '--stat', '--format=', hash!], { cwd: dir });
    const touchedFiles = stdout
      .trim()
      .split('\n')
      .filter((l) => l.includes('|'))
      .map((l) => l.split('|')[0].trim());
    expect(touchedFiles).toEqual(['data/System.json']);

    const onDisk = JSON.parse(await readFile(path.join(dir, 'data/System.json'), 'utf-8'));
    expect(onDisk.gameTitle).toBe('Title 99');
  });

  it('writes fully compact JSON to disk (no reformatting of untouched structure)', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    session.updateFile<{ gameTitle: string }>('System.json', (data) => {
      data.gameTitle = 'Compact Test';
    });
    await session.commit('feat: compact write');

    const text = await readFile(path.join(dir, 'data/System.json'), 'utf-8');
    expect(text.split('\n')).toHaveLength(1);
  });

  it('rollback discards in-memory edits and writes nothing on next commit', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    const before = await readFile(path.join(dir, 'data/System.json'), 'utf-8');

    session.updateFile<{ gameTitle: string }>('System.json', (data) => {
      data.gameTitle = 'Should Not Persist';
    });
    session.rollback();

    const hash = await session.commit('feat: nothing to commit');
    expect(hash).toBeNull();
    expect(await readFile(path.join(dir, 'data/System.json'), 'utf-8')).toBe(before);
  });

  it('validate() fails and commit() throws (writing nothing) if a tracked file changed on disk since open', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    session.updateFile<{ gameTitle: string }>('System.json', (data) => {
      data.gameTitle = 'Editor Won Race';
    });

    // Simulate the editor (or another process) touching a tracked file
    // after we opened the session but before we commit.
    const mapPath = path.join(dir, 'data/Map001.json');
    const future = new Date(Date.now() + 5000);
    await utimes(mapPath, future, future);

    const report = await session.validate();
    expect(report.errors.length).toBeGreaterThan(0);
    await expect(session.commit('feat: should be rejected')).rejects.toThrow(/validation failed/);

    // Nothing was written.
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir });
    expect(stdout.trim()).toBe('');
  });

  it('crash partway through a multi-file commit leaves every file individually intact (atomic rename per file)', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    session.updateFile<{ gameTitle: string }>('System.json', (data) => {
      data.gameTitle = 'First File Lands';
    });
    session.updateFile<unknown[]>('Actors.json', (data) => {
      (data as any[]).push({ id: 999, name: 'Crash Test Actor' });
    });

    const actorsBefore = await readFile(path.join(dir, 'data/Actors.json'), 'utf-8');

    // Simulate the process dying between the two files' renames: let the
    // first rename() succeed, force the second to reject.
    const { rename: realRename } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let calls = 0;
    renameMock.mockImplementation(async (...args: Parameters<typeof realRename>) => {
      calls++;
      if (calls === 2) throw new Error('simulated crash');
      return realRename(...args);
    });

    await expect(session.commit('feat: two files, crash on the second')).rejects.toThrow('simulated crash');
    renameMock.mockImplementation(realRename);

    // Whichever file got its rename in is fully updated and valid JSON;
    // whichever didn't is byte-identical to before (never touched), not
    // half-written. Neither state is corruption.
    const systemText = await readFile(path.join(dir, 'data/System.json'), 'utf-8');
    const actorsText = await readFile(path.join(dir, 'data/Actors.json'), 'utf-8');
    expect(() => JSON.parse(systemText)).not.toThrow();
    expect(() => JSON.parse(actorsText)).not.toThrow();
    expect(actorsText).toBe(actorsBefore);
  });
});
