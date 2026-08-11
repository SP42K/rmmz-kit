import { describe, it, expect, afterEach } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
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

function blankTroopConditions() {
  return {
    actorHp: false,
    actorId: 0,
    actorValid: false,
    enemyHp: false,
    enemyIndex: 0,
    enemyValid: false,
    switchId: 0,
    switchValid: false,
    turnA: 0,
    turnB: 0,
    turnEnding: false,
    turnValid: false,
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
          { code: 122, indent: 0, parameters: [7, 8, 0, 0, 1] },
          { code: 111, indent: 0, parameters: [1, 9, 0, 1, 0] },
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
    // Control Variables 7..8, plus the variable read by the conditional branch.
    expect(index.referencesTo('variable', 7)).toHaveLength(1);
    expect(index.referencesTo('variable', 8)).toHaveLength(1);
    expect(index.referencesTo('variable', 9)).toHaveLength(1);
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

  it('indexes troop battle-event pages: page condition switch and command list', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const troops = [
      null,
      {
        id: 1,
        name: 'Slime*2',
        members: [],
        pages: [
          {
            conditions: { ...blankTroopConditions(), switchValid: true, switchId: 11 },
            span: 0,
            list: [
              { code: 121, indent: 0, parameters: [12, 12, 0] },
              { code: 0, indent: 0, parameters: [] },
            ],
          },
        ],
      },
    ];
    await writeFile(path.join(dir, 'data', 'Troops.json'), JSON.stringify(troops));

    const index = RefIndex.build(await openProject(dir));
    expect(index.referencesTo('switch', 11)).toHaveLength(1);
    expect(index.referencesTo('switch', 12)).toHaveLength(1);
    expect(index.referencesTo('switch', 12)[0].file).toBe('Troops.json');
  });

  it('descends into move routes (Switch ON/OFF steps) without double-counting the 505 echo', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);

    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      const event = npcReferencingItem3();
      const step = { code: 27, parameters: [21] }; // ROUTE_SWITCH_ON
      event.pages[0].list = [
        { code: 205, indent: 0, parameters: [-1, { list: [step, { code: 0, parameters: [] }], repeat: false, skippable: false, wait: false }] },
        { code: 505, indent: 0, parameters: [step] }, // MZ re-emits every step inline right after the 205
        { code: 0, indent: 0, parameters: [] },
      ];
      event.pages[0].moveRoute = { list: [{ code: 28, parameters: [22] }, { code: 0, parameters: [] }], repeat: true, skippable: false, wait: false };
      data.events.push(event);
    });

    const index = RefIndex.build(session);
    expect(index.referencesTo('switch', 21)).toHaveLength(1);
    expect(index.referencesTo('switch', 22)).toHaveLength(1);
  });
});
