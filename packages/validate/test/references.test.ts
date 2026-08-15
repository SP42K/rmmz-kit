import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openProject, type MapData, type SystemData } from '@rmmz-kit/core';
import { checkReferences } from '../src/rules/references.js';
import { makeTestProject } from './testProject.js';
import { mapEvent, page, blankConditions } from './helpers.js';

describe('checkReferences', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  it('finds no dangling references in the fixture as shipped (it does warn: switch 1 is used but System.json names no switches)', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    const findings = await checkReferences(session);
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('flags a dangling item reference', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      const list = [{ code: 126, indent: 0, parameters: [999, 0, 0, 1] }];
      data.events.push(mapEvent(2, 'Broken', [page(list, { conditions: blankConditions({ itemValid: true, itemId: 1 }) })]));
    });
    const findings = await checkReferences(session);
    expect(findings.some((f) => f.rule === 'references/dangling-item' && f.message.includes('999'))).toBe(true);
  });

  it('flags a dangling common-event call', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      const list = [{ code: 117, indent: 0, parameters: [42] }];
      data.events.push(mapEvent(2, 'Broken', [page(list)]));
    });
    const findings = await checkReferences(session);
    expect(findings.some((f) => f.rule === 'references/dangling-commonEvent')).toBe(true);
  });

  it('flags a dangling transfer destination map, and does not also try to bounds-check it', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      const list = [{ code: 201, indent: 0, parameters: [0, 999, 0, 0, 0, 0] }];
      data.events.push(mapEvent(2, 'Broken', [page(list)]));
    });
    const findings = await checkReferences(session);
    expect(findings.some((f) => f.rule === 'references/dangling-map')).toBe(true);
    expect(findings.some((f) => f.rule === 'references/transfer-out-of-bounds')).toBe(false);
  });

  it('flags an out-of-bounds transfer to a real map (fixture Map001 is 17x13)', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      const list = [{ code: 201, indent: 0, parameters: [0, 1, 99, 99, 0, 0] }];
      data.events.push(mapEvent(2, 'Broken', [page(list)]));
    });
    const findings = await checkReferences(session);
    expect(findings.some((f) => f.rule === 'references/transfer-out-of-bounds')).toBe(true);
  });

  it('warns about a switch referenced but never named in System.json', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      const list = [{ code: 121, indent: 0, parameters: [50, 50, 0] }];
      data.events.push(mapEvent(2, 'Broken', [page(list)]));
    });
    const findings = await checkReferences(session);
    expect(findings.some((f) => f.rule === 'references/unnamed-switch')).toBe(true);
  });

  it('does not warn about a named switch', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<SystemData>('System.json', (data) => {
      data.switches = [];
      data.switches[5] = 'quest.herb.0';
    });
    session.updateFile<MapData>('Map001.json', (data) => {
      const list = [{ code: 121, indent: 0, parameters: [5, 5, 0] }];
      data.events.push(mapEvent(2, 'Fine', [page(list)]));
    });
    const findings = await checkReferences(session);
    // Fixture's own event 1 references switch 1 (never named) independent of this test,
    // so scope the assertion to switch 5 rather than asserting no unnamed-switch warning at all.
    expect(findings.some((f) => f.rule === 'references/unnamed-switch' && f.message.includes('switch 5'))).toBe(false);
  });

  it('flags a missing face asset once img/faces exists but lacks the file, and a case mismatch separately', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    await mkdir(path.join(dir, 'img', 'faces'), { recursive: true });
    await writeFile(path.join(dir, 'img', 'faces', 'Actor1.png'), '');
    session.updateFile<MapData>('Map001.json', (data) => {
      const list = [
        { code: 101, indent: 0, parameters: ['NoSuchFace', 0, 0, 2] },
        { code: 401, indent: 0, parameters: ['hi'] },
        { code: 101, indent: 0, parameters: ['actor1', 0, 0, 2] },
        { code: 401, indent: 0, parameters: ['hi'] },
      ];
      data.events.push(mapEvent(2, 'Broken', [page(list)]));
    });
    const findings = await checkReferences(session);
    expect(findings.some((f) => f.rule === 'references/asset-missing' && f.message.includes('NoSuchFace'))).toBe(true);
    expect(findings.some((f) => f.rule === 'references/asset-case-mismatch' && f.message.includes('actor1'))).toBe(true);
  });

  it('skips asset checks entirely when the asset directory does not exist at all', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      const list = [
        { code: 101, indent: 0, parameters: ['NoSuchFace', 0, 0, 2] },
        { code: 401, indent: 0, parameters: ['hi'] },
      ];
      data.events.push(mapEvent(2, 'Broken', [page(list)]));
    });
    const findings = await checkReferences(session);
    expect(findings.filter((f) => f.rule.startsWith('references/asset'))).toEqual([]);
  });

  it('flags dangling weapon/armor/skill/state/troop ids read off typed Tier 2 nodes (§8.1-2)', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      const list = [
        { code: 127, indent: 0, parameters: [99, 0, 0, 1, false] }, // gainWeapon 99
        { code: 128, indent: 0, parameters: [99, 0, 0, 1, false] }, // gainArmor 99
        { code: 318, indent: 0, parameters: [0, 1, 0, 99] }, // changeSkill: actor 1 learns skill 99
        { code: 313, indent: 0, parameters: [0, 1, 0, 99] }, // changeState: state 99 on actor 1
        { code: 311, indent: 0, parameters: [0, 99, 0, 0, 100, false] }, // changeHp on actor 99
        { code: 301, indent: 0, parameters: [0, 99, false, false] }, // battle troop 99
        { code: 604, indent: 0, parameters: [] },
        { code: 302, indent: 0, parameters: [1, 99, 0, 0, false] }, // shop selling weapon 99
      ];
      data.events.push(mapEvent(2, 'Broken', [page(list)]));
    });
    const findings = await checkReferences(session);
    const dangling = (kind: string, id: number) =>
      findings.some((f) => f.rule === `references/dangling-${kind}` && f.severity === 'error' && f.message.includes(`${id}`));
    expect(dangling('weapon', 99)).toBe(true);
    expect(dangling('armor', 99)).toBe(true);
    expect(dangling('skill', 99)).toBe(true);
    expect(dangling('state', 99)).toBe(true);
    expect(dangling('actor', 99)).toBe(true);
    expect(dangling('troop', 99)).toBe(true);
  });

  it('flags a dangling Show Animation id, and leaves the editor\'s "None" alone', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      const list = [
        { code: 212, indent: 0, parameters: [0, 99, false] }, // animation 99 on this event
        { code: 212, indent: 0, parameters: [-1, 0, false] }, // "None" on the player
      ];
      data.events.push(mapEvent(2, 'Sparkle', [page(list)]));
    });

    const findings = (await checkReferences(session)).filter((f) => f.rule === 'references/dangling-animation');

    // A dangling one is Sprite_Animation reading effectName off undefined — a
    // crash on the frame the event plays, the same class as every other id here.
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('error');
    expect(findings[0].message).toContain('99');
  });

  it('treats actorId 0 as "entire party", not a dangling actor', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      data.events.push(mapEvent(2, 'HealAll', [page([{ code: 314, indent: 0, parameters: [0, 0] }])]));
    });
    const findings = await checkReferences(session);
    expect(findings.filter((f) => f.rule === 'references/dangling-actor')).toEqual([]);
  });

  it('flags dangling class and skill ids in database rows (§8.1-2)', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<Array<{ id: number; classId: number } | null>>('Actors.json', (data) => {
      data[1]!.classId = 99;
    });
    session.updateFile<Array<{ id: number; learnings: Array<{ level: number; skillId: number; note: string }> } | null>>(
      'Classes.json',
      (data) => {
        data[1]!.learnings.push({ level: 5, skillId: 99, note: '' });
      }
    );
    session.updateFile<Array<{ id: number; actions: Array<{ skillId: number }> } | null>>('Enemies.json', (data) => {
      data[1]!.actions[0].skillId = 98;
    });
    const findings = await checkReferences(session);
    expect(findings.some((f) => f.rule === 'references/dangling-class' && f.file === 'Actors.json')).toBe(true);
    expect(findings.some((f) => f.rule === 'references/dangling-skill' && f.file === 'Classes.json' && f.message.includes('99'))).toBe(true);
    expect(findings.some((f) => f.rule === 'references/dangling-skill' && f.file === 'Enemies.json' && f.message.includes('98'))).toBe(true);
  });
});
