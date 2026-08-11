import { describe, it, expect, afterEach } from 'vitest';
import { openProject, type MapData, type SystemData } from '@rmmz-kit/core';
import { checkSemantics } from '../src/rules/semantics.js';
import { makeTestProject } from './testProject.js';
import { mapEvent, page, blankConditions } from './helpers.js';

describe('checkSemantics', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  it('finds nothing wrong with the fixture as shipped', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    expect(checkSemantics(session)).toEqual([]);
  });

  it('flags a page shadowed by a later, weaker-conditioned page', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      const specific = page([], { conditions: blankConditions({ switch1Valid: true, switch1Id: 5 }) });
      const catchAll = page([]); // no conditions -> always matches, and is checked first (later page = higher priority)
      data.events.push(mapEvent(2, 'Shadowed', [specific, catchAll]));
    });
    const findings = checkSemantics(session);
    expect(findings.some((f) => f.rule === 'semantics/dead-event-page' && f.path?.includes('page 1'))).toBe(true);
  });

  it('does not flag a normal default-then-specific page order', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      const catchAll = page([]);
      const specific = page([], { conditions: blankConditions({ switch1Valid: true, switch1Id: 5 }) });
      data.events.push(mapEvent(2, 'Fine', [catchAll, specific]));
    });
    const findings = checkSemantics(session);
    expect(findings.filter((f) => f.rule === 'semantics/dead-event-page')).toEqual([]);
  });

  it('does not flag pages gated on the same variable at different thresholds', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      // var 1 >= 5 then var 1 >= 10: page 2 wins from 10 up, page 1 still runs
      // for 5..9, so neither is dead. Ignoring the threshold would call page 1 dead.
      const early = page([], { conditions: blankConditions({ variableValid: true, variableId: 1, variableValue: 5 }) });
      const late = page([], { conditions: blankConditions({ variableValid: true, variableId: 1, variableValue: 10 }) });
      data.events.push(mapEvent(2, 'Quest stages', [early, late]));
    });
    const findings = checkSemantics(session);
    expect(findings.filter((f) => f.rule === 'semantics/dead-event-page')).toEqual([]);
  });

  it('flags a self switch turned on but never reset anywhere in the event', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      const list = [{ code: 123, indent: 0, parameters: ['A', 0] }]; // 0 = ON
      data.events.push(mapEvent(2, 'Stuck', [page(list)]));
    });
    const findings = checkSemantics(session);
    expect(findings.some((f) => f.rule === 'semantics/self-switch-never-reset')).toBe(true);
  });

  it('does not flag a self switch that is also turned off somewhere in the event', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      const on = page([{ code: 123, indent: 0, parameters: ['A', 0] }]);
      const off = page([{ code: 123, indent: 0, parameters: ['A', 1] }]);
      data.events.push(mapEvent(2, 'Fine', [on, off]));
    });
    const findings = checkSemantics(session);
    expect(findings.filter((f) => f.rule === 'semantics/self-switch-never-reset')).toEqual([]);
  });

  it('flags a page writing a switch from a different named namespace than the one gating it', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<SystemData>('System.json', (data) => {
      data.switches = [];
      data.switches[10] = 'quest.herb.0';
      data.switches[20] = 'quest.flower.0';
    });
    session.updateFile<MapData>('Map001.json', (data) => {
      const list = [{ code: 121, indent: 0, parameters: [20, 20, 0] }];
      data.events.push(
        mapEvent(2, 'Copy-paste bug', [page(list, { conditions: blankConditions({ switch1Valid: true, switch1Id: 10 }) })])
      );
    });
    const findings = checkSemantics(session);
    expect(findings.some((f) => f.rule === 'semantics/cross-namespace-switch-write')).toBe(true);
  });

  it('does not flag a write within the same namespace', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<SystemData>('System.json', (data) => {
      data.switches = [];
      data.switches[10] = 'quest.herb.0';
      data.switches[11] = 'quest.herb.1';
    });
    session.updateFile<MapData>('Map001.json', (data) => {
      const list = [{ code: 121, indent: 0, parameters: [11, 11, 0] }];
      data.events.push(
        mapEvent(2, 'Fine', [page(list, { conditions: blankConditions({ switch1Valid: true, switch1Id: 10 }) })])
      );
    });
    const findings = checkSemantics(session);
    expect(findings.filter((f) => f.rule === 'semantics/cross-namespace-switch-write')).toEqual([]);
  });

  it('flags Change Gold decrease with no enclosing Gold>= guard, and not one that has a guard', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      const unguarded = [{ code: 125, indent: 0, parameters: [1, 0, 500] }];
      const guarded = [
        { code: 111, indent: 0, parameters: [7, 500, 0] },
        { code: 125, indent: 1, parameters: [1, 0, 500] },
        { code: 412, indent: 0, parameters: [] },
      ];
      // parameters[2] = 1 is "Gold <= 500", the opposite check — not a guard.
      const backwards = [
        { code: 111, indent: 0, parameters: [7, 500, 1] },
        { code: 125, indent: 1, parameters: [1, 0, 500] },
        { code: 412, indent: 0, parameters: [] },
      ];
      data.events.push(mapEvent(2, 'Unguarded', [page(unguarded)]));
      data.events.push(mapEvent(3, 'Guarded', [page(guarded)]));
      data.events.push(mapEvent(4, 'Backwards guard', [page(backwards)]));
    });
    const findings = checkSemantics(session);
    const negGold = findings.filter((f) => f.rule === 'semantics/possible-negative-gold');
    expect(negGold.some((f) => f.path?.includes('event 2'))).toBe(true);
    expect(negGold.some((f) => f.path?.includes('event 3'))).toBe(false);
    expect(negGold.some((f) => f.path?.includes('event 4'))).toBe(true);
  });

  it('flags Change Items decrease with no enclosing has-item guard, and not one that has a guard', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<MapData>('Map001.json', (data) => {
      const unguarded = [{ code: 126, indent: 0, parameters: [3, 1, 0, 0, 1] }];
      const guarded = [
        { code: 111, indent: 0, parameters: [8, 3, 0] },
        { code: 126, indent: 1, parameters: [3, 1, 0, 0, 1] },
        { code: 412, indent: 0, parameters: [] },
      ];
      data.events.push(mapEvent(2, 'Unguarded', [page(unguarded)]));
      data.events.push(mapEvent(3, 'Guarded', [page(guarded)]));
    });
    const findings = checkSemantics(session);
    const negItem = findings.filter((f) => f.rule === 'semantics/possible-negative-item');
    expect(negItem.some((f) => f.path?.includes('event 2'))).toBe(true);
    expect(negItem.some((f) => f.path?.includes('event 3'))).toBe(false);
  });

  it('reports a named switch that is never referenced as a cleanup suggestion', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const session = await openProject(dir);
    session.updateFile<SystemData>('System.json', (data) => {
      data.switches = [];
      data.switches[7] = 'unused.flag';
    });
    const findings = checkSemantics(session);
    expect(findings.some((f) => f.rule === 'semantics/unused-switch' && f.message.includes('unused.flag'))).toBe(true);
  });
});
