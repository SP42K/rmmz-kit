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

  it('allocateNamespace hands out contiguous named switch/variable ids', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    const alloc = tools.allocateNamespace(session, 'quest.herb', { switches: 2 });
    expect(alloc.switches).toHaveLength(2);
    expect(alloc.switches[1]).toBe(alloc.switches[0] + 1);
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
