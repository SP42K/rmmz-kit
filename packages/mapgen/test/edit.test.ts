import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { openProject, type MapData, type MapInfo, type ProjectSession, type Tileset } from '@rmmz-kit/core';
import {
  TILE_ID_A2,
  analyzeReachability,
  autotileShape,
  createMap,
  paintTiles,
  resizeMap,
  setTileFlags,
  tileIndex,
} from '../src/index.js';
import { makeTestProject } from './testProject.js';

let project: { dir: string; cleanup: () => Promise<void> };
let session: ProjectSession;

beforeEach(async () => {
  project = await makeTestProject();
  session = await openProject(project.dir);
});

afterEach(() => project.cleanup());

const tileOf = (map: MapData, layer: number, x: number, y: number) =>
  map.data[tileIndex(map.width, map.height, layer, x, y)];

describe('createMap', () => {
  it('writes the map file and its MapInfos row, and only on commit', async () => {
    const id = createMap(session, { name: 'Cave', width: 20, height: 15 });
    expect(id).toBe(2); // the fixture already has Map001

    const onDisk = path.join(project.dir, 'data', 'Map002.json');
    await expect(readFile(onDisk, 'utf-8')).rejects.toThrow();

    await session.commit('add map');
    const written = JSON.parse(await readFile(onDisk, 'utf-8')) as MapData;
    expect(written.width).toBe(20);
    expect(written.data).toHaveLength(20 * 15 * 6);
    expect(written.events).toEqual([null]);

    const infos = session.readFile<Array<MapInfo | null>>('MapInfos.json');
    expect(infos[2]).toMatchObject({ id: 2, name: 'Cave', parentId: 0, order: 2 });
  });

  it('is undone whole by rollback', () => {
    createMap(session, { name: 'Cave', width: 20, height: 15 });
    session.rollback();

    expect(session.listFiles()).not.toContain('Map002.json');
    expect(session.readFile<Array<MapInfo | null>>('MapInfos.json')[2]).toBeUndefined();
    // The id is free again, so the next create reuses it rather than leaking one.
    expect(createMap(session, { name: 'Retry', width: 10, height: 10 })).toBe(2);
  });

  it('refuses an id whose map file exists without a MapInfos row', () => {
    session.updateFile<Array<MapInfo | null>>('MapInfos.json', (data) => {
      data[1] = null;
    });
    // Map001.json is still there, so id 1 is taken even though its row is gone.
    expect(createMap(session, { name: 'Next', width: 10, height: 10 })).toBe(2);
  });

  it('rejects dimensions MZ cannot represent', () => {
    expect(() => createMap(session, { name: 'X', width: 0, height: 10 })).toThrow(/width/);
    expect(() => createMap(session, { name: 'X', width: 10, height: 300 })).toThrow(/height/);
  });

  it('derives shapes for a fill, giving a seamless interior', () => {
    const id = createMap(session, { name: 'Grass', width: 8, height: 8, fillTileId: TILE_ID_A2 });
    const map = session.readFile<MapData>('Map002.json');
    expect(id).toBe(2);
    expect(map.data.slice(0, 64).every((tile) => autotileShape(tile) === 0)).toBe(true);
  });
});

describe('paintTiles', () => {
  it('fills a rect on the requested layer and reshapes its neighbourhood', () => {
    createMap(session, { name: 'M', width: 10, height: 10, fillTileId: TILE_ID_A2 });
    const other = TILE_ID_A2 + 48;
    paintTiles(session, { mapId: 2, ops: [{ x: 3, y: 3, width: 2, height: 2, tileId: other }] });

    const map = session.readFile<MapData>('Map002.json');
    // The painted block is a 2x2 island of the new kind: each tile keeps two
    // open edges and the diagonal into the block's own corner.
    expect(autotileShape(tileOf(map, 0, 3, 3))).toBe(34); // left + top open
    expect(autotileShape(tileOf(map, 0, 4, 4))).toBe(38); // right + bottom open
    // ...and the tile above it now has a concave corner facing the island.
    expect(autotileShape(tileOf(map, 0, 2, 2))).toBe(4);
  });

  it('writes region ids and shadows verbatim on their own layers', () => {
    createMap(session, { name: 'M', width: 10, height: 10 });
    paintTiles(session, { mapId: 2, ops: [{ x: 1, y: 1, tileId: 7 }], layer: 5 });
    const map = session.readFile<MapData>('Map002.json');
    expect(tileOf(map, 5, 1, 1)).toBe(7);
    expect(tileOf(map, 0, 1, 1)).toBe(0);
  });

  it('rejects a rect that leaves the map instead of wrapping onto the next row', () => {
    createMap(session, { name: 'M', width: 10, height: 10 });
    expect(() => paintTiles(session, { mapId: 2, ops: [{ x: 8, y: 0, width: 4, height: 1, tileId: 1 }] })).toThrow(
      /outside the 10x10 map/
    );
    expect(() => paintTiles(session, { mapId: 2, ops: [{ x: 0, y: 0, tileId: 9999 }] })).toThrow(/Tile id/);
    expect(() => paintTiles(session, { mapId: 2, ops: [{ x: 0, y: 0, tileId: 1 }], layer: 6 })).toThrow(/Layer/);
  });
});

describe('resizeMap', () => {
  it('keeps overlapping tiles, zeroes new area and reports stranded events', () => {
    createMap(session, { name: 'M', width: 10, height: 10, fillTileId: TILE_ID_A2 });
    session.updateFile<MapData>('Map002.json', (map) => {
      map.events.push({ id: 1, name: 'EV001', note: '', x: 8, y: 2, pages: [] });
      map.events.push({ id: 2, name: 'EV002', note: '', x: 1, y: 1, pages: [] });
    });
    paintTiles(session, { mapId: 2, ops: [{ x: 1, y: 1, tileId: 300 }], layer: 2 });

    const result = resizeMap(session, 2, 6, 12);
    const map = session.readFile<MapData>('Map002.json');

    expect(result.outOfBoundsEvents).toEqual([1]);
    expect(map.data).toHaveLength(6 * 12 * 6);
    expect(tileOf(map, 2, 1, 1)).toBe(300);
    expect(tileOf(map, 0, 0, 11)).toBe(0);
    // Growing exposes the old bottom edge to empty tiles, so it needs the
    // border it never had while the map stopped there.
    expect(autotileShape(tileOf(map, 0, 2, 9))).toBe(28);
    expect(autotileShape(tileOf(map, 0, 2, 5))).toBe(0);
  });
});

describe('setTileFlags', () => {
  it('sets passage bits, terrain tags and options without touching other tiles', () => {
    setTileFlags(session, 1, [
      { tileId: 100, passage: { down: false, up: true }, terrainTag: 3, ladder: true },
      { tileId: 101, star: true },
    ]);
    const flags = session.readFile<Array<Tileset | null>>('Tilesets.json')[1]!.flags;

    expect(flags[100] & 0x01).toBe(0x01); // down blocked
    expect(flags[100] & 0x08).toBe(0); // up passable
    expect(flags[100] & 0x20).toBe(0x20); // ladder
    expect(flags[100] >> 12).toBe(3);
    expect(flags[101]).toBe(0x10);
    expect(flags[24]).toBe(15); // the fixture's one non-zero flag, untouched
    expect(flags).toHaveLength(8192);
  });

  it('rejects a bad tile id or terrain tag before writing anything', () => {
    expect(() => setTileFlags(session, 1, [{ tileId: 5, star: true }, { tileId: 99999 }])).toThrow(/Tile id/);
    expect(() => setTileFlags(session, 1, [{ tileId: 5, terrainTag: 9 }])).toThrow(/Terrain tag/);
    expect(session.readFile<Array<Tileset | null>>('Tilesets.json')[1]!.flags[5]).toBe(0);
    expect(() => setTileFlags(session, 99, [{ tileId: 5 }])).toThrow(/Tileset 99/);
  });
});

describe('analyzeReachability', () => {
  it('separates walkable regions and finds events no one can walk to', () => {
    const id = createMap(session, { name: 'Split', width: 9, height: 5, fillTileId: TILE_ID_A2 });
    const wall = TILE_ID_A2 + 48;
    // A full-height wall down the middle: two rooms, no door.
    paintTiles(session, { mapId: id, ops: [{ x: 4, y: 0, width: 1, height: 5, tileId: wall }] });
    setTileFlags(session, 1, [
      { tileId: 0, star: true },
      ...Array.from({ length: 48 }, (_, shape) => ({
        tileId: wall + shape,
        passage: { down: false, left: false, right: false, up: false },
      })),
    ]);
    session.updateFile<MapData>('Map002.json', (map) => {
      map.events.push({ id: 1, name: 'Left', note: '', x: 1, y: 1, pages: [] });
      map.events.push({ id: 2, name: 'Right', note: '', x: 7, y: 1, pages: [] });
    });

    const { regionSizes, unreachableEvents } = analyzeReachability(session, id);
    expect(regionSizes).toEqual([20, 20]);
    // Two equal regions, so one of the two events is stranded whichever wins.
    expect(unreachableEvents).toHaveLength(1);
  });
});
