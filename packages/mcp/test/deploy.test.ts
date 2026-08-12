import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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

    await tools.deploy(session, { outDir: out });

    const server = await startPlaytestServer(out);
    cleanups.push(() => server.close());
    const system = await fetch(`${server.url}/data/System.json`);
    expect(system.status).toBe(200);
    expect((await system.json()).gameTitle).toBe('Servable');
    expect((await fetch(`${server.url}/Game.rmmzproject`)).status).toBe(404);
  });
});
