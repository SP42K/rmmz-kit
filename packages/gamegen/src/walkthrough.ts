import type { Assertion, Scenario, ScenarioStep } from '@rmmz-kit/playtest';
import type { BuiltPortal, BuiltQuest, GameBuild } from './build.js';

/**
 * The walkthrough — M10's acceptance criterion, turned into something a machine
 * can answer.
 *
 * §3 M10 asks for「連續 10 次生成，≥ 6 次可完整通關且不卡關」. "Completable"
 * and "not stuck" are only checkable if something actually plays the game, and
 * M8 already built the thing that can: `run_scenario`. So every build emits its
 * own regression suite, derived from the *spec* rather than from the events
 * that were emitted — which is the whole point. A walkthrough read back out of
 * the generated data would agree with it by construction and prove nothing; one
 * derived from the intent fails when the build doesn't realise the intent.
 *
 * What that does **not** cover is whether the game is any good, or whether the
 * spec was a sensible reading of the user's sentence. Those are the model's
 * half of the milestone; see CLAUDE.md's acceptance note.
 *
 * Two scenarios, because "completable" and "not stuck" are different claims:
 *
 * - `walkthrough` plays the game start to finish and asserts the clear switch
 *   comes on. That is 可完整通關.
 * - `gates` asserts every lock is still locked at the start — the finale
 *   refuses, a quest with prerequisites refuses, and no objective event can be
 *   used before its quest is running. That is 不卡關's other half: a chain that
 *   can be short-circuited isn't a chain, and one whose gate never opens is the
 *   softlock itself.
 */
export function walkthroughScenarios(build: GameBuild): Scenario[] {
  const scenarios = [walkthrough(build)];
  const gate = gates(build);
  if (gate.steps.length > 0) scenarios.push(gate);
  return scenarios;
}

/** Item counts the player is expected to be carrying, so every assertion is exact rather than "at least". */
class Ledger {
  private readonly items = new Map<number, number>();
  gold = 0;

  give(itemId: number, count: number): void {
    this.items.set(itemId, (this.items.get(itemId) ?? 0) + count);
  }

  take(itemId: number, count: number): void {
    this.give(itemId, -count);
  }

  count(itemId: number): number {
    return this.items.get(itemId) ?? 0;
  }
}

function walkthrough(build: GameBuild): Scenario {
  const steps: ScenarioStep[] = [];
  const ledger = new Ledger();
  const travel = travelPlanner(build);
  /** Quests turned in so far, so the run knows which of a shared giver's other quests are unlocked. */
  const completed = new Set<string>();

  // The game starts where System.json says it does. Asserted first because
  // every later `playerAt` is relative to it, and because a build that forgot
  // to write the start position boots the player into map 1 — which after this
  // build is somebody else's map.
  steps.push({ action: 'expect', expect: { playerAt: { map: build.startMapId, x: build.start.x, y: build.start.y } } });

  for (const quest of build.quests) {
    steps.push(...travel.to(quest.giver.area));
    steps.push({ action: 'clearMessages' });
    // Queued before the run, not after: the choice is answered while the event
    // is executing, so an answer pushed afterwards arrives too late.
    steps.push({ action: 'answerChoices', choices: [0] });
    steps.push({ action: 'runEvent', map: quest.giver.mapId, event: quest.giver.eventId });
    steps.push(expect({ message: quest.lines.accept, switch: { id: quest.switches.started, value: true } }));

    // Talking to the giver again with the objective outstanding must remind,
    // not reward. Without this a build that gates the turn-in on nothing at all
    // still passes the walkthrough — the player would just never notice.
    steps.push({ action: 'clearMessages' });
    steps.push({ action: 'runEvent', map: quest.giver.mapId, event: quest.giver.eventId });
    steps.push(expect({ message: quest.lines.remind, switch: { id: quest.switches.done, value: false } }));

    steps.push(...travel.to(quest.objective.area));
    steps.push({ action: 'clearMessages' });
    if (quest.objective.kind === 'defeat') steps.push({ action: 'answerBattles', outcomes: ['win'] });
    steps.push({ action: 'runEvent', map: quest.objective.mapId, event: quest.objective.eventId });

    const after: Assertion = { message: quest.lines.objective };
    if (quest.objective.kind === 'fetch') {
      ledger.give(quest.objective.itemId!, quest.objective.count ?? 1);
      after.item = { id: quest.objective.itemId!, count: ledger.count(quest.objective.itemId!), cmp: 'eq' };
    } else {
      after.switch = { id: quest.switches.objective!, value: true };
    }
    steps.push(expect(after));

    // ...and it must be spent. An objective event that still works the second
    // time is an infinite item tap (or a boss that respawns), which is the same
    // bug in two costumes and is invisible to a run that only visits it once.
    steps.push({ action: 'clearMessages' });
    steps.push({ action: 'runEvent', map: quest.objective.mapId, event: quest.objective.eventId });
    steps.push(
      expect({
        message: quest.lines.objectiveSpent,
        activePage: { map: quest.objective.mapId, event: quest.objective.eventId, page: 2 },
        ...(quest.objective.kind === 'fetch'
          ? { item: { id: quest.objective.itemId!, count: ledger.count(quest.objective.itemId!), cmp: 'eq' as const } }
          : {}),
      })
    );

    steps.push(...travel.to(quest.giver.area));
    steps.push({ action: 'clearMessages' });
    steps.push({ action: 'runEvent', map: quest.giver.mapId, event: quest.giver.eventId });
    steps.push(expect(turnInAssertion(quest, ledger)));

    // The giver has to move on too: the "thanks, that's behind us" line, not
    // "would you fetch me a herb?" forever. Asserted here rather than at the end
    // of the run because the player is already standing there — no extra travel
    // to prove it. The gold assertion is what catches a turn-in that pays twice.
    //
    // An NPC with another quest in them offers it in the same breath, so the
    // choice has to be answered — and answered "not now", because accepting it
    // here would start a quest this run has not travelled to yet. That the offer
    // arrives at all is the assertion that the two quests really are one NPC.
    // Only when that next quest is actually unlocked: otherwise the NPC says why
    // it is locked, asks nothing, and a queued answer would be left in the queue
    // for whichever event asks the next question.
    completed.add(quest.key);
    const next = build.quests.find(
      (q) =>
        q.giver.mapId === quest.giver.mapId &&
        q.giver.eventId === quest.giver.eventId &&
        q.giver.order === quest.giver.order + 1
    );
    const offersNext = next !== undefined && next.requires.every((key) => completed.has(key));
    steps.push({ action: 'clearMessages' });
    if (offersNext) steps.push({ action: 'answerChoices', choices: [1] });
    steps.push({ action: 'runEvent', map: quest.giver.mapId, event: quest.giver.eventId });
    steps.push(
      expect({
        message: quest.lines.done,
        noMessage: quest.lines.offer,
        gold: { value: ledger.gold, cmp: 'eq' },
        ...(offersNext ? { switch: { id: next!.switches.started, value: false } } : {}),
      })
    );
    if (offersNext) steps.push(expect({ message: next!.lines.offer }));
  }

  steps.push(...travel.to(build.finale.area));
  steps.push({ action: 'clearMessages' });
  steps.push({ action: 'answerBattles', outcomes: ['win'] });
  steps.push({ action: 'runEvent', map: build.finale.mapId, event: build.finale.eventId });
  steps.push(expect({ message: build.finale.lines.victory, switch: { id: build.finale.clearSwitch, value: true } }));

  // And the boss stays beaten.
  steps.push({ action: 'clearMessages' });
  steps.push({ action: 'runEvent', map: build.finale.mapId, event: build.finale.eventId });
  steps.push(expect({ message: build.finale.lines.after, noMessage: build.finale.lines.intro }));

  return { name: 'walkthrough', steps };
}

/**
 * The turn-in, asserted against a running ledger rather than against ">= 1":
 * a build that pays the reward twice, or forgets to take the quest item back,
 * is exactly the kind of bug that a `gte` assertion is blind to.
 */
function turnInAssertion(quest: BuiltQuest, ledger: Ledger): Assertion {
  const assertion: Assertion = {
    message: quest.lines.complete,
    switch: { id: quest.switches.done, value: true },
  };

  if (quest.objective.kind === 'fetch') ledger.take(quest.objective.itemId!, quest.objective.count ?? 1);
  if (quest.reward?.gold) ledger.gold += quest.reward.gold;
  if (quest.reward?.itemId) ledger.give(quest.reward.itemId, quest.reward.itemCount ?? 1);

  assertion.gold = { value: ledger.gold, cmp: 'eq' };
  // The reward item wins when both name the same id: one assertion per key, and
  // the ledger has already netted the two movements against each other.
  const tracked = quest.reward?.itemId ?? (quest.objective.kind === 'fetch' ? quest.objective.itemId : undefined);
  if (tracked !== undefined) assertion.item = { id: tracked, count: ledger.count(tracked), cmp: 'eq' };
  return assertion;
}

function gates(build: GameBuild): Scenario {
  const steps: ScenarioStep[] = [];

  // No travel here on purpose: `runEvent` doesn't care where the player is
  // standing, and this scenario is about the locks, not the walking. The
  // walkthrough is what proves the portals work.
  if (build.finale.requires.length > 0) {
    steps.push({ action: 'clearMessages' });
    steps.push({ action: 'runEvent', map: build.finale.mapId, event: build.finale.eventId });
    steps.push(
      expect({
        message: build.finale.lines.locked,
        noMessage: build.finale.lines.intro,
        switch: { id: build.finale.clearSwitch, value: false },
      })
    );
  }

  for (const quest of build.quests) {
    // 0 = "no page's conditions are met", i.e. the objective is inert until the
    // quest that wants it is running. A herb patch you can strip before anyone
    // asks you to lets the player finish the quest chain out of order.
    steps.push(
      expect({ activePage: { map: quest.objective.mapId, event: quest.objective.eventId, page: 0 } })
    );

    if (quest.requires.length === 0) continue;
    steps.push({ action: 'clearMessages' });
    steps.push({ action: 'runEvent', map: quest.giver.mapId, event: quest.giver.eventId });
    steps.push(
      expect({
        // Only the NPC's *first* quest gets as far as saying why it is locked:
        // an NPC with two quests talks about the earlier one until it is done,
        // so for the rest the claim worth asserting is that it is not on offer.
        ...(quest.giver.order === 0 ? { message: quest.lines.locked } : {}),
        noMessage: quest.lines.offer,
        switch: { id: quest.switches.started, value: false },
      })
    );
  }

  return { name: 'gates', steps };
}

function expect(assertion: Assertion): ScenarioStep {
  return { action: 'expect', expect: assertion };
}

/**
 * Walks the player between areas through the generated portals, remembering
 * where they are so a two-hop journey emits two hops. BFS, because the portal
 * graph is whatever the spec's `connects` made it and the shortest route is the
 * one a player would take.
 */
function travelPlanner(build: GameBuild): { to(area: string): ScenarioStep[] } {
  const outgoing = new Map<string, BuiltPortal[]>(build.areas.map((a) => [a.key, []]));
  for (const portal of build.portals) outgoing.get(portal.from)?.push(portal);

  let at = build.areas[0].key;

  return {
    to(area: string): ScenarioStep[] {
      if (area === at) return [];
      const route = shortestRoute(outgoing, at, area);
      // `checkSpec` has already refused any spec whose areas aren't all
      // connected, so this is an internal invariant, not user input: a missing
      // route means the build dropped a portal. Emitting a walkthrough that
      // quietly teleports past the gap would hide exactly the bug worth seeing.
      if (!route) throw new Error(`Generated no route from area "${at}" to "${area}" — the build is missing a portal.`);
      at = area;
      return route.flatMap((portal) => [
        { action: 'runEvent', map: portal.mapId, event: portal.eventId },
        expect({ playerAt: { map: portal.target.mapId, x: portal.target.x, y: portal.target.y } }),
      ]);
    },
  };
}

function shortestRoute(outgoing: Map<string, BuiltPortal[]>, from: string, to: string): BuiltPortal[] | null {
  const previous = new Map<string, BuiltPortal>();
  const seen = new Set([from]);
  const queue = [from];

  while (queue.length > 0) {
    const here = queue.shift()!;
    if (here === to) break;
    for (const portal of outgoing.get(here) ?? []) {
      if (seen.has(portal.to)) continue;
      seen.add(portal.to);
      previous.set(portal.to, portal);
      queue.push(portal.to);
    }
  }

  if (!seen.has(to)) return null;
  const route: BuiltPortal[] = [];
  for (let key = to; key !== from; ) {
    const portal = previous.get(key);
    if (!portal) return null;
    route.unshift(portal);
    key = portal.from;
  }
  return route;
}
