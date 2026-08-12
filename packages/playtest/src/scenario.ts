import type { ProjectSession } from '@rmmz-kit/core';
import { Interpreter, type BattleCall, type CoverageReport, type PluginCall } from './interpreter.js';
import { GameState, type ItemKind, type ShownChoice, type ShownMessage } from './state.js';

/**
 * A scenario is data, not code (plan §3 M8 writes its example as `expect(...)`
 * in TypeScript, but the caller here is an MCP client): a list of actions and
 * assertions an agent can emit as JSON, and a report it can read back without
 * parsing a test runner's output. That report is also what M9's repair loop
 * needs — which step failed, what the state was, and what the run never
 * touched.
 *
 * Assertions are over state, never over pixels (§4.6).
 */

export type Comparison = 'eq' | 'gte' | 'lte' | 'gt' | 'lt' | 'neq';

export type ScenarioStep =
  | { action: 'runEvent'; map: number; event: number; page?: number }
  | { action: 'runCommonEvent'; id: number }
  | { action: 'setSwitch'; id: number; value: boolean }
  | { action: 'setVariable'; id: number; value: number }
  | { action: 'setSelfSwitch'; map: number; event: number; ch: string; value: boolean }
  | { action: 'gainGold'; amount: number }
  | { action: 'gainItem'; kind?: ItemKind; id: number; amount: number }
  | { action: 'teleport'; map: number; x: number; y: number }
  | { action: 'answerChoices'; choices: number[] }
  | { action: 'answerBattles'; outcomes: Array<'win' | 'escape' | 'lose'> }
  | { action: 'expect'; expect: Assertion };

/** Every field present is one check; absent fields are not checked. */
export interface Assertion {
  switch?: { id: number; value: boolean };
  variable?: { id: number; value: number; cmp?: Comparison };
  selfSwitch?: { map: number; event: number; ch: string; value: boolean };
  gold?: { value: number; cmp?: Comparison };
  item?: { kind?: ItemKind; id: number; count?: number; cmp?: Comparison };
  /** Party contains this actor id. */
  partyHas?: number;
  playerAt?: { map: number; x?: number; y?: number };
  /** A shown message line contains this substring. */
  message?: string;
  /** No shown message line contains this substring — the "the NPC must not still offer the quest" assertion. */
  noMessage?: string;
  /** This plugin command was issued. */
  pluginCalled?: { plugin: string; command: string };
  /** The page MZ would run for this event right now (1-based, 0 = none) — how you assert an NPC has moved on to its post-quest page. */
  activePage?: { map: number; event: number; page: number };
}

export interface Scenario {
  name?: string;
  steps: ScenarioStep[];
  /** Pre-queued Show Choices answers; `answerChoices` steps append to the same queue. */
  choices?: number[];
  battles?: Array<'win' | 'escape' | 'lose'>;
  maxCommands?: number;
  /** Start from System.json's new-game state (default) or from an empty one. */
  newGame?: boolean;
}

export interface CheckResult {
  what: string;
  ok: boolean;
  expected: unknown;
  actual: unknown;
}

export interface StepResult {
  index: number;
  action: string;
  ok: boolean;
  /** Set when the step threw — a missing event, an unanswerable choice, a runaway loop. */
  error?: string;
  checks?: CheckResult[];
}

export interface ScenarioReport {
  name: string;
  pass: boolean;
  durationMs: number;
  steps: StepResult[];
  /** One line per failed check or thrown step, in order — the short version an agent reads first. */
  failures: string[];
  messages: ShownMessage[];
  choices: ShownChoice[];
  pluginCalls: PluginCall[];
  battles: BattleCall[];
  /** Commands the event layer does not model, with how often they were hit. A green run with entries here proved less than it looks. */
  unmodeled: Array<{ command: string; count: number }>;
  state: Record<string, unknown>;
  coverage: CoverageReport;
}

export function runScenario(session: ProjectSession, scenario: Scenario): ScenarioReport {
  const started = Date.now();
  const state = scenario.newGame === false ? new GameState() : GameState.fromSession(session);
  const interpreter = new Interpreter(session, state, {
    choices: scenario.choices,
    battles: scenario.battles,
    maxCommands: scenario.maxCommands,
  });

  const steps: StepResult[] = [];
  const failures: string[] = [];

  for (const [index, step] of scenario.steps.entries()) {
    if (step.action === 'expect') {
      const checks = check(interpreter, step.expect);
      const ok = checks.every((c) => c.ok);
      steps.push({ index, action: 'expect', ok, checks });
      for (const failed of checks.filter((c) => !c.ok)) {
        failures.push(`step ${index} expect ${failed.what}: expected ${JSON.stringify(failed.expected)}, got ${JSON.stringify(failed.actual)}`);
      }
      continue;
    }

    try {
      apply(interpreter, step);
      steps.push({ index, action: step.action, ok: true });
    } catch (err) {
      // A thrown step leaves the state mid-event, so every later step would be
      // asserting about a game that never got there. Stop, and report the run
      // as far as it got — that trajectory is what a repair loop reads.
      steps.push({ index, action: step.action, ok: false, error: (err as Error).message });
      failures.push(`step ${index} ${step.action}: ${(err as Error).message}`);
      break;
    }
  }

  return {
    name: scenario.name ?? 'scenario',
    pass: failures.length === 0,
    durationMs: Date.now() - started,
    steps,
    failures,
    messages: state.messages,
    choices: state.choices,
    pluginCalls: interpreter.pluginCalls,
    battles: interpreter.battles,
    unmodeled: [...interpreter.unmodeled].map(([command, count]) => ({ command, count })),
    state: state.snapshot(),
    coverage: interpreter.coverage(),
  };
}

function apply(interpreter: Interpreter, step: Exclude<ScenarioStep, { action: 'expect' }>): void {
  const state = interpreter.state;
  switch (step.action) {
    case 'runEvent':
      return interpreter.runEvent(step.map, step.event, step.page);
    case 'runCommonEvent':
      return interpreter.runCommonEvent(step.id);
    case 'setSwitch':
      return void state.switches.set(step.id, step.value);
    case 'setVariable':
      return void state.variables.set(step.id, step.value);
    case 'setSelfSwitch':
      return state.setSelfSwitch(step.map, step.event, step.ch, step.value);
    case 'gainGold':
      return state.gainGold(step.amount);
    case 'gainItem':
      return state.gainItem(step.kind ?? 'item', step.id, step.amount);
    case 'teleport':
      state.player = { ...state.player, mapId: step.map, x: step.x, y: step.y };
      return;
    case 'answerChoices':
      return interpreter.answerChoices(step.choices);
    case 'answerBattles':
      return interpreter.answerBattles(step.outcomes);
  }
}

function check(interpreter: Interpreter, assertion: Assertion): CheckResult[] {
  const state = interpreter.state;
  const results: CheckResult[] = [];
  const add = (what: string, expected: unknown, actual: unknown, ok = deepEqual(expected, actual)) =>
    results.push({ what, ok, expected, actual });

  if (assertion.switch) {
    add(`switch ${assertion.switch.id}`, assertion.switch.value, state.switchValue(assertion.switch.id));
  }
  if (assertion.variable) {
    const { id, value, cmp = 'eq' } = assertion.variable;
    const actual = state.variableValue(id);
    add(`variable ${id} ${cmp}`, value, actual, compare(cmp, actual, value));
  }
  if (assertion.selfSwitch) {
    const { map, event, ch, value } = assertion.selfSwitch;
    add(`self switch ${map},${event},${ch}`, value, state.selfSwitchValue(map, event, ch));
  }
  if (assertion.gold) {
    const { value, cmp = 'eq' } = assertion.gold;
    add(`gold ${cmp}`, value, state.gold, compare(cmp, state.gold, value));
  }
  if (assertion.item) {
    const { kind = 'item', id, count = 1, cmp = 'gte' } = assertion.item;
    const actual = state.itemCount(kind, id);
    add(`${kind} ${id} count ${cmp}`, count, actual, compare(cmp, actual, count));
  }
  if (assertion.partyHas !== undefined) {
    add(`party has actor ${assertion.partyHas}`, true, state.party.includes(assertion.partyHas));
  }
  if (assertion.playerAt) {
    const { map, x, y } = assertion.playerAt;
    const expected = { map, ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) };
    const actual = {
      map: state.player.mapId,
      ...(x !== undefined ? { x: state.player.x } : {}),
      ...(y !== undefined ? { y: state.player.y } : {}),
    };
    add('player position', expected, actual);
  }
  if (assertion.message !== undefined) {
    add(`a message containing ${JSON.stringify(assertion.message)}`, true, hasMessage(state.messages, assertion.message));
  }
  if (assertion.noMessage !== undefined) {
    add(`no message containing ${JSON.stringify(assertion.noMessage)}`, false, hasMessage(state.messages, assertion.noMessage));
  }
  if (assertion.pluginCalled) {
    const { plugin, command } = assertion.pluginCalled;
    const called = interpreter.pluginCalls.some((c) => c.plugin === plugin && c.command === command);
    add(`plugin command ${plugin}:${command}`, true, called);
  }
  if (assertion.activePage) {
    const { map, event, page } = assertion.activePage;
    add(`active page of map ${map} event ${event}`, page, activePage(interpreter, map, event));
  }

  return results;
}

/** 1-based, 0 meaning "no page's conditions are met" — the event is inert. */
function activePage(interpreter: Interpreter, mapId: number, eventId: number): number {
  return interpreter.properPageIndex(mapId, eventId) + 1;
}

function hasMessage(messages: ShownMessage[], needle: string): boolean {
  return messages.some((m) => m.lines.some((line) => line.includes(needle)) || m.speaker.includes(needle));
}

function compare(cmp: Comparison, a: number, b: number): boolean {
  switch (cmp) {
    case 'eq':
      return a === b;
    case 'gte':
      return a >= b;
    case 'lte':
      return a <= b;
    case 'gt':
      return a > b;
    case 'lt':
      return a < b;
    case 'neq':
      return a !== b;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
