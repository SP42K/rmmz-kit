import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createProject } from '../src/createProject.js';
import { openProject } from '../src/session.js';
import { makeTestProject } from './testProject.js';

const execFileAsync = promisify(execFile);

describe('createProject', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  async function target(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'rmmz-new-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return path.join(dir, 'MyGame');
  }

  it('produces a project openProject accepts, with the title and a git baseline', async () => {
    const dir = await target();

    const result = await createProject(dir, { title: 'Herb Quest' });

    const session = await openProject(dir);
    // Every table the toolchain reads must be there, or the first tool call
    // that touches one throws "Unknown data file".
    for (const file of ['System.json', 'Map001.json', 'MapInfos.json', 'CommonEvents.json', 'Tilesets.json']) {
      expect(session.listFiles()).toContain(file);
    }
    expect(session.readFile<{ gameTitle: string }>('System.json').gameTitle).toBe('Herb Quest');
    expect(await readFile(path.join(dir, 'index.html'), 'utf-8')).toContain('<title>Herb Quest</title>');

    expect(result.commit).toMatch(/^[0-9a-f]{7,}$/);
    const { stdout } = await execFileAsync('git', ['log', '--oneline'], { cwd: dir });
    expect(stdout.trim().split('\n')).toHaveLength(1);

    // No engine, no art — say so rather than hand back a project that silently
    // fails to boot.
    expect(result.warnings.some((w) => w.includes('runtimeFrom'))).toBe(true);
  });

  it('System.json carries the fields the engine reads, and references no asset the project lacks', async () => {
    const dir = await target();
    await createProject(dir);

    const system = JSON.parse(await readFile(path.join(dir, 'data', 'System.json'), 'utf-8'));
    for (const field of ['terms', 'sounds', 'partyMembers', 'startMapId', 'switches', 'variables', 'attackMotions', 'boat']) {
      expect(system[field]).toBeDefined();
    }
    // Not in core's SystemData, but the runtime dereferences them without a
    // nullcheck: Scene_Boot.resizeScreen reads advanced.screenWidth on the
    // first frame, Window_ItemCategory indexes itemCategories.
    expect(system.advanced).toMatchObject({ screenWidth: 816, screenHeight: 624, uiAreaWidth: 816, uiAreaHeight: 624 });
    expect(system.itemCategories).toHaveLength(4);
    expect(system.terms.messages.actorDamage).toBeTruthy();
    expect(system.sounds).toHaveLength(24);
    // Silent, not plausible: a default filename would dangle (no audio ships here).
    expect(system.sounds.every((se: { name: string }) => se.name === '')).toBe(true);
    expect(system.title1Name).toBe('');
    expect(system.partyMembers).toEqual([1]);
  });

  it('refuses a non-empty target', async () => {
    const dir = await target();
    await createProject(dir, { git: false });

    await expect(createProject(dir)).rejects.toThrow(/not empty/);
  });

  it('runtimeFrom copies the engine and assets but not the source project\'s plugin list', async () => {
    const { dir: source, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    await writeFile(path.join(source, 'js', 'main.js'), '// engine entry point');
    const dir = await target();

    await createProject(dir, { title: 'With Runtime', runtimeFrom: source, git: false });

    expect(await readFile(path.join(dir, 'js', 'main.js'), 'utf-8')).toContain('engine entry point');
    // TestPlugin is the source project's configuration, and a plugins.js entry
    // whose file is missing is a crash on boot.
    expect(await readFile(path.join(dir, 'js', 'plugins.js'), 'utf-8')).not.toContain('TestPlugin');
    await expect(readFile(path.join(dir, 'js', 'plugins', 'TestPlugin.js'), 'utf-8')).rejects.toThrow();
    // The template's stub index.html is replaced by the real one, then retitled.
    expect(await readFile(path.join(dir, 'index.html'), 'utf-8')).toContain('<title>With Runtime</title>');
  });

  it('rejects a runtimeFrom that is not a project', async () => {
    const notAProject = await mkdtemp(path.join(tmpdir(), 'rmmz-notproj-'));
    cleanups.push(() => rm(notAProject, { recursive: true, force: true }));

    await expect(createProject(await target(), { runtimeFrom: notAProject })).rejects.toThrow(/Not an RPG Maker MZ project/);
  });
});
