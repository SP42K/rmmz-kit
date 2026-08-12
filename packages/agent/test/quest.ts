import type { EventCommand, EventConditions, EventPage, MapData, ProjectSession } from '@rmmz-kit/core';
import { mapFileName } from '@rmmz-kit/core';
import { compile, parseDsl } from '@rmmz-kit/compiler';
import type { Scenario } from '@rmmz-kit/playtest';

/**
 * The subject the repair loop is exercised against: M8's three-event herb quest
 * (plan §4.2), plus the regression suite that says it works. Reused verbatim so
 * the bug corpus in bugs.test.ts breaks something that demonstrably worked
 * first — "the loop noticed" means nothing if the scenario was never green.
 *
 * The fixture is a *minimal* project, so the quest is written by the test,
 * through the real L2 compiler rather than hand-built command arrays.
 */

const DEFAULT_CONDITIONS: EventConditions = {
  actorId: 1,
  actorValid: false,
  itemId: 1,
  itemValid: false,
  selfSwitchCh: 'A',
  selfSwitchValid: false,
  switch1Id: 1,
  switch1Valid: false,
  switch2Id: 1,
  switch2Valid: false,
  variableId: 1,
  variableValid: false,
  variableValue: 0,
};

export interface TestPage {
  dsl?: string;
  /** Raw command list, for the malformed structures a DSL cannot express. */
  list?: EventCommand[];
  conditions?: Partial<EventConditions>;
  image?: Partial<EventPage['image']>;
  trigger?: number;
}

export function putEvent(
  session: ProjectSession,
  mapId: number,
  event: { id: number; name?: string; x?: number; y?: number; pages: TestPage[] }
): void {
  session.updateFile<MapData>(mapFileName(mapId), (map) => {
    while (map.events.length <= event.id) map.events.push(null);
    map.events[event.id] = {
      id: event.id,
      name: event.name ?? `EV${String(event.id).padStart(3, '0')}`,
      note: '',
      x: event.x ?? 0,
      y: event.y ?? 0,
      pages: event.pages.map(makePage),
    };
  });
}

function makePage(page: TestPage): EventPage {
  return {
    conditions: { ...DEFAULT_CONDITIONS, ...page.conditions },
    directionFix: false,
    image: { tileId: 0, characterName: '', characterIndex: 0, direction: 2, pattern: 0, ...page.image },
    list: page.list ?? (page.dsl ? compile(parseDsl(page.dsl)) : compile([])),
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 3,
    moveType: 0,
    priorityType: 1,
    stepAnime: false,
    through: false,
    trigger: page.trigger ?? 0,
    walkAnime: true,
  };
}

/** The herbalist (10), the herb patch (11) and the gatekeeper (12). */
export function herbQuest(session: ProjectSession): void {
  putEvent(session, 1, { id: 10, name: 'Herbalist', x: 3, y: 4, pages: [HERBALIST_PAGE1, HERBALIST_PAGE2] });
  putEvent(session, 1, { id: 11, name: 'HerbPatch', x: 9, y: 2, pages: [PATCH_PAGE1, PATCH_PAGE2] });
  putEvent(session, 1, { id: 12, name: 'Gatekeeper', x: 8, y: 11, pages: [GATE_PAGE] });
}

export const HERBALIST_PAGE1: TestPage = {
  dsl: `
- say:
    speaker: Herbalist
    text: "There are herbs in the north forest — could you pick one for me?"
- setSwitch: { from: 10, value: true }
`,
};

export const HERBALIST_PAGE2: TestPage = {
  conditions: { switch1Valid: true, switch1Id: 10, itemValid: true, itemId: 1 },
  dsl: `
- say: "You found one! Here is your reward."
- gainItem: { itemId: 1, operation: 1, value: 1 }
- gainGold: { operation: 0, value: 100 }
- setSwitch: { from: 11, value: true }
`,
};

export const PATCH_PAGE1: TestPage = {
  conditions: { switch1Valid: true, switch1Id: 10 },
  dsl: `
- gainItem: { itemId: 1, operation: 0, value: 1 }
- say: "Picked a herb."
- setSelfSwitch: { ch: A, value: true }
`,
};

export const PATCH_PAGE2: TestPage = {
  conditions: { selfSwitchValid: true, selfSwitchCh: 'A' },
  dsl: '- say: "Nothing left here."',
};

export const GATE_PAGE: TestPage = {
  dsl: `
- if:
    switch: 11
    then:
      - say: "Go on through."
      - transfer: { mapId: 1, x: 5, y: 5 }
    else:
      - say: "Help the herbalist first."
`,
};

/** The regression suite: the whole chain, plus one narrower run over the gate alone. */
export const SUITE: Scenario[] = [
  {
    name: 'herb quest',
    // The chain is ~50 commands; the budget is here to catch a runaway loop
    // quickly rather than after the 100k default.
    maxCommands: 5000,
    steps: [
      { action: 'runEvent', map: 1, event: 12 },
      { action: 'expect', expect: { message: 'Help the herbalist first.', switch: { id: 10, value: false } } },

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
        expect: { switch: { id: 11, value: true }, gold: { value: 100 }, item: { id: 1, count: 0, cmp: 'eq' }, message: 'Here is your reward.' },
      },

      { action: 'runEvent', map: 1, event: 12 },
      { action: 'expect', expect: { message: 'Go on through.', playerAt: { map: 1, x: 5, y: 5 } } },
    ],
  },
  {
    // Deliberately about something the chain never reaches: the chain only ever
    // touches the patch *after* the quest starts, so a "fix" that drops the
    // patch's gating condition passes the chain and fails only here.
    name: 'herb patch is inert before the quest',
    steps: [
      { action: 'expect', expect: { activePage: { map: 1, event: 11, page: 0 } } },
      { action: 'setSwitch', id: 10, value: true },
      { action: 'expect', expect: { activePage: { map: 1, event: 11, page: 1 } } },
    ],
  },
];
