import { describe, it, expect, afterEach } from 'vitest';
import { openProject, type MapData } from '@rmmz-kit/core';
import { checkStructure } from '../src/rules/structure.js';
import { makeTestProject } from './testProject.js';
import { mapEvent, page } from './helpers.js';

describe('checkStructure', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  it('flags exactly the fixture\'s one known-bad block: a Break Loop at the same indent as its Loop, not nested', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    // packages/compiler/test/decompile.test.ts documents and routes around this same
    // pre-existing fixture defect (hand-authored test data, not real MZ editor output).
    // checkStructure correctly catches it via the same decompile() call.
    const findings = checkStructure(session);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'structure/malformed-block', file: 'Map001.json' });
  });

  it('flags a missing terminator', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      const list = [{ code: 101, indent: 0, parameters: ['', 0, 0, 2] }, { code: 401, indent: 0, parameters: ['hi'] }];
      data.events.push(mapEvent(2, 'Broken', [{ ...page([]), list }]));
    });
    const findings = checkStructure(session);
    expect(findings.some((f) => f.rule === 'structure/malformed-block')).toBe(true);
  });

  it('flags an unterminated Conditional Branch (missing 412)', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      const list = [
        { code: 111, indent: 0, parameters: [0, 5, 0] },
        { code: 121, indent: 1, parameters: [5, 5, 0] },
        { code: 0, indent: 0, parameters: [] },
      ];
      data.events.push(mapEvent(2, 'Broken', [{ ...page([]), list }]));
    });
    const findings = checkStructure(session);
    expect(findings.some((f) => f.rule === 'structure/malformed-block')).toBe(true);
  });

  it('flags an orphan Show Text continuation (401 with no preceding 101)', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      data.events.push(mapEvent(2, 'Broken', [page([{ code: 401, indent: 0, parameters: ['orphan'] }])]));
    });
    const findings = checkStructure(session);
    expect(findings.some((f) => f.rule === 'structure/orphan-continuation')).toBe(true);
  });

  it('flags Break Loop (113) outside any loop', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      data.events.push(mapEvent(2, 'Broken', [page([{ code: 113, indent: 0, parameters: [] }])]));
    });
    const findings = checkStructure(session);
    expect(findings.some((f) => f.rule === 'structure/break-outside-loop')).toBe(true);
  });

  it('does not flag Break Loop inside a loop', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      const list = [
        { code: 112, indent: 0, parameters: [] },
        { code: 113, indent: 1, parameters: [] },
        { code: 413, indent: 0, parameters: [] },
      ];
      data.events.push(mapEvent(2, 'Fine', [{ ...page([]), list: [...list, { code: 0, indent: 0, parameters: [] }] }]));
    });
    const findings = checkStructure(session);
    expect(findings.filter((f) => f.file === 'Map001.json' && f.path?.includes('event 2'))).toEqual([]);
  });
});
