import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openProject } from '@rmmz-kit/core';
import { assetCatalog, databaseResource, mapResource, projectSummary, tilesetResource } from '../src/resources.js';
import { allocateNamespace, applyScript, upsertMapEvent } from '../src/tools.js';
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

  it('map/{id} prints allocated ids back as their names; summary lists the namespaces', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    const alloc = allocateNamespace(session, 'quest.herb', { switches: ['started'] });
    const id = upsertMapEvent(session, 1, { x: 0, y: 0, pages: [{}] });
    applyScript(session, { map: 1, event: id, page: 1 }, '- setSwitch: { from: quest.herb.started, value: true }\n');

    const map = mapResource(session, 1) as { events: Array<{ pages: Array<{ script?: string }> } | null> };
    expect(map.events[id]?.pages[0].script).toContain('quest.herb.started');

    const summary = projectSummary(session) as { namespaces: Record<string, { switches: Record<string, number> }> };
    expect(summary.namespaces['quest.herb'].switches.started).toBe(alloc.switches.started);
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

  /**
   * Gap review #4: the demo had to open `Outside_A2.png` and count tiles to work
   * out that soil is 2816 + 16 * 48. That arithmetic is the whole reason this
   * resource exists, so the test pins the ids rather than just the shape.
   */
  it('tileset/{id} lists autotile kinds by tile id, with their sheet, family and passability', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<Array<Record<string, unknown> | null>>('Tilesets.json', (data) => {
      const tileset = data[1]!;
      tileset.tilesetNames = ['Outside_A1', 'Outside_A2', 'Outside_A3', 'Outside_A4', '', 'Outside_B', '', '', ''];
      (tileset.flags as number[])[5888] = 0xf;
      (tileset.flags as number[])[1] = 0x10;
    });

    const tileset = tilesetResource(session, 1) as {
      autotiles: Array<{ sheet: string; tileId: number; row: number; col: number; family: string; passable: Record<string, boolean> }>;
      plainTiles: Array<{ sheet: string; tileIdRange: number[]; flagged: Array<{ tileId: number; star?: boolean }> }>;
    };

    const a2 = tileset.autotiles.filter((k) => k.sheet === 'A2');
    expect(a2[0]).toMatchObject({ tileId: 2816, row: 0, col: 0, family: 'floor' });
    // Second row, first column — the one the demo counted out of the PNG.
    expect(a2.find((k) => k.row === 2)).toBeUndefined();
    expect(a2.find((k) => k.row === 1 && k.col === 0)!.tileId).toBe(2816 + 8 * 48);
    // A4's first kind is the wall top composeMap fills with, and it is the one
    // whose passability a caller has to be able to see without playing the game.
    const a4 = tileset.autotiles.find((k) => k.tileId === 5888)!;
    expect(a4).toMatchObject({ sheet: 'A4', family: 'floor' });
    expect(a4.passable).toEqual({ down: false, left: false, right: false, up: false });

    // A5 and C-E have no sheet in this tileset, so they draw nothing and are
    // not listed at all — the same "say what exists" stance as the asset catalog.
    expect(tileset.plainTiles.map((p) => p.sheet)).toEqual(['B']);
    expect(tileset.plainTiles[0].tileIdRange).toEqual([0, 255]);
    // Only the tiles that carry a flag at all — 256 rows of "plain passable"
    // is noise, and the ★ ones are what a caller has to know about.
    expect(tileset.plainTiles[0].flagged).toContainEqual({
      tileId: 1,
      passable: { down: true, left: true, right: true, up: true },
      star: true,
    });
    expect(() => tilesetResource(session, 99)).toThrow(/Tileset 99 does not exist/);
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
