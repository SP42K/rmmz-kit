import { describe, it, expect, afterEach } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openProject, type MapData, type CommonEvent, type Item } from '@rmmz-kit/core';
import * as tools from '../src/tools.js';
import { makeTestProject } from './testProject.js';

describe('tools', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  it('upsertMapEvent creates a new event, defaulting its id to the first free slot', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    const id = tools.upsertMapEvent(session, 1, { name: 'Shopkeeper', x: 3, y: 4, pages: [{ trigger: 0 }] });
    expect(id).toBe(2); // event 1 already exists in the fixture

    const map = session.readFile<MapData>('Map001.json');
    expect(map.events[2]?.name).toBe('Shopkeeper');
    expect(map.events[2]?.x).toBe(3);
    expect(map.events[2]?.pages[0].trigger).toBe(0);
  });

  it('upsertMapEvent replacing an existing event keeps each page\'s command list', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    const before = session.readFile<MapData>('Map001.json').events[1]!;
    const originalList = before.pages[0].list;
    expect(originalList.length).toBeGreaterThan(1); // fixture event 1 has a real script

    tools.upsertMapEvent(session, 1, { id: 1, name: before.name, x: 9, y: 9, pages: [{}] });

    const after = session.readFile<MapData>('Map001.json').events[1]!;
    expect(after.x).toBe(9);
    expect(after.pages[0].list).toEqual(originalList); // moving an NPC must not delete its dialogue
  });

  it('upsertMapEvent rejects an unknown conditions/image field instead of writing it as junk', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    // `switchId` is the plausible near-miss for MZ's `switch1Id`; silently
    // merged it would leave switch1Valid false and the page always active.
    expect(() =>
      tools.upsertMapEvent(session, 1, { x: 0, y: 0, pages: [{ conditions: { switchId: 5 } as never }] })
    ).toThrow(/Unknown page condition field: switchId/);
  });

  it('applyScript compiles DSL and writes it as the target page\'s command list', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    tools.upsertMapEvent(session, 1, { x: 3, y: 4, pages: [{}] });
    tools.applyScript(session, { map: 1, event: 2, page: 1 }, '- say: "Potions, 100G each!"\n');

    const map = session.readFile<MapData>('Map001.json');
    const list = map.events[2]?.pages[0].list ?? [];
    expect(list.map((c) => c.code)).toEqual([101, 401, 0]);
    expect(list[1].parameters[0]).toBe('Potions, 100G each!');
  });

  it('applyScript rejects a page that was never created', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    expect(() => tools.applyScript(session, { map: 1, event: 2, page: 1 }, '- say: hi\n')).toThrow(/does not exist/);
  });

  it('applyScript writes a common event\'s command list', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    await writeFile(
      path.join(dir, 'data', 'CommonEvents.json'),
      JSON.stringify([null, { id: 1, name: 'CE1', trigger: 0, switchId: 0, list: [{ code: 0, indent: 0, parameters: [] }] }])
    );
    const session = await openProject(dir);

    tools.applyScript(session, { commonEvent: 1 }, '- wait: 10\n');

    const list = session.readFile<Array<CommonEvent | null>>('CommonEvents.json')[1]?.list ?? [];
    expect(list.map((c) => c.code)).toEqual([230, 0]);
  });

  it('upsertDatabase appends a new row when id is omitted and merges onto an existing row otherwise', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    const [newId] = tools.upsertDatabase(session, 'items', [{ name: 'Elixir', price: 500 }]);
    expect(newId).toBe(4); // fixture has ids 1-3

    tools.upsertDatabase(session, 'items', [{ id: 1, price: 150 }]);
    const items = session.readFile<Array<Item | null>>('Items.json');
    expect(items[4]?.name).toBe('Elixir');
    expect(items[1]?.price).toBe(150);
    expect(items[1]?.name).toBe('TestPotion'); // untouched field survives the merge
  });

  it('upsertDatabase rejects an unknown table', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    expect(() => tools.upsertDatabase(session, 'nope', [{}])).toThrow(/Unknown database table/);
  });

  it('upsertDatabase rejects an out-of-range id instead of corrupting the table', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    // 0 would overwrite the leading null MZ requires; -1 and 1.5 become
    // non-index properties JSON.stringify drops, i.e. a reported-but-absent write.
    for (const id of [0, -1, 1.5]) {
      expect(() => tools.upsertDatabase(session, 'items', [{ id, name: 'Bad' }])).toThrow(/must be integers >= 1/);
    }
    expect(session.readFile<Array<Item | null>>('Items.json')[0]).toBeNull();
  });

  it('allocateNamespace hands out contiguous named switch/variable ids', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    const alloc = tools.allocateNamespace(session, 'quest.herb', { switches: 2 });
    expect(alloc.switches).toHaveLength(2);
    expect(alloc.switches[1]).toBe(alloc.switches[0] + 1);
  });

  it('updateSystem shallow-merges, replacing a nested field whole and naming keys the file lacked', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    const { newFields } = tools.updateSystem(session, {
      gameTitle: 'Herb Quest',
      terms: { basic: ['Lv'], messages: { actionFailure: 'Nothing happened.' } },
      gametitle: 'typo',
    });

    const system = session.readFile<Record<string, unknown>>('System.json');
    expect(system.gameTitle).toBe('Herb Quest');
    expect(system.currencyUnit).toBe('G'); // untouched fields survive the merge
    expect(system.terms).toEqual({ basic: ['Lv'], messages: { actionFailure: 'Nothing happened.' } });
    // The typo isn't rejected (System's real key set is wider than SystemData),
    // but it is reported, which is the only signal a caller gets.
    expect(newFields).toEqual(['terms', 'gametitle']);
  });

  it('upsertDatabase refuses a MapInfos row with no map file, but renames an existing map', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    // Appending would create a map the game 404s on — and would make
    // validate's dangling-map check accept transfers to it.
    expect(() => tools.upsertDatabase(session, 'mapInfos', [{ name: 'Cave' }])).toThrow(/no map file/);
    expect(() => tools.upsertDatabase(session, 'mapInfos', [{ id: 7, name: 'Cave' }])).toThrow(/Map007\.json/);
    expect(session.dirtyFiles()).toEqual([]);

    tools.upsertDatabase(session, 'mapInfos', [{ id: 1, name: 'Field' }]);
    expect(session.readFile<Array<{ name: string } | null>>('MapInfos.json')[1]!.name).toBe('Field');
  });

  it('upsertDatabase edits a tileset passage flag (M6.5 acceptance)', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    const flags = [...session.readFile<Array<{ flags: number[] } | null>>('Tilesets.json')[1]!.flags];
    flags[48] = 15;
    tools.upsertDatabase(session, 'tilesets', [{ id: 1, flags }]);

    const tileset = session.readFile<Array<{ flags: number[]; name: string } | null>>('Tilesets.json')[1]!;
    expect(tileset.flags[48]).toBe(15);
    expect(tileset.flags).toHaveLength(8192); // a short array here is a broken map in the editor
    expect(tileset.name).toBe('Field'); // shallow merge, not replace
  });

  it('upsertDatabase gives an appended tileset the flags array MZ indexes (M6.5 gap #1)', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    const [id] = tools.upsertDatabase(session, 'tilesets', [{ name: 'Cave' }]);
    const tileset = session.readFile<Array<{ flags: number[]; tilesetNames: string[]; name: string } | null>>(
      'Tilesets.json'
    )[id]!;

    // Without this, Game_Map.checkPassage reads flags[tileId] === undefined and
    // the player's first step throws.
    expect(tileset.flags).toHaveLength(8192);
    expect(tileset.tilesetNames).toHaveLength(9);
    expect(tileset.name).toBe('Cave');

    // Defaults are for new rows only — they must not undo an existing row's data.
    tools.upsertDatabase(session, 'tilesets', [{ id: 1, note: 'edited' }]);
    const existing = session.readFile<Array<{ flags: number[]; name: string } | null>>('Tilesets.json')[1]!;
    expect(existing.name).toBe('Field');
    expect(existing.flags[24]).toBe(15);
  });

  it('map tools compose, paint and resize through the same session (M7)', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    const { id } = tools.createMapTool(session, { name: 'Cave', width: 12, height: 10 });
    expect(id).toBe(2);

    tools.paintTilesTool(session, { mapId: id, ops: [{ x: 0, y: 0, width: 12, height: 10, tileId: 2816 }] });
    tools.setTileFlagsTool(session, 1, [{ tileId: 2816, passage: { down: true, left: true, right: true, up: true } }]);
    tools.upsertMapEvent(session, id, { name: 'Sign', x: 11, y: 9, pages: [{ trigger: 0 }] });

    expect(tools.resizeMapTool(session, id, 8, 8)).toEqual({ outOfBoundsEvents: [1] });
    expect(session.readFile<MapData>('Map002.json').data).toHaveLength(8 * 8 * 6);

    const composed = tools.composeMapTool(session, { name: 'Dungeon', seed: 5 });
    expect(composed.mapId).toBe(3);
    expect(composed.regionSizes).toHaveLength(1);
    expect(tools.diff(session)).toEqual(expect.arrayContaining(['Map002.json', 'Map003.json', 'MapInfos.json']));
  });

  it('simulateBattle reports on uncommitted data', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    const before = tools.simulateBattle(session, { party: [{ actorId: 1, level: 5 }], troopId: 1, trials: 100 });
    // Buff the Slime past what a level 5 actor can chew through, without committing.
    tools.upsertDatabase(session, 'enemies', [{ id: 1, params: [9999, 0, 200, 300, 10, 10, 12, 10] }]);
    const after = tools.simulateBattle(session, { party: [{ actorId: 1, level: 5 }], troopId: 1, trials: 100 });

    expect(before.winRate).toBeGreaterThan(after.winRate);
    expect(after.winRate).toBe(0);
  });

  it('diff/commit/rollback wrap ProjectSession\'s transaction API', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    expect(tools.diff(session)).toEqual([]);
    tools.upsertMapEvent(session, 1, { x: 0, y: 0, pages: [{}] });
    expect(tools.diff(session)).toEqual(['Map001.json']);

    tools.rollback(session);
    expect(tools.diff(session)).toEqual([]);

    tools.upsertMapEvent(session, 1, { x: 0, y: 0, pages: [{}] });
    const hash = await tools.commit(session, 'add event');
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(tools.diff(session)).toEqual([]);
  });
});
