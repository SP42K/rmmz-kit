import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openProject, type MapData, type SystemData } from '@rmmz-kit/core';
import { validateProject } from '../src/index.js';
import { makeTestProject } from './testProject.js';
import { mapEvent, page, blankConditions } from './helpers.js';

/**
 * Mirrors the plan's M4 acceptance test (§3 "手動在 fixture 埋 20 種已知錯誤，
 * 偵測率 ≥ 18/20"): plant one instance of every rule this package implements
 * in a single project, then check each rule fired at least once. 17 rules
 * implemented here (dangling weapon/armor/skill/state/troop/class ids and
 * generic softlock detection are explicitly out of scope — see rules/*.ts
 * doc comments — so this covers the full implemented set, not literally 20).
 */
describe('validateProject (M4 acceptance)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  it('detects one planted instance of every implemented rule', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);

    await mkdir(path.join(dir, 'img', 'faces'), { recursive: true });
    await writeFile(path.join(dir, 'img', 'faces', 'Actor1.png'), '');

    session.updateFile<SystemData>('System.json', (data) => {
      data.switches = [];
      data.switches[10] = 'quest.herb.0';
      data.switches[20] = 'quest.flower.0';
      data.switches[30] = 'unused.flag';
    });

    session.updateFile<MapData>('Map001.json', (data) => {
      // structure/malformed-block: unterminated Conditional Branch (missing 412)
      data.events.push(
        mapEvent(2, 'E-structure-malformed', [
          { ...page([]), list: [{ code: 111, indent: 0, parameters: [0, 10, 0] }, { code: 0, indent: 0, parameters: [] }] },
        ])
      );
      // structure/orphan-continuation: 401 with nothing before it
      data.events.push(mapEvent(3, 'E-orphan-continuation', [page([{ code: 401, indent: 0, parameters: ['orphan'] }])]));
      // structure/break-outside-loop
      data.events.push(mapEvent(4, 'E-break-outside-loop', [page([{ code: 113, indent: 0, parameters: [] }])]));
      // references/dangling-item
      data.events.push(mapEvent(5, 'E-dangling-item', [page([{ code: 126, indent: 0, parameters: [999, 0, 0, 0, 1] }])]));
      // references/dangling-commonEvent
      data.events.push(mapEvent(6, 'E-dangling-commonEvent', [page([{ code: 117, indent: 0, parameters: [42] }])]));
      // references/dangling-map
      data.events.push(mapEvent(7, 'E-dangling-map', [page([{ code: 201, indent: 0, parameters: [0, 999, 0, 0, 0, 0] }])]));
      // references/transfer-out-of-bounds (Map001 is 17x13)
      data.events.push(mapEvent(8, 'E-transfer-oob', [page([{ code: 201, indent: 0, parameters: [0, 1, 99, 99, 0, 0] }])]));
      // references/unnamed-switch
      data.events.push(mapEvent(9, 'E-unnamed-switch', [page([{ code: 121, indent: 0, parameters: [50, 50, 0] }])]));
      // references/asset-missing + references/asset-case-mismatch
      data.events.push(
        mapEvent(10, 'E-assets', [
          page([
            { code: 101, indent: 0, parameters: ['NoSuchFace', 0, 0, 2] },
            { code: 401, indent: 0, parameters: ['x'] },
            { code: 101, indent: 0, parameters: ['actor1', 0, 0, 2] },
            { code: 401, indent: 0, parameters: ['x'] },
          ]),
        ])
      );
      // semantics/dead-event-page: page1 specific, page2 catch-all (checked first)
      data.events.push(
        mapEvent(11, 'E-dead-page', [
          page([], { conditions: blankConditions({ switch1Valid: true, switch1Id: 10 }) }),
          page([]),
        ])
      );
      // semantics/self-switch-never-read
      data.events.push(mapEvent(12, 'E-self-switch', [page([{ code: 123, indent: 0, parameters: ['A', 0] }])]));
      // semantics/cross-namespace-switch-write
      data.events.push(
        mapEvent(13, 'E-cross-namespace', [
          page([{ code: 121, indent: 0, parameters: [20, 20, 0] }], {
            conditions: blankConditions({ switch1Valid: true, switch1Id: 10 }),
          }),
        ])
      );
      // semantics/possible-negative-gold
      data.events.push(mapEvent(14, 'E-negative-gold', [page([{ code: 125, indent: 0, parameters: [1, 0, 500] }])]));
      // semantics/possible-negative-item
      data.events.push(mapEvent(15, 'E-negative-item', [page([{ code: 126, indent: 0, parameters: [3, 1, 0, 0, 1] }])]));
    });
    // references/dangling-actor
    session.updateFile<MapData>('Map001.json', (data) => {
      data.events.push(
        mapEvent(16, 'E-dangling-actor', [page([], { conditions: blankConditions({ actorValid: true, actorId: 999 }) })])
      );
    });

    const findings = await validateProject(session);
    const rulesFound = new Set(findings.map((f) => f.rule));

    const expectedRules = [
      'structure/malformed-block',
      'structure/orphan-continuation',
      'structure/break-outside-loop',
      'references/dangling-item',
      'references/dangling-actor',
      'references/dangling-commonEvent',
      'references/dangling-map',
      'references/transfer-out-of-bounds',
      'references/unnamed-switch',
      'references/asset-missing',
      'references/asset-case-mismatch',
      'semantics/dead-event-page',
      'semantics/self-switch-never-read',
      'semantics/cross-namespace-switch-write',
      'semantics/possible-negative-gold',
      'semantics/possible-negative-item',
      'semantics/unused-switch',
    ];

    const missing = expectedRules.filter((r) => !rulesFound.has(r));
    expect(missing).toEqual([]);
    expect(rulesFound.size).toBeGreaterThanOrEqual(expectedRules.length);
  });
});
