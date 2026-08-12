import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openProject, type ProjectSession } from '@rmmz-kit/core';
import { runScenario, type Scenario } from '../src/scenario.js';
import { makeTestProject } from './testProject.js';
import { putEvent } from './helpers.js';

/**
 * M8's acceptance criterion (plan §3 M8): "對 fixture 跑完一條 3 事件的任務鏈,
 * 全綠, 單次執行 < 10 秒". The chain is the plan's own herb quest (§4.2) split
 * across three events, and the assertions are state assertions, never
 * screenshots (§4.6).
 */
function herbQuest(session: ProjectSession): void {
  // 1. The herbalist: hands out the quest, and pays for it once you carry a herb.
  putEvent(session, 1, {
    id: 10,
    name: 'Herbalist',
    x: 3,
    y: 4,
    pages: [
      {
        dsl: `
- say:
    speaker: Herbalist
    text: "There are herbs in the north forest — could you pick one for me?"
- choice:
    branches:
      Sure:
        - setSwitch: { from: 10, value: true }
        - say: "Thank you!"
      Not now:
        - say: "…so be it."
`,
      },
      {
        // Both conditions: the quest is running AND the herb is in the bag.
        conditions: { switch1Valid: true, switch1Id: 10, itemValid: true, itemId: 1 },
        dsl: `
- say: "You found one! Here is your reward."
- gainItem: { itemId: 1, operation: 1, value: 1 }
- gainGold: { operation: 0, value: 100 }
- setSwitch: { from: 11, value: true }
`,
      },
    ],
  });

  // 2. The herb patch: gives one herb, then remembers it is picked (self switch).
  putEvent(session, 1, {
    id: 11,
    name: 'HerbPatch',
    x: 9,
    y: 2,
    pages: [
      {
        conditions: { switch1Valid: true, switch1Id: 10 },
        dsl: `
- gainItem: { itemId: 1, operation: 0, value: 1 }
- say: "Picked a herb."
- setSelfSwitch: { ch: A, value: true }
`,
      },
      { conditions: { selfSwitchValid: true, selfSwitchCh: 'A' }, dsl: '- say: "Nothing left here."' },
    ],
  });

  // 3. The gatekeeper: only lets you through once the herbalist is happy.
  putEvent(session, 1, {
    id: 12,
    name: 'Gatekeeper',
    x: 8,
    y: 11,
    pages: [
      {
        dsl: `
- if:
    switch: 11
    then:
      - say: "Go on through."
      - transfer: { mapId: 1, x: 5, y: 5 }
    else:
      - say: "Help the herbalist first."
`,
      },
    ],
  });
}

const QUEST_RUN: Scenario = {
  name: 'herb quest',
  steps: [
    { action: 'runEvent', map: 1, event: 12 },
    { action: 'expect', expect: { message: 'Help the herbalist first.', switch: { id: 10, value: false } } },

    { action: 'answerChoices', choices: [0] },
    { action: 'runEvent', map: 1, event: 10 },
    { action: 'expect', expect: { switch: { id: 10, value: true } } },

    { action: 'runEvent', map: 1, event: 11 },
    { action: 'expect', expect: { item: { id: 1, count: 1 }, selfSwitch: { map: 1, event: 11, ch: 'A', value: true } } },

    // The patch has moved on to its "already picked" page — MZ's last-to-first match.
    { action: 'runEvent', map: 1, event: 11 },
    { action: 'expect', expect: { activePage: { map: 1, event: 11, page: 2 }, item: { id: 1, count: 1, cmp: 'eq' } } },

    { action: 'runEvent', map: 1, event: 10 },
    {
      action: 'expect',
      expect: {
        switch: { id: 11, value: true },
        gold: { value: 100 },
        item: { id: 1, count: 0, cmp: 'eq' },
        message: 'Here is your reward.',
      },
    },

    { action: 'runEvent', map: 1, event: 12 },
    { action: 'expect', expect: { message: 'Go on through.', playerAt: { map: 1, x: 5, y: 5 } } },
  ],
};

describe('scenario runner', () => {
  let project: { dir: string; cleanup: () => Promise<void> };
  let session: ProjectSession;

  beforeEach(async () => {
    project = await makeTestProject();
    session = await openProject(project.dir);
    herbQuest(session);
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it('runs the three-event quest chain green in well under 10 seconds', () => {
    const report = runScenario(session, QUEST_RUN);

    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.durationMs).toBeLessThan(10_000);
    // Nothing in this chain is outside the event layer, so a clean run means
    // the assertions really were proven — see `unmodeled`'s doc comment.
    expect(report.unmodeled).toEqual([]);
    expect(report.coverage.messagesVisited).toBeGreaterThan(0);
  });

  it('runs against uncommitted edits, so a fix can be tested before it lands', () => {
    // The reward is the thing under test; change it in memory only.
    putEvent(session, 1, {
      id: 10,
      name: 'Herbalist',
      x: 3,
      y: 4,
      pages: [
        { dsl: '- setSwitch: { from: 10, value: true }' },
        {
          conditions: { switch1Valid: true, switch1Id: 10, itemValid: true, itemId: 1 },
          dsl: '- gainGold: { operation: 0, value: 500 }\n- setSwitch: { from: 11, value: true }',
        },
      ],
    });

    const report = runScenario(session, {
      steps: [
        { action: 'runEvent', map: 1, event: 10 },
        { action: 'runEvent', map: 1, event: 11 },
        { action: 'runEvent', map: 1, event: 10 },
        { action: 'expect', expect: { gold: { value: 500 } } },
      ],
    });

    expect(report.pass).toBe(true);
    expect(session.dirtyFiles()).toContain('Map001.json');
  });

  it('reports which check failed, with expected and actual', () => {
    const report = runScenario(session, {
      steps: [
        { action: 'runEvent', map: 1, event: 12 },
        { action: 'expect', expect: { switch: { id: 11, value: true }, gold: { value: 100 } } },
      ],
    });

    expect(report.pass).toBe(false);
    expect(report.failures).toEqual([
      'step 1 expect switch 11: expected true, got false',
      'step 1 expect gold eq: expected 100, got 0',
    ]);
    // The state snapshot rides along, so a repair loop sees the whole picture.
    expect(report.state).toMatchObject({ gold: 0 });
  });

  it('stops at a step that throws rather than asserting about a game that never got there', () => {
    const report = runScenario(session, {
      steps: [
        { action: 'runEvent', map: 1, event: 99 },
        { action: 'expect', expect: { switch: { id: 10, value: true } } },
      ],
    });

    expect(report.pass).toBe(false);
    expect(report.steps).toHaveLength(1);
    expect(report.failures[0]).toMatch(/Map 1 has no event 99/);
  });

  it('an unanswerable page is a scenario failure, not a silent skip', () => {
    const report = runScenario(session, {
      steps: [{ action: 'runEvent', map: 1, event: 11 }],
    });

    // Event 11's only unconditional page is its self-switch one; without the
    // quest switch, MZ would leave the event inert.
    expect(report.failures[0]).toMatch(/no page whose conditions are met/);
  });
});
