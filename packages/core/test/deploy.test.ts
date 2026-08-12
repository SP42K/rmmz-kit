import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deployProject } from '../src/deploy.js';
import { makeTestProject } from './testProject.js';

/** The fixture ships no art or audio, so pruning needs assets to prune. */
async function addAssets(dir: string): Promise<void> {
  for (const rel of [
    'img/faces/Actor1.png', // Actors.json refers to this by faceName
    'img/faces/Unused.png',
    'img/system/Window.png', // never referenced from data — MZ hardcodes it
    'audio/se/Cursor1.ogg',
    'save/file1.rmmzsave',
  ]) {
    await mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(dir, rel), 'x');
  }
}

describe('deployProject', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  async function outDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'rmmz-deploy-out-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return path.join(dir, 'package');
  }

  it('web: copies the game, drops the project file and save data, prunes unreferenced assets', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    await addAssets(dir);
    const out = await outDir();

    const report = await deployProject(dir, { outDir: out });

    const files = new Set(await listTree(out));
    expect(files.has('data/System.json')).toBe(true);
    expect(files.has('index.html')).toBe(true);
    // Referenced by name, hardcoded by the engine, and referenced by nothing.
    expect(files.has('img/faces/Actor1.png')).toBe(true);
    expect(files.has('img/system/Window.png')).toBe(true);
    expect(files.has('img/faces/Unused.png')).toBe(false);
    expect(files.has('audio/se/Cursor1.ogg')).toBe(false);
    // The editor's marker and the developer's saves are not the player's.
    expect(files.has('Game.rmmzproject')).toBe(false);
    expect(files.has('save/file1.rmmzsave')).toBe(false);
    expect([...files].some((f) => f.startsWith('.git/'))).toBe(false);

    expect(report.pruned.sort()).toEqual(['audio/se/Cursor1.ogg', 'img/faces/Unused.png']);
    expect(report.files).toBe(files.size);
    expect(report.bytes).toBeGreaterThan(0);
  });

  it('drops the project marker whatever its case', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    // assertProjectRoot accepts a lowercase marker on purpose, so deploy has to
    // exclude it on the same terms — otherwise the build reopens as a project.
    await rename(path.join(dir, 'Game.rmmzproject'), path.join(dir, 'game.rmmzproject'));
    const out = await outDir();

    await deployProject(dir, { outDir: out });

    expect(await listTree(out)).not.toContain('game.rmmzproject');
  });

  it('excludeUnusedAssets false keeps every asset', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    await addAssets(dir);
    const out = await outDir();

    const report = await deployProject(dir, { outDir: out, excludeUnusedAssets: false });

    expect(report.pruned).toEqual([]);
    expect(await listTree(out)).toContain('img/faces/Unused.png');
  });

  it('keeps an asset named only in an event command parameter', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    await addAssets(dir);
    // Show Picture: the filename is a bare positional parameter, not a *Name field.
    const mapPath = path.join(dir, 'data', 'Map001.json');
    const map = JSON.parse(await readFile(mapPath, 'utf-8'));
    map.events[1].pages[0].list.unshift({ code: 231, indent: 0, parameters: [1, 'Unused', 0, 0, 0, 0, 100, 100, 255, 0] });
    await writeFile(mapPath, JSON.stringify(map));
    const out = await outDir();

    const report = await deployProject(dir, { outDir: out });

    expect(report.pruned).toEqual(['audio/se/Cursor1.ogg']);
  });

  it('refuses to deploy into the project, or into a non-empty directory', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    await expect(deployProject(dir, { outDir: path.join(dir, 'build') })).rejects.toThrow(/outside the project/);
    await expect(deployProject(dir, { outDir: dir })).rejects.toThrow(/outside the project/);

    const out = await outDir();
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'old.txt'), 'x');
    await expect(deployProject(dir, { outDir: out })).rejects.toThrow(/not empty/);
    await expect(deployProject(dir, { outDir: out, overwrite: true })).resolves.toBeTruthy();

    // The other direction matters once overwrite deletes: deploying into an
    // ancestor of the project would take the project with it.
    await expect(deployProject(dir, { outDir: path.dirname(dir) })).rejects.toThrow(/must not contain the project/);
  });

  it('overwrite replaces the previous build instead of merging into it', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    await addAssets(dir);
    const out = await outDir();

    await deployProject(dir, { outDir: out, excludeUnusedAssets: false });
    expect(await listTree(out)).toContain('img/faces/Unused.png');

    // A file the first build shipped and the second prunes must be gone, or
    // report.pruned and the directory that ships disagree.
    const report = await deployProject(dir, { outDir: out, overwrite: true });

    expect(report.pruned).toContain('img/faces/Unused.png');
    expect(await listTree(out)).not.toContain('img/faces/Unused.png');
    expect(await listTree(out)).toContain('img/faces/Actor1.png');
  });

  it('leaves the previous build alone when overwrite deploy is refused', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const out = await outDir();

    await deployProject(dir, { outDir: out });
    await writeFile(path.join(dir, 'data', 'Items.json'), '[null, {broken');

    await expect(deployProject(dir, { outDir: out, overwrite: true })).rejects.toThrow(/not valid JSON/);
    expect(await listTree(out)).toContain('data/System.json');
  });

  it('windows: needs an NW.js shell, then puts the game in www/ beside a renamed executable', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    await expect(deployProject(dir, { outDir: await outDir(), target: 'windows' })).rejects.toThrow(/nwPath/);

    const nw = await mkdtemp(path.join(tmpdir(), 'rmmz-nw-'));
    cleanups.push(() => rm(nw, { recursive: true, force: true }));
    await writeFile(path.join(nw, 'nw.exe'), 'MZ');
    await mkdir(path.join(nw, 'locales'));
    await writeFile(path.join(nw, 'locales', 'en-US.pak'), 'x');

    const out = await outDir();
    const report = await deployProject(dir, { outDir: out, target: 'windows', nwPath: nw });

    const files = new Set(await listTree(out));
    expect(files.has('www/data/System.json')).toBe(true);
    expect(files.has('locales/en-US.pak')).toBe(true);
    // The fixture's gameTitle is "Test Game".
    expect(files.has('Test Game.exe')).toBe(true);
    expect(files.has('nw.exe')).toBe(false);
    expect(JSON.parse(await readFile(path.join(out, 'package.json'), 'utf-8'))).toMatchObject({
      main: 'www/index.html',
      window: { title: 'Test Game' },
    });
    expect(report.warnings.some((w) => w.includes('nw.exe'))).toBe(false);
  });

  it('warns when the AutoTest automation plugin would ship with the build', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    await writeFile(path.join(dir, 'js', 'plugins', 'AutoTest.js'), '// window.__AT');

    const report = await deployProject(dir, { outDir: await outDir() });

    expect(report.warnings.some((w) => w.includes('AutoTest.js'))).toBe(true);
  });

  it('refuses to prune when a data file cannot be parsed', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    await writeFile(path.join(dir, 'data', 'Items.json'), '[null, {broken');

    await expect(deployProject(dir, { outDir: await outDir() })).rejects.toThrow(/not valid JSON/);
  });
});

async function listTree(dir: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listTree(path.join(dir, entry.name), rel)));
    else files.push(rel);
  }
  return files;
}
