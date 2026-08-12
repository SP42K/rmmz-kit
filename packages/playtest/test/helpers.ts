import type { EventConditions, EventPage, MapData, ProjectSession } from '@rmmz-kit/core';
import { mapFileName } from '@rmmz-kit/core';
import { compile, parseDsl } from '@rmmz-kit/compiler';

/**
 * Authoring helper for the tests: the fixture is a *minimal* project, so every
 * scenario here writes the events it is about to run. Pages are written through
 * the real L2 compiler rather than hand-built command arrays — a test that
 * asserts on the interpreter should fail when the interpreter is wrong, not
 * when someone mistypes an indent.
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
  conditions?: Partial<EventConditions>;
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
      pages: event.pages.map((page) => makePage(page)),
    };
  });
}

function makePage(page: TestPage): EventPage {
  return {
    conditions: { ...DEFAULT_CONDITIONS, ...page.conditions },
    directionFix: false,
    image: { tileId: 0, characterName: '', characterIndex: 0, direction: 2, pattern: 0 },
    list: page.dsl ? compile(parseDsl(page.dsl)) : compile([]),
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
