import type { EventCommand, EventConditions, EventPage, MapEvent } from '@rmmz-kit/core';

export function blankConditions(overrides: Partial<EventConditions> = {}): EventConditions {
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
    ...overrides,
  };
}

const TERMINATOR: EventCommand = { code: 0, indent: 0, parameters: [] };

export function page(list: EventCommand[], overrides: Partial<EventPage> = {}): EventPage {
  return {
    conditions: blankConditions(),
    directionFix: false,
    image: { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 },
    list: [...list, TERMINATOR],
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 3,
    moveType: 0,
    priorityType: 1,
    stepAnime: false,
    through: false,
    trigger: 0,
    walkAnime: true,
    ...overrides,
  };
}

export function mapEvent(id: number, name: string, pages: EventPage[]): MapEvent {
  return { id, name, note: '', x: 1, y: 1, pages };
}
