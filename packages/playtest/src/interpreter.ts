import type { ProjectSession, MapData, MapEvent, CommonEvent, EventCommand, EventConditions } from '@rmmz-kit/core';
import { mapFileName } from '@rmmz-kit/core';
import { decompile, type Node, type Condition } from '@rmmz-kit/compiler';
import { GameState, type ItemKind } from './state.js';

/**
 * L5, event layer only — the plan's own R2 fallback ("只跑事件層測試、不跑畫面"),
 * taken up front rather than after a 10-week overrun, because the browser route
 * cannot be closed from inside this repo at all: MZ's runtime (rmmz_*.js) ships
 * with the paid editor, and `fixtures/minimal-project` has none of it. See the
 * package README and CLAUDE.md for exactly what that costs.
 *
 * What this is: a port of `Game_Interpreter`'s command semantics over the L2
 * *tree* (`decompile()`), not over the flat list MZ walks. MZ tracks `_indent`
 * and skips branches by scanning forward; the tree already encodes that
 * structure, and M3/M7.5 already got it right in both directions, so branch and
 * loop handling here is plain recursion — no second implementation of indent
 * matching to keep in sync (the same reuse `@rmmz-kit/validate`'s structure
 * rule makes).
 *
 * What this is not: frames, rendering, movement, timing. `Wait` adds to a
 * counter; a Set Movement Route is recorded as unmodeled rather than walked.
 * Assertions are over state, which is the plan's own §4.6 argument — bypass the
 * UI, drive the state machine.
 */

export type Signal = 'next' | 'break' | 'exit';

export interface RunContext {
  mapId: number;
  /** 0 for a common event: MZ's self switches are keyed by map event, and a common event called from one uses the *caller's* key. */
  eventId: number;
  /** Where the tree came from, for coverage and error messages. */
  key: string;
}

export interface PluginCall {
  plugin: string;
  command: string;
  args: Record<string, unknown>;
}

export interface BattleCall {
  troopId: number;
  outcome: 'win' | 'escape' | 'lose';
}

export interface InterpreterOptions {
  /**
   * Answers for Show Choices, consumed in order; an index of -1 takes the
   * cancel branch. When the queue runs dry the choice's own default is taken
   * (MZ's `defaultType`, or the first branch when there is none) and the choice
   * is recorded in `state.choices` either way, so a scenario that answered too
   * few choices can see which one it missed.
   */
  choices?: number[];
  /** Outcomes for Battle Processing, consumed in order; default 'win'. Real damage math is `@rmmz-kit/battlesim`'s job, not this layer's. */
  battles?: Array<'win' | 'escape' | 'lose'>;
  /** Abort guard for an event that loops forever — the softlock this layer *can* catch. */
  maxCommands?: number;
}

export class Interpreter {
  readonly state: GameState;
  /** Commands this layer does not model, deduped; a scenario passing while this is non-empty is a scenario that proved less than it looks. */
  readonly unmodeled = new Map<string, number>();
  /**
   * Caveats about what *did* run, as opposed to `unmodeled`'s list of what did
   * not. A command can be modelled at the event layer and still have a side
   * effect this layer has no way to produce — a won Battle Processing being the
   * one that matters, since MZ pays out gold/EXP/drops there and the outcome
   * here is told, not fought. Deliberately not folded into `unmodeled`: that
   * counter means "the scenario proved less than it looks", and a generated game
   * with one boss fight would trip it every time and teach a reader to ignore it.
   */
  readonly notes = new Set<string>();
  readonly pluginCalls: PluginCall[] = [];
  readonly battles: BattleCall[] = [];

  private readonly lists = new Map<string, Node[]>();
  private readonly visited = new Set<Node>();
  private readonly choiceQueue: number[];
  private readonly battleQueue: Array<'win' | 'escape' | 'lose'>;
  private budget: number;

  constructor(
    private readonly session: ProjectSession,
    state?: GameState,
    options: InterpreterOptions = {}
  ) {
    this.state = state ?? GameState.fromSession(session);
    this.choiceQueue = [...(options.choices ?? [])];
    this.battleQueue = [...(options.battles ?? [])];
    this.budget = options.maxCommands ?? 100_000;
  }

  /** Enqueue more Show Choices answers mid-scenario. */
  answerChoices(indices: number[]): void {
    this.choiceQueue.push(...indices);
  }

  answerBattles(outcomes: Array<'win' | 'escape' | 'lose'>): void {
    this.battleQueue.push(...outcomes);
  }

  /**
   * Run one map event's page to completion. `page` is 1-based; omitted, MZ's
   * own rule picks it — `Game_Event.findProperPageIndex` scans pages *last to
   * first* and takes the first whose conditions hold, which is the ordering
   * `@rmmz-kit/validate`'s dead-page rule is built on too.
   */
  runEvent(mapId: number, eventId: number, page?: number): void {
    const event = this.mapEvent(mapId, eventId);
    const index = page !== undefined ? page - 1 : this.properPageIndex(mapId, eventId);
    if (index < 0) throw new Error(`Map ${mapId} event ${eventId} has no page whose conditions are met`);
    const chosen = event.pages[index];
    if (!chosen) throw new Error(`Map ${mapId} event ${eventId} has no page ${index + 1}`);

    const key = `${mapFileName(mapId)}#event ${eventId} page ${index + 1}`;
    this.exec(this.treeFor(key, chosen.list), { mapId, eventId, key });
  }

  runCommonEvent(id: number, caller?: { mapId: number; eventId: number }): void {
    if (!this.session.listFiles().includes('CommonEvents.json')) {
      throw new Error(`This project has no CommonEvents.json, so common event ${id} cannot run`);
    }
    const events = this.session.readFile<Array<CommonEvent | null>>('CommonEvents.json');
    const event = events.find((e) => e?.id === id);
    if (!event) throw new Error(`Common event ${id} does not exist`);
    const key = `CommonEvents.json#common event ${id}`;
    this.exec(this.treeFor(key, event.list), {
      mapId: caller?.mapId ?? this.state.player.mapId,
      eventId: caller?.eventId ?? 0,
      key,
    });
  }

  mapEvent(mapId: number, eventId: number): MapEvent {
    const map = this.session.readFile<MapData>(mapFileName(mapId));
    const event = map.events.find((e) => e?.id === eventId);
    if (!event) throw new Error(`Map ${mapId} has no event ${eventId}`);
    return event;
  }

  /** Which page index MZ would run right now (0-based), or -1 for none. */
  properPageIndex(mapId: number, eventId: number): number {
    const pages = this.mapEvent(mapId, eventId).pages;
    for (let i = pages.length - 1; i >= 0; i--) {
      if (this.meetsConditions(pages[i].conditions, mapId, eventId)) return i;
    }
    return -1;
  }

  meetsConditions(c: EventConditions, mapId: number, eventId: number): boolean {
    const s = this.state;
    if (c.switch1Valid && !s.switchValue(c.switch1Id)) return false;
    if (c.switch2Valid && !s.switchValue(c.switch2Id)) return false;
    if (c.variableValid && s.variableValue(c.variableId) < c.variableValue) return false;
    if (c.selfSwitchValid && !s.selfSwitchValue(mapId, eventId, c.selfSwitchCh)) return false;
    if (c.itemValid && s.itemCount('item', c.itemId) === 0) return false;
    if (c.actorValid && !s.party.includes(c.actorId)) return false;
    return true;
  }

  /** Decompiled once and cached, so node identity is stable and coverage can be a Set of nodes rather than an index scheme. */
  private treeFor(key: string, list: EventCommand[]): Node[] {
    const cached = this.lists.get(key);
    if (cached) return cached;
    let tree: Node[];
    try {
      tree = decompile(list);
    } catch (err) {
      // decompile() is the structure check (the same one @rmmz-kit/validate
      // reuses), so its message is the diagnosis — it just doesn't know which
      // list it was handed.
      throw new Error(`${key} does not decompile: ${(err as Error).message}`);
    }
    this.lists.set(key, tree);
    return tree;
  }

  private exec(nodes: Node[], ctx: RunContext): Signal {
    for (const node of nodes) {
      // Post-decrement: `maxCommands: N` must allow N commands to run, not N-1.
      if (this.budget-- <= 0) {
        throw new Error(
          `Command budget exhausted in ${ctx.key} — an event loop with no reachable Break Loop or Exit Event Processing?`
        );
      }
      this.visited.add(node);
      const signal = this.execOne(node, ctx);
      if (signal !== 'next') return signal;
    }
    return 'next';
  }

  private execOne(node: Node, ctx: RunContext): Signal {
    const s = this.state;
    switch (node.kind) {
      case 'text':
        s.messages.push({ speaker: node.speakerName ?? '', face: node.face, lines: [...node.lines] });
        return 'next';

      case 'comment':
        return 'next';

      case 'if': {
        const taken = this.evalCondition(node.condition, ctx);
        return this.exec(taken ? node.then : (node.else ?? []), ctx);
      }

      case 'choice': {
        const queued = this.choiceQueue.shift();
        const fallback = node.defaultType >= 0 && node.defaultType < node.choices.length ? node.defaultType : 0;
        const chosen = queued ?? fallback;
        s.choices.push({ choices: [...node.choices], chosen });
        if (chosen === -1) {
          // MZ's `cancelType`: -1 disallows cancel entirely, -2 routes to the
          // 403 "When Cancel" body, and >= 0 makes cancel behave as choosing
          // that index — with `setupChoices` normalizing anything >= the choice
          // count to -2, which is what the editor writes for "Branch". Ignoring
          // all of that made a -1 answer run *nothing* whenever the choice had
          // no 403 body: a scenario that silently proved nothing.
          const cancelType = node.cancelType >= node.choices.length ? -2 : node.cancelType;
          if (cancelType === -1) {
            throw new Error(`Choice in ${ctx.key} does not allow cancel (cancelType -1), so -1 is not an answer to it`);
          }
          if (cancelType >= 0) return this.exec(node.branches[cancelType] ?? [], ctx);
          return this.exec(node.cancelBranch ?? [], ctx);
        }
        const branch = node.branches[chosen];
        if (!branch) throw new Error(`Choice answer ${chosen} is out of range in ${ctx.key} (${node.choices.length} choices)`);
        return this.exec(branch, ctx);
      }

      case 'loop':
        for (;;) {
          const signal = this.exec(node.body, ctx);
          if (signal === 'break') return 'next';
          if (signal === 'exit') return 'exit';
          if (--this.budget <= 0) throw new Error(`Command budget exhausted in ${ctx.key} — a Loop with no reachable Break Loop?`);
        }

      case 'setSwitch':
        for (let id = node.from; id <= node.to; id++) s.switches.set(id, node.value);
        return 'next';

      case 'setVariable': {
        for (let id = node.from; id <= node.to; id++) {
          s.variables.set(id, applyVariableOp(node.op, s.variableValue(id), node.value));
        }
        return 'next';
      }

      case 'setSelfSwitch':
        // MZ keys self switches by the *running* event, which is why a common
        // event called from an event can flip that event's switch.
        s.setSelfSwitch(ctx.mapId, ctx.eventId, node.ch, node.value);
        return 'next';

      case 'callCommonEvent':
        this.runCommonEvent(node.commonEventId, { mapId: ctx.mapId, eventId: ctx.eventId });
        return 'next';

      case 'transfer':
        s.player = { mapId: node.mapId, x: node.x, y: node.y, direction: node.direction || s.player.direction };
        return 'next';

      case 'wait':
        s.frames += node.frames;
        return 'next';

      case 'exitEvent':
        return 'exit';

      case 'breakLoop':
        return 'break';

      case 'gainGold':
        s.gainGold(this.operand(node.operandType, node.value) * (node.operation === 0 ? 1 : -1));
        return 'next';

      case 'gainItem':
        this.gain('item', node.itemId, node.operation, this.operand(node.operandType, node.value));
        return 'next';

      case 'gainWeapon':
        this.gain('weapon', node.weaponId, node.operation, this.operand(node.operandType, node.value));
        return 'next';

      case 'gainArmor':
        this.gain('armor', node.armorId, node.operation, this.operand(node.operandType, node.value));
        return 'next';

      case 'changeParty':
        if (node.operation === 0) {
          if (!s.party.includes(node.actorId)) s.party.push(node.actorId);
        } else {
          s.party = s.party.filter((id) => id !== node.actorId);
        }
        return 'next';

      case 'battle': {
        const outcome = this.battleQueue.shift() ?? 'win';
        this.battles.push({ troopId: node.troopId, outcome });
        // A won battle in MZ pays out gold, EXP, drops and possibly a level-up
        // before the 601 body runs. None of that happens here — the outcome is
        // *told* to this layer, not fought — so a scenario asserting "the player
        // can afford the sword after the fight" is asserting about a party that
        // was never paid.
        if (outcome === 'win') {
          this.notes.add('Battle rewards (gold, EXP, drops, level-up) are not modelled — the outcome is answered, not fought.');
        }
        if (node.designation !== 0) this.note('Battle Processing with a variable/random troop (301)');
        const branch = outcome === 'win' ? node.win : outcome === 'escape' ? node.escape : node.lose;
        // An absent branch means MZ wrote no 60x for it — usually because
        // canEscape/canLose is false, i.e. the queue asked for an outcome this
        // battle cannot have. Running nothing is the only honest answer, but it
        // has to be counted, or the scenario reads as green with a whole
        // requested outcome silently unproven.
        if (!branch) this.note(`Battle Processing outcome '${outcome}' with no such branch (301)`);
        return this.exec(branch ?? [], ctx);
      }

      case 'pluginCommand':
        // Not executed — the plugin's JS is not loaded here — but recorded, so
        // a scenario can still assert "the quest handed out its reward through
        // plugin X", which is how a real project's rewards usually happen.
        this.pluginCalls.push({ plugin: node.plugin, command: node.command, args: { ...node.args } });
        return 'next';

      case 'jump':
      case 'label':
        this.note('Label / Jump to Label (118/119)');
        return 'next';

      case 'script':
        this.note('Script (355)');
        return 'next';

      case 'moveRoute':
        this.note('Set Movement Route (205)');
        return 'next';

      case 'shop':
        this.note('Shop Processing (302)');
        return 'next';

      case 'raw':
        this.note(`command ${node.code}`);
        // A Tier 3 branch command carries its body; running it is closer to the
        // truth than dropping it (an If Vehicle body is usually the main path).
        return node.body ? this.exec(node.body, ctx) : 'next';

      // Presentation only. Skipping these is not a gap worth reporting on every run.
      case 'playSe':
      case 'playBgm':
      case 'fadeOutBgm':
      case 'showAnimation':
      case 'balloon':
      case 'fadeOut':
      case 'fadeIn':
        return 'next';

      default:
        // What is left is battler state (HP/MP/states/exp/level/params/skills),
        // which `@rmmz-kit/battlesim` models properly and this layer does not
        // model at all — noted rather than half-applied.
        this.note(`${node.kind} (battler state, not modeled at the event layer)`);
        return 'next';
    }
  }

  private gain(kind: ItemKind, id: number, operation: number, amount: number): void {
    this.state.gainItem(kind, id, operation === 0 ? amount : -amount);
  }

  /** MZ's `operandType`: 0 = the constant, 1 = the value of that variable. */
  private operand(operandType: number, value: number): number {
    return operandType === 0 ? value : this.state.variableValue(value);
  }

  private note(what: string): void {
    this.unmodeled.set(what, (this.unmodeled.get(what) ?? 0) + 1);
  }

  private evalCondition(condition: Condition, ctx: RunContext): boolean {
    const s = this.state;
    switch (condition.type) {
      case 'switch':
        return s.switchValue(condition.switchId) === condition.value;
      case 'variable':
        return compare(condition.cmp, s.variableValue(condition.variableId), condition.value);
      case 'script':
        // Deliberately not `eval`'d: unlike a damage formula (battlesim runs
        // those in a locked-down vm because MZ's data *is* formulas), a
        // condition script reads engine objects this layer does not have, so
        // any result would be fiction. False is the deterministic answer, and
        // the note says the branch was never proven.
        this.note('Conditional Branch with a script condition (111 type 12)');
        return false;
      case 'raw':
        return this.evalRawCondition(condition.parameters, ctx);
    }
  }

  /**
   * The 111 condition types the L2 IR leaves raw but a quest chain routinely
   * uses. Parameter layout is `Game_Interpreter.command111`'s; anything else
   * (timer, actor/enemy/character state, button, vehicle) is noted and answered
   * false rather than guessed at.
   */
  private evalRawCondition(parameters: unknown[], ctx: RunContext): boolean {
    const s = this.state;
    const type = parameters[0] as number;
    switch (type) {
      case 2:
        return s.selfSwitchValue(ctx.mapId, ctx.eventId, parameters[1] as string) === (parameters[2] === 0);
      case 7: {
        // [7, value, type] with 0 = gold >=, 1 = gold <=, 2 = gold <.
        const value = parameters[1] as number;
        const mode = parameters[2] as number;
        return mode === 0 ? s.gold >= value : mode === 1 ? s.gold <= value : s.gold < value;
      }
      case 8:
        return s.itemCount('item', parameters[1] as number) > 0;
      case 9:
        return s.itemCount('weapon', parameters[1] as number) > 0;
      case 10:
        return s.itemCount('armor', parameters[1] as number) > 0;
      default:
        this.note(`Conditional Branch condition type ${type} (111)`);
        return false;
    }
  }

  /**
   * Event/dialogue node coverage (plan §3 M8's `__AT.coverage()`), over every
   * command list in the project — not only the ones a scenario touched, since
   * "which quests has nobody tested" is the question worth asking. A list that
   * fails to decompile is reported rather than counted: that is a structural
   * bug `validate` reports properly, and silently scoring it 0% would hide it.
   */
  coverage(): CoverageReport {
    const lists: CoverageEntry[] = [];
    const unparsed: string[] = [];

    for (const file of this.session.listFiles()) {
      const mapMatch = /^Map(\d+)\.json$/.exec(file);
      if (mapMatch) {
        const map = this.session.readFile<MapData>(file);
        for (const event of map.events) {
          if (!event) continue;
          event.pages.forEach((page, i) => {
            this.tally(`${file}#event ${event.id} page ${i + 1}`, page.list, lists, unparsed);
          });
        }
      } else if (file === 'CommonEvents.json') {
        for (const event of this.session.readFile<Array<CommonEvent | null>>(file)) {
          if (event) this.tally(`${file}#common event ${event.id}`, event.list, lists, unparsed);
        }
      }
    }

    const total = sum(lists, (l) => l.nodes);
    const visited = sum(lists, (l) => l.visited);
    const messages = sum(lists, (l) => l.messages);
    const messagesVisited = sum(lists, (l) => l.messagesVisited);
    return {
      lists,
      unparsed,
      nodes: total,
      visited,
      percent: total === 0 ? 100 : Math.round((visited / total) * 1000) / 10,
      messages,
      messagesVisited,
      messagePercent: messages === 0 ? 100 : Math.round((messagesVisited / messages) * 1000) / 10,
    };
  }

  private tally(key: string, list: CommonEvent['list'], out: CoverageEntry[], unparsed: string[]): void {
    let tree: Node[];
    try {
      tree = this.treeFor(key, list);
    } catch {
      unparsed.push(key);
      return;
    }
    const entry: CoverageEntry = { key, nodes: 0, visited: 0, messages: 0, messagesVisited: 0 };
    walk(tree, (node) => {
      const seen = this.visited.has(node);
      entry.nodes++;
      if (seen) entry.visited++;
      if (node.kind === 'text') {
        entry.messages++;
        if (seen) entry.messagesVisited++;
      }
    });
    // An empty page is 100% covered by definition; keeping it in the list at
    // 0/0 would drag the project percentage down for pages with nothing to run.
    if (entry.nodes > 0) out.push(entry);
  }
}

export interface CoverageEntry {
  key: string;
  nodes: number;
  visited: number;
  messages: number;
  messagesVisited: number;
}

export interface CoverageReport {
  lists: CoverageEntry[];
  /** Lists `decompile()` refused — a structural bug, see `@rmmz-kit/validate`'s structure rule. */
  unparsed: string[];
  nodes: number;
  visited: number;
  percent: number;
  messages: number;
  messagesVisited: number;
  messagePercent: number;
}

function walk(nodes: Node[], fn: (node: Node) => void): void {
  for (const node of nodes) {
    fn(node);
    switch (node.kind) {
      case 'if':
        walk(node.then, fn);
        walk(node.else ?? [], fn);
        break;
      case 'choice':
        node.branches.forEach((b) => walk(b, fn));
        walk(node.cancelBranch ?? [], fn);
        break;
      case 'loop':
        walk(node.body, fn);
        break;
      case 'battle':
        walk(node.win ?? [], fn);
        walk(node.escape ?? [], fn);
        walk(node.lose ?? [], fn);
        break;
      case 'raw':
        walk(node.body ?? [], fn);
        break;
      default:
        break;
    }
  }
}

function applyVariableOp(op: 'set' | 'add' | 'sub' | 'mul' | 'div' | 'mod', current: number, value: number): number {
  switch (op) {
    case 'set':
      return value;
    case 'add':
      return current + value;
    case 'sub':
      return current - value;
    case 'mul':
      return current * value;
    // MZ's `Game_Variables.setValue` floors, and `operateValue` divides by zero
    // into Infinity/NaN; `Game_Interpreter` guards neither, so neither do we —
    // except for the floor, which every MZ variable write does.
    case 'div':
      return Math.floor(current / value);
    case 'mod':
      return current % value;
  }
}

function compare(cmp: 'eq' | 'gte' | 'lte' | 'gt' | 'lt' | 'neq', a: number, b: number): boolean {
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

function sum<T>(items: T[], of: (item: T) => number): number {
  return items.reduce((acc, item) => acc + of(item), 0);
}
