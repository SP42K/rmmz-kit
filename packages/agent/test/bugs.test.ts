import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openProject, type ProjectSession } from '@rmmz-kit/core';
import { RepairLoop } from '../src/loop.js';
import { makeTestProject } from './testProject.js';
import { GATE_PAGE, HERBALIST_PAGE1, HERBALIST_PAGE2, herbQuest, PATCH_PAGE1, PATCH_PAGE2, putEvent, SUITE, type TestPage } from './quest.js';

/**
 * **M9's acceptance criterion, honestly split** (plan §3 M9: 「人工植入 20 個 bug
 * （10 靜態 / 10 動態），自動修復率 ≥ 靜態 8/10、動態 4/10」).
 *
 * The 20 bugs are here. The *repair rate* is not, and cannot be measured from
 * inside this repo, for the same reason M6's 10% battle-sim error and M8's
 * browser half are not: repairing means regenerating, regenerating means an
 * LLM, and there is no model in this test process — the model is the MCP client
 * on the other side of the `repair` tool. Wiring one in would make the number a
 * measurement of that model on that day, not of this package.
 *
 * What *is* measured is the half the plan itself calls the determining variable:
 * 「錯誤訊息品質是修復率的決定變數」. For each injected bug, the loop must (a)
 * notice it at all — every one of these is invisible to `tsc` and to
 * `ProjectSession.validate()` — and (b) produce feedback that names the actual
 * cause, in the vocabulary the agent edits in. A loop that reports "something is
 * wrong" scores 0/10 with any model behind it.
 *
 * To close the other half later: point `runRepairLoop`'s `generate` callback at
 * a real model, run this same table, and count. Nothing in `src/` needs to
 * change — which is why this is written here rather than left as a TODO.
 */

interface Bug {
  name: string;
  kind: 'static' | 'dynamic';
  inject: (session: ProjectSession) => void;
  /** Substrings the feedback must contain — the cause, not just "it failed". */
  expect: string[];
}

const putHerbalist = (session: ProjectSession, pages: TestPage[]) =>
  putEvent(session, 1, { id: 10, name: 'Herbalist', x: 3, y: 4, pages });
const putPatch = (session: ProjectSession, pages: TestPage[]) =>
  putEvent(session, 1, { id: 11, name: 'HerbPatch', x: 9, y: 2, pages });
const putGate = (session: ProjectSession, pages: TestPage[]) =>
  putEvent(session, 1, { id: 12, name: 'Gatekeeper', x: 8, y: 11, pages });

const STATIC_BUGS: Bug[] = [
  {
    name: 'reward hands out an item that does not exist',
    kind: 'static',
    inject: (s) => putHerbalist(s, [HERBALIST_PAGE1, { ...HERBALIST_PAGE2, dsl: '- gainItem: { itemId: 999, operation: 0, value: 1 }' }]),
    expect: ['references/dangling-item', '999', 'edit map 1 event 10'],
  },
  {
    name: 'a page is gated on an actor that is not in the database',
    kind: 'static',
    inject: (s) => putGate(s, [{ ...GATE_PAGE, conditions: { actorValid: true, actorId: 99 } }]),
    expect: ['references/dangling-actor', '99'],
  },
  {
    name: 'the quest calls a common event that was never written',
    kind: 'static',
    inject: (s) => putGate(s, [{ dsl: '- callCommonEvent: 42' }]),
    expect: ['references/dangling-commonEvent', '42'],
  },
  {
    name: 'the gate transfers to a map that does not exist',
    kind: 'static',
    inject: (s) => putGate(s, [{ dsl: '- transfer: { mapId: 77, x: 5, y: 5 }' }]),
    expect: ['references/dangling-map', '77'],
  },
  {
    name: 'the gate transfers off the edge of a map that does exist',
    kind: 'static',
    inject: (s) => putGate(s, [{ dsl: '- transfer: { mapId: 1, x: 500, y: 5 }' }]),
    expect: ['references/transfer-out-of-bounds', '500'],
  },
  {
    name: 'a page names a character sheet that is not in img/characters',
    kind: 'static',
    inject: (s) => {
      // The fixture ships no img/ at all, and the rule abstains on a folder it
      // cannot list (an absent folder is not proof of an absent file). Staging
      // one sheet through the transaction is enough to make the folder real to
      // the validator without writing anything to the fixture on disk.
      s.writeRaw('img/characters/Actor1.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      putGate(s, [{ ...GATE_PAGE, image: { characterName: 'NoSuchSheet' } }]);
    },
    expect: ['references/asset-missing', 'NoSuchSheet'],
  },
  {
    name: 'a later page with looser conditions makes the first one unreachable',
    kind: 'static',
    // MZ matches last-to-first, so an unconditional page 2 means page 1 never runs.
    inject: (s) => putPatch(s, [PATCH_PAGE1, { ...PATCH_PAGE2, conditions: {} }]),
    expect: ['semantics/dead-event-page', 'edit map 1 event 11'],
  },
  {
    name: 'a conditional branch is never closed',
    kind: 'static',
    inject: (s) =>
      putGate(s, [
        {
          list: [
            { code: 111, indent: 0, parameters: [0, 11, 0] },
            { code: 101, indent: 1, parameters: ['', 0, 0, 2] },
            { code: 401, indent: 1, parameters: ['Go on through.'] },
            { code: 0, indent: 0, parameters: [] },
          ],
        },
      ]),
    expect: ['structure/malformed-block'],
  },
  {
    name: 'a message continuation line has no Show Text before it',
    kind: 'static',
    inject: (s) => putGate(s, [{ list: [{ code: 401, indent: 0, parameters: ['orphaned line'] }, { code: 0, indent: 0, parameters: [] }] }]),
    expect: ['structure/orphan-continuation'],
  },
  {
    name: 'a Break Loop sits outside any loop',
    kind: 'static',
    inject: (s) => putGate(s, [{ list: [{ code: 113, indent: 0, parameters: [] }, { code: 0, indent: 0, parameters: [] }] }]),
    expect: ['structure/break-outside-loop'],
  },
];

const DYNAMIC_BUGS: Bug[] = [
  {
    name: 'the herbalist never starts the quest',
    kind: 'dynamic',
    inject: (s) => putHerbalist(s, [{ dsl: '- say: "There are herbs in the north forest."' }, HERBALIST_PAGE2]),
    expect: ['switch 10: expected true, got false'],
  },
  {
    name: 'the herb patch hands over nothing',
    kind: 'dynamic',
    inject: (s) => putPatch(s, [{ ...PATCH_PAGE1, dsl: '- say: "Picked a herb."\n- setSelfSwitch: { ch: A, value: true }' }, PATCH_PAGE2]),
    expect: ['item 1 count gte: expected 1, got 0'],
  },
  {
    name: 'the herb patch never remembers it was picked',
    kind: 'dynamic',
    inject: (s) => putPatch(s, [{ ...PATCH_PAGE1, dsl: '- gainItem: { itemId: 1, operation: 0, value: 1 }\n- say: "Picked a herb."' }, PATCH_PAGE2]),
    expect: ['self switch 1,11,A: expected true, got false'],
  },
  {
    name: 'the reward pays the wrong amount',
    kind: 'dynamic',
    inject: (s) => putHerbalist(s, [HERBALIST_PAGE1, { ...HERBALIST_PAGE2, dsl: HERBALIST_PAGE2.dsl!.replace('value: 100', 'value: 50') }]),
    expect: ['gold eq: expected 100, got 50'],
  },
  {
    name: 'the reward never flips the switch the gate reads',
    kind: 'dynamic',
    inject: (s) => putHerbalist(s, [HERBALIST_PAGE1, { ...HERBALIST_PAGE2, dsl: HERBALIST_PAGE2.dsl!.replace('- setSwitch: { from: 11, value: true }', '') }]),
    expect: ['switch 11: expected true, got false'],
  },
  {
    name: 'the gate has its branches the wrong way round',
    kind: 'dynamic',
    inject: (s) =>
      putGate(s, [
        {
          dsl: `
- if:
    switch: 11
    then:
      - say: "Help the herbalist first."
    else:
      - say: "Go on through."
      - transfer: { mapId: 1, x: 5, y: 5 }
`,
        },
      ]),
    expect: ['a message containing "Help the herbalist first."'],
  },
  {
    name: 'the reward page waits on the wrong item, so it never triggers',
    kind: 'dynamic',
    inject: (s) => putHerbalist(s, [HERBALIST_PAGE1, { ...HERBALIST_PAGE2, conditions: { switch1Valid: true, switch1Id: 10, itemValid: true, itemId: 2 } }]),
    expect: ['gold eq: expected 100, got 0'],
  },
  {
    name: 'the gate drops the player somewhere else',
    kind: 'dynamic',
    inject: (s) => putGate(s, [{ ...GATE_PAGE, dsl: GATE_PAGE.dsl!.replace('x: 5, y: 5', 'x: 9, y: 9') }]),
    expect: ['player position', '"x":5', '"x":9'],
  },
  {
    name: 'the reward never takes the herb back',
    kind: 'dynamic',
    inject: (s) => putHerbalist(s, [HERBALIST_PAGE1, { ...HERBALIST_PAGE2, dsl: HERBALIST_PAGE2.dsl!.replace('- gainItem: { itemId: 1, operation: 1, value: 1 }', '') }]),
    expect: ['item 1 count eq: expected 0, got 1'],
  },
  {
    name: 'an event loops forever — the one softlock class this layer catches',
    kind: 'dynamic',
    inject: (s) => putGate(s, [{ dsl: '- loop:\n    body:\n      - wait: 1' }]),
    expect: ['THREW', 'Command budget exhausted'],
  },
];

const BUGS = [...STATIC_BUGS, ...DYNAMIC_BUGS];

describe('injected bug corpus (M9 acceptance)', () => {
  let project: { dir: string; cleanup: () => Promise<void> };

  // One fixture copy for the file: no test here commits, so the project on disk
  // is never touched and each test's own `openProject` starts from the same
  // bytes. (Copy + `git init` is 1-2s on Windows; 20 of them is the whole
  // runtime of this file.)
  beforeAll(async () => {
    project = await makeTestProject();
  });
  afterAll(async () => {
    await project.cleanup();
  });

  it('has the 10 static / 10 dynamic split the plan asks for', () => {
    expect(STATIC_BUGS).toHaveLength(10);
    expect(DYNAMIC_BUGS).toHaveLength(10);
    expect(new Set(BUGS.map((b) => b.name)).size).toBe(20);
  });

  for (const bug of BUGS) {
    it(`[${bug.kind}] ${bug.name}`, async () => {
      const session = await openProject(project.dir);
      herbQuest(session);

      const loop = new RepairLoop(session, { scenarios: SUITE });
      // The quest works before the bug goes in — "the loop noticed" is worth
      // nothing if the scenario was red to begin with.
      expect((await loop.start()).outcome).toBe('clean');

      bug.inject(session);
      const result = await loop.check();

      expect(result.outcome).toBe('repairing');
      expect(result.feedback).toContain(bug.kind === 'static' ? 'STATIC GATE' : 'SCENARIO');
      for (const needle of bug.expect) expect(result.feedback).toContain(needle);
    });
  }
});
