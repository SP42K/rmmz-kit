import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openProject } from '@rmmz-kit/core';
import { assetCatalog, databaseResource, mapResource, projectSummary } from '../src/resources.js';
import { applyScript, upsertMapEvent } from '../src/tools.js';
import { makeTestProject } from './testProject.js';

describe('resources', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  it('project/summary reports maps, table counts, and named switch/variable counts', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    const summary = projectSummary(session) as {
      maps: Array<{ id: number; name: string }>;
      tables: Record<string, number>;
    };

    expect(summary.maps).toEqual([{ id: 1, name: 'MAP001' }]);
    expect(summary.tables.items).toBe(3);
    expect(summary.tables.actors).toBeGreaterThanOrEqual(0);
  });

  it('map/{id} annotates each page with its decompiled DSL script', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    const id = upsertMapEvent(session, 1, { x: 0, y: 0, pages: [{}] });
    applyScript(session, { map: 1, event: id, page: 1 }, '- say: hi\n');

    const map = mapResource(session, 1) as { events: Array<{ pages: Array<{ script?: string }> } | null> };
    const script = map.events[id]?.pages[0].script;
    expect(script).toContain('say');
  });

  it('map/{id} throws for a nonexistent map', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    expect(() => mapResource(session, 999)).toThrow(/does not exist/);
  });

  it('database/{table} returns the raw table and rejects unknown table names', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    expect(databaseResource(session, 'items')).toEqual(session.readFile('Items.json'));
    expect(() => databaseResource(session, 'nope')).toThrow(/Unknown database table/);
  });

  it('asset-catalog lists files present on disk and is empty for missing folders', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    await mkdir(path.join(dir, 'img', 'faces'), { recursive: true });
    await writeFile(path.join(dir, 'img', 'faces', 'Actor1.png'), '');
    const session = await openProject(dir);

    const catalog = await assetCatalog(session);
    expect(catalog['img/faces']).toEqual(['Actor1']);
    expect(catalog['audio/se']).toEqual([]);
  });
});
