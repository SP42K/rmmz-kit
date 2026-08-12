import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openProject, type MapData, type MapInfo, type ProjectSession } from '@rmmz-kit/core';
import { analyzeReachability, autotileShape, composeMap, tileIndex } from '../src/index.js';
import { makeTestProject } from './testProject.js';

let project: { dir: string; cleanup: () => Promise<void> };
let session: ProjectSession;

// One project for the whole file: composeMap only writes in-memory, and nothing
// here commits, so the fixture copy is read-only in practice.
beforeAll(async () => {
  project = await makeTestProject();
  session = await openProject(project.dir);
});

afterAll(() => project.cleanup());

describe('composeMap', () => {
  it('returns rooms inside the map that never overlap the border', () => {
    const { mapId, rooms } = composeMap(session, { name: 'Dungeon', seed: 1 });
    const map = session.readFile<MapData>(`Map${String(mapId).padStart(3, '0')}.json`);

    expect(rooms.length).toBeGreaterThan(1);
    for (const room of rooms) {
      expect(room.x).toBeGreaterThan(0);
      expect(room.y).toBeGreaterThan(0);
      expect(room.x + room.width).toBeLessThan(map.width);
      expect(room.y + room.height).toBeLessThan(map.height);
    }
    expect(session.readFile<Array<MapInfo | null>>('MapInfos.json')[mapId]!.name).toBe('Dungeon');
  });

  it('is deterministic for a seed and different across seeds', () => {
    const a = composeMap(session, { name: 'A', seed: 42 });
    const b = composeMap(session, { name: 'B', seed: 42 });
    const c = composeMap(session, { name: 'C', seed: 43 });
    expect(b.rooms).toEqual(a.rooms);
    expect(c.rooms).not.toEqual(a.rooms);
  });

  it('leaves every floor tile autotiled — no raw base ids in the output', () => {
    const { mapId } = composeMap(session, { name: 'Shapes', seed: 7 });
    const map = session.readFile<MapData>(`Map${String(mapId).padStart(3, '0')}.json`);
    const corner = map.data[tileIndex(map.width, map.height, 0, 0, 0)];
    // (0,0) is solid wall with wall on every side (clamped), so shape 0...
    expect(autotileShape(corner)).toBe(0);
    // ...while a room's own corner must carry a border, or the map draws as a
    // flat colour field in the editor (R9).
    const shapes = new Set(map.data.slice(0, map.width * map.height).map(autotileShape));
    expect(shapes.size).toBeGreaterThan(4);
  });

  /**
   * The checkable half of M7's acceptance criterion ("生成 20 張地圖，100% 連通").
   * composeMap throws on a disconnected result, so this asserts the guarantee
   * holds across seeds and shapes rather than only on the happy path.
   */
  it('generates 20 maps that are each one connected walkable region', () => {
    for (let seed = 0; seed < 20; seed++) {
      const width = 21 + (seed % 5) * 6;
      const height = 17 + (seed % 3) * 8;
      const { mapId, regionSizes, rooms } = composeMap(session, { name: `Gen${seed}`, width, height, seed });
      expect(regionSizes).toHaveLength(1);
      expect(rooms.length).toBeGreaterThan(0);

      // Every room is reachable, not just the walkable area as a whole: a room
      // whose corridor was drawn but whose floor stayed solid would still be
      // "one region", just not the one the caller was promised.
      const floor = regionSizes[0];
      expect(floor).toBeGreaterThanOrEqual(rooms.reduce((sum, r) => sum + r.width * r.height, 0));
      expect(analyzeReachability(session, mapId).unreachableEvents).toEqual([]);
    }
  });

  it('refuses a map too small to hold a partition, rather than emitting a broken one', () => {
    expect(() => composeMap(session, { name: 'Tiny', width: 8, height: 8 })).toThrow(/smaller than one/);
    expect(() => composeMap(session, { name: 'Tiny', minRoom: 11, minPartition: 12 })).toThrow(/minPartition/);
  });
});
