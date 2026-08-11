import { describe, it, expect, afterEach } from 'vitest';
import { openProject } from '../src/session.js';
import { RefIndex } from '../src/refIndex.js';
import { MapData, MapEvent } from '../src/types/mz.js';
import { makeTestProject } from './testProject.js';

function blankConditions() {
  return {
    actorId: 0,
    actorValid: false,
    itemId: 0,
    itemValid: false,
    selfSwitchCh: 'A',
    selfSwitchValid: false,
    switch1Id: 0,
    switch1Valid: false,
    switch2Id: 0,
    switch2Valid: false,
    variableId: 0,
    variableValid: false,
    variableValue: 0,
  };
}

/** A NPC event whose page references item 3, switch 5, Map001, and Common Event 1. */
function npcReferencingItem3(): MapEvent {
  return {
    id: 2,
    name: 'Herb Merchant',
    note: '',
    x: 1,
    y: 1,
    pages: [
      {
        conditions: { ...blankConditions(), itemValid: true, itemId: 3 },
        directionFix: false,
        image: { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 },
        list: [
          { code: 121, indent: 0, parameters: [5, 5, 0] },
          { code: 111, indent: 0, parameters: [8, 3, 0] },
          { code: 126, indent: 0, parameters: [3, 0, 0, 0, 1] },
          { code: 117, indent: 0, parameters: [1] },
          { code: 201, indent: 0, parameters: [0, 1, 8, 6, 2, 0] },
          { code: 0, indent: 0, parameters: [] },
        ],
        moveFrequency: 3,
        moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
        moveSpeed: 3,
        moveType: 0,
        priorityType: 1,
        stepAnime: false,
        through: false,
        trigger: 0,
        walkAnime: true,
      },
    ],
  };
}

describe('RefIndex', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  it('finds every reference to item 3 (condition, conditional branch, change-items command)', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      data.events.push(npcReferencingItem3());
    });

    const index = RefIndex.build(session);
    const refs = index.referencesTo('item', 3);
    expect(refs).toHaveLength(3);
    expect(refs.map((r) => r.file)).toEqual(['Map001.json', 'Map001.json', 'Map001.json']);
  });

  it('also indexes switch, map, and common-event references from event commands', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      data.events.push(npcReferencingItem3());
    });

    const index = RefIndex.build(session);
    expect(index.referencesTo('switch', 5)).toHaveLength(1);
    expect(index.referencesTo('map', 1)).toHaveLength(1);
    expect(index.referencesTo('commonEvent', 1)).toHaveLength(1);
    expect(index.referencesTo('item', 999)).toEqual([]);
  });

  it('answers "what breaks if item 3 is deleted": empty after the referencing event is removed', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      data.events.push(npcReferencingItem3());
    });
    expect(RefIndex.build(session).referencesTo('item', 3)).not.toEqual([]);

    session.updateFile<MapData>('Map001.json', (data) => {
      data.events = data.events.filter((e) => e?.id !== 2);
    });
    expect(RefIndex.build(session).referencesTo('item', 3)).toEqual([]);
  });
});
