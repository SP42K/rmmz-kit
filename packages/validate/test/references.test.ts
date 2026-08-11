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
      const list = [{ code: 126, indent: 0, parameters: [999, 0, 0, 0, 1] }];
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
});
