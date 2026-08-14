import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { utimes, readFile, writeFile } from 'node:fs/promises';
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

    // The session must not blame its own successful write on an external
    // editor: the file it wrote before the failure is reconciled (baseline
    // and mtime snapshot both refreshed), so the session stays usable.
    expect((await session.validate()).errors).toEqual([]);
    expect(await session.commit('feat: retry after the failed write')).not.toBeNull();
    expect(await readFile(path.join(dir, 'data/Actors.json'), 'utf-8')).toContain('Crash Test Actor');
  });

  it('an edit that re-serializes byte-identical to HEAD commits nothing instead of failing', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    // First commit normalizes the pretty-printed fixture to compact JSON, so
    // the second session's identical edit really does stage zero bytes.
    const first = await openProject(dir);
    first.updateFile<{ gameTitle: string }>('System.json', (data) => {
      data.gameTitle = 'Same Title';
    });
    expect(await first.commit('feat: set title')).not.toBeNull();

    const second = await openProject(dir);
    second.updateFile<{ gameTitle: string }>('System.json', (data) => {
      data.gameTitle = 'Same Title';
    });
    expect(await second.commit('feat: no actual change')).toBeNull();
    // ...and the session is still usable afterwards.
    expect((await second.validate()).errors).toEqual([]);
  });

  it('createFile joins the transaction: readable at once, on disk and in git only after commit', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    session.createFile('Map002.json', { width: 5 });

    expect(session.listFiles()).toContain('Map002.json');
    expect(session.dirtyFiles()).toEqual(['Map002.json']);
    await expect(readFile(path.join(dir, 'data', 'Map002.json'), 'utf-8')).rejects.toThrow();

    expect(await session.commit('feat: add map')).not.toBeNull();
    expect(JSON.parse(await readFile(path.join(dir, 'data', 'Map002.json'), 'utf-8'))).toEqual({ width: 5 });
    const { stdout } = await execFileAsync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: dir });
    expect(stdout).toContain('data/Map002.json');
    // The commit's own write must not read back as external drift.
    expect((await session.validate()).errors).toEqual([]);
  });

  it('createFile refuses a file the session already has, and rollback forgets one it made', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    expect(() => session.createFile('System.json', {})).toThrow(/already exists/);

    session.createFile('Map002.json', { width: 5 });
    session.rollback();
    expect(session.listFiles()).not.toContain('Map002.json');
    expect(session.dirtyFiles()).toEqual([]);
    // ...and the name is free to create again, not stuck in the created set.
    expect(() => session.createFile('Map002.json', { width: 9 })).not.toThrow();
  });

  it('refuses to commit a created file that appeared on disk meanwhile', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    session.createFile('Map002.json', { width: 5 });
    // Another process (the editor) makes the same map first. The mtime snapshot
    // can't see this — the file didn't exist to be snapshotted — so it is the
    // created-set check or nothing.
    await writeFile(path.join(dir, 'data', 'Map002.json'), '{"width":99}');

    await expect(session.commit('feat: add map')).rejects.toThrow(/already exists on disk/);
    expect(JSON.parse(await readFile(path.join(dir, 'data', 'Map002.json'), 'utf-8'))).toEqual({ width: 99 });
  });

  it('writeRaw stages a non-data file until commit, and git-adds it', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    session.writeRaw('js/plugins.js', 'var $plugins = [];\n');
    // A folder the project doesn't have yet: commit() has to create it.
    session.writeRaw('img/characters/Hero.png', new Uint8Array([1, 2, 3]));

    expect(session.rawWriteFiles()).toEqual(['js/plugins.js', 'img/characters/Hero.png']);
    expect(await session.readRaw('js/plugins.js')).toBe('var $plugins = [];\n');
    // Nothing on disk yet — same rule as a dirty data file.
    expect(await readFile(path.join(dir, 'img', 'characters', 'Hero.png')).catch(() => null)).toBeNull();

    await session.commit('feat: add plugin and character');

    expect(await readFile(path.join(dir, 'js', 'plugins.js'), 'utf-8')).toBe('var $plugins = [];\n');
    expect([...(await readFile(path.join(dir, 'img', 'characters', 'Hero.png')))]).toEqual([1, 2, 3]);
    expect(session.rawWriteFiles()).toEqual([]);
    const { stdout } = await execFileAsync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: dir });
    expect(stdout).toContain('img/characters/Hero.png');
  });

  it('rollback drops staged non-data writes, and reads fall back to disk', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    const original = await session.readRaw('js/plugins.js');
    session.writeRaw('js/plugins.js', 'var $plugins = [];\n');
    session.rollback();

    expect(session.rawWriteFiles()).toEqual([]);
    expect(await session.readRaw('js/plugins.js')).toBe(original);
    expect(await session.readRaw('js/nope.js')).toBeNull();
  });

  it('refuses a raw path that escapes the project root', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    // The path comes from an MCP client, and this channel exists to write
    // outside data/ — so the only thing between it and the user's filesystem
    // is this check.
    expect(() => session.writeRaw('../evil.js', 'x')).toThrow(/escapes the project root/);
    expect(() => session.writeRaw('js/../../evil.js', 'x')).toThrow(/escapes the project root/);
    expect(() => session.writeRaw(path.join(dir, 'evil.js'), 'x')).toThrow(/escapes the project root/);
  });

  it('deleteFile: gone from the session immediately, gone from disk and git only at commit', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    session.deleteFile('Animations.json');
    expect(session.listFiles()).not.toContain('Animations.json');
    expect(() => session.readFile('Animations.json')).toThrow(/Unknown data file/);
    expect(session.deletedDataFiles()).toEqual(['Animations.json']);
    // Nothing has touched disk yet.
    expect(await readFile(path.join(dir, 'data', 'Animations.json'), 'utf-8')).toBeTruthy();

    const hash = await session.commit('chore: drop Animations');
    expect(hash).not.toBeNull();
    await expect(readFile(path.join(dir, 'data', 'Animations.json'), 'utf-8')).rejects.toThrow();
    // The deletion is staged and committed, not left as a dirty worktree entry.
    const { stdout } = await execFileAsync('git', ['-C', dir, 'status', '--porcelain']);
    expect(stdout.trim()).toBe('');
    expect(session.deletedDataFiles()).toEqual([]);
  });

  it('rollback resurrects a deleted file, and deleting a created file just forgets it', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    session.deleteFile('Animations.json');
    session.createFile('Map099.json', { note: 'ephemeral' });
    session.deleteFile('Map099.json');
    expect(session.dirtyFiles()).toEqual([]);

    session.rollback();
    expect(session.listFiles()).toContain('Animations.json');
    expect(session.listFiles()).not.toContain('Map099.json');
    expect(await session.commit('feat: nothing left to commit')).toBeNull();
  });

  it('createFile over a pending deletion is a replace, not a "created" file', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    session.deleteFile('Animations.json');
    session.createFile('Animations.json', []);
    expect(session.deletedDataFiles()).toEqual([]);
    // The created-file validate check ("already exists on disk") must not fire:
    // the file being on disk is exactly what a replace expects.
    expect((await session.validate()).errors).toEqual([]);
    await session.commit('chore: empty out Animations');
    expect(JSON.parse(await readFile(path.join(dir, 'data', 'Animations.json'), 'utf-8'))).toEqual([]);
  });
});
