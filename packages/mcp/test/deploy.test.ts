import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openProject } from '@rmmz-kit/core';
import { validateProject } from '@rmmz-kit/validate';
import { startPlaytestServer } from '@rmmz-kit/playtest';
import * as tools from '../src/tools.js';
import { makeTestProject } from './testProject.js';

/**
 * M11's acceptance, as far as it can be checked from here: the created project
 * is one the *rest of this toolchain* accepts (open + validate clean), and the
 * deployed bundle is one a browser can actually read (served over the playtest
 * server, which is the same http server the editor's Playtest button stands in
 * for). Whether the editor opens it, and whether the bundle plays through, both
 * need the paid editor's runtime — see createProject.ts.
 */
describe('deploy / create_project', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  async function scratch(name: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'rmmz-m11-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return path.join(dir, name);
  }

  it('create_project produces a project that opens and validates clean', async () => {
    const dir = await scratch('NewGame');

    const result = await tools.createProjectTool(dir, { title: 'New Game' });
    expect(result.dataFiles).toContain('data/System.json');

    const session = await openProject(dir);
    const findings = await validateProject(session);
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('deploy names the files that are still only in memory', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    tools.updateSystem(session, { gameTitle: 'Uncommitted' });

    const report = await tools.deploy(session, { outDir: await scratch('build') });

    expect(report.uncommitted).toEqual(['System.json']);
    expect(report.warnings as string[]).toContainEqual(expect.stringContaining('still only in memory'));
  });

  it('the deployed bundle is servable: data loads over http, the project file is gone', async () => {
    const dir = await scratch('NewGame');
    await tools.createProjectTool(dir, { title: 'Servable' });
    const session = await openProject(dir);
    const out = await scratch('build');

    // The namespace registry is dev metadata; a build must not ship it.
    tools.allocateNamespace(session, 'quest.main', { switches: ['done'] });
    await session.commit('test: allocate a namespace');

    await tools.deploy(session, { outDir: out });

    const server = await startPlaytestServer(out);
    cleanups.push(() => server.close());
    const system = await fetch(`${server.url}/data/System.json`);
    expect(system.status).toBe(200);
    expect((await system.json()).gameTitle).toBe('Servable');
    expect((await fetch(`${server.url}/Game.rmmzproject`)).status).toBe(404);
    expect((await fetch(`${server.url}/data/RmmzKitNamespaces.json`)).status).toBe(404);
  });

  it('target macos assembles a .app with the game in Contents/Resources/app.nw, and warns about signing', async () => {
    const dir = await scratch('MacGame');
    await tools.createProjectTool(dir, { title: 'Servable' });
    const session = await openProject(dir);
    const out = await scratch('build');

    // A stand-in for an unpacked nwjs.app: the shell assembly only needs the
    // bundle's directory shape, not a real binary.
    const nwApp = await scratch('nwjs.app');
    await mkdir(path.join(nwApp, 'Contents', 'MacOS'), { recursive: true });
    await writeFile(path.join(nwApp, 'Contents', 'MacOS', 'nwjs'), '');
    await writeFile(path.join(nwApp, 'Contents', 'Info.plist'), '<plist/>');

    const report = await tools.deploy(session, { outDir: out, target: 'macos', nwPath: nwApp });

    const appNw = path.join(out, 'Servable.app', 'Contents', 'Resources', 'app.nw');
    expect(await readFile(path.join(appNw, 'index.html'), 'utf-8')).toBeTruthy();
    // The shell's own files came along.
    expect(await readFile(path.join(out, 'Servable.app', 'Contents', 'Info.plist'), 'utf-8')).toBe('<plist/>');
    // NW.js reads app.nw/package.json for the entry point — ours, not a stray one.
    const pkg = JSON.parse(await readFile(path.join(appNw, 'package.json'), 'utf-8'));
    expect(pkg.main).toBe('index.html');
    // The editor project file must not ship inside the bundle either.
    await expect(readFile(path.join(appNw, 'Game.rmmzproject'), 'utf-8')).rejects.toThrow();
    expect(report.warnings as string[]).toContainEqual(expect.stringContaining('codesign'));
  });

  it('target macos without nwPath, or with a directory that is not a bundle, is refused before anything is written', async () => {
    const dir = await scratch('MacGame');
    await tools.createProjectTool(dir, { title: 'Refused' });
    const session = await openProject(dir);

    await expect(tools.deploy(session, { outDir: await scratch('b1'), target: 'macos' })).rejects.toThrow(/needs nwPath/);
    const notABundle = await scratch('plain');
    await mkdir(notABundle, { recursive: true });
    await expect(
      tools.deploy(session, { outDir: await scratch('b2'), target: 'macos', nwPath: notABundle })
    ).rejects.toThrow(/no Contents\//);
  });
});
