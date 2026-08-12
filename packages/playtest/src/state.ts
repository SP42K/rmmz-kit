import type { ProjectSession, SystemData } from '@rmmz-kit/core';

/**
 * The slice of MZ's game state the event layer actually reads and writes
 * (plan §3 M8's `__AT.dumpState()`, minus everything only a rendered frame
 * has). Switches, variables, self switches, party inventory and the player's
 * position are what event commands branch on; HP/MP/states are battle state
 * and belong to `@rmmz-kit/battlesim`, which already models them properly.
 *
 * Everything is a plain Map so `snapshot()` is a cheap, ordered, JSON-safe
 * object — a report an agent can diff between two runs is the whole point.
 */

export interface PlayerState {
  mapId: number;
  x: number;
  y: number;
  direction: number;
}

export interface ShownMessage {
  /** MZ's 5th Show Text parameter; '' when the project is MV-shaped. */
  speaker: string;
  face: string;
  lines: string[];
}

export interface ShownChoice {
  choices: string[];
  /** Index taken, or -1 for the cancel branch. */
  chosen: number;
}

/** `item`/`weapon`/`armor` are three separate id spaces in MZ; one map with a prefixed key keeps them apart without three fields. */
export type ItemKind = 'item' | 'weapon' | 'armor';

export class GameState {
  switches = new Map<number, boolean>();
  variables = new Map<number, number>();
  /** Keyed `mapId,eventId,ch` — the same key `$gameSelfSwitches` uses. */
  selfSwitches = new Map<string, boolean>();
  gold = 0;
  inventory = new Map<string, number>();
  party: number[] = [];
  player: PlayerState = { mapId: 1, x: 0, y: 0, direction: 2 };
  messages: ShownMessage[] = [];
  choices: ShownChoice[] = [];
  /** Wait (230) and friends, accumulated. There is no frame loop here — see interpreter.ts's header. */
  frames = 0;

  /** Starting party and position as System.json defines them, i.e. what a new game would have. */
  static fromSession(session: ProjectSession): GameState {
    const state = new GameState();
    const system = session.readFile<SystemData>('System.json');
    state.party = [...(system.partyMembers ?? [])];
    state.player = { mapId: system.startMapId ?? 1, x: system.startX ?? 0, y: system.startY ?? 0, direction: 2 };
    return state;
  }

  switchValue(id: number): boolean {
    return this.switches.get(id) ?? false;
  }

  variableValue(id: number): number {
    return this.variables.get(id) ?? 0;
  }

  selfSwitchValue(mapId: number, eventId: number, ch: string): boolean {
    return this.selfSwitches.get(`${mapId},${eventId},${ch}`) ?? false;
  }

  setSelfSwitch(mapId: number, eventId: number, ch: string, value: boolean): void {
    this.selfSwitches.set(`${mapId},${eventId},${ch}`, value);
  }

  itemCount(kind: ItemKind, id: number): number {
    return this.inventory.get(`${kind}:${id}`) ?? 0;
  }

  gainItem(kind: ItemKind, id: number, amount: number): void {
    // `Game_Party.gainItem` clamps at 0 and at maxItems (99 by default).
    this.inventory.set(`${kind}:${id}`, Math.max(0, Math.min(99, this.itemCount(kind, id) + amount)));
  }

  gainGold(amount: number): void {
    this.gold = Math.max(0, Math.min(99999999, this.gold + amount));
  }

  snapshot(): Record<string, unknown> {
    return {
      switches: sortedEntries(this.switches),
      variables: sortedEntries(this.variables),
      selfSwitches: sortedEntries(this.selfSwitches),
      gold: this.gold,
      inventory: sortedEntries(this.inventory),
      party: [...this.party],
      player: { ...this.player },
      frames: this.frames,
    };
  }
}

/** Sorted so two snapshots of the same state stringify identically — an agent diffing runs needs that, insertion order does not. */
function sortedEntries<K extends string | number, V>(map: Map<K, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const key of [...map.keys()].sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }))) {
    out[String(key)] = map.get(key)!;
  }
  return out;
}
