import { access } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openProject, mapFileName, type MapData, type ProjectSession } from '@rmmz-kit/core';
import { runScenario } from '@rmmz-kit/playtest';
import { generateGame } from '../src/generate.js';
import { buildGame } from '../src/build.js';
import type { GameSpec } from '../src/spec.js';
import { makeTestProject } from './testProject.js';

/**
 * M10's acceptance (plan §3 M10):「連續 10 次生成，≥ 6 次可完整通關且不卡關」.
 *
 * The half that is measurable from inside this repo is measured here, and it is
 * measured at 10/10 rather than 6/10, because the generator under test is
 * deterministic — the plan's 6/10 budgets for a *model* writing the spec, and
 * there is no model in this process. See CLAUDE.md's acceptance note for what
 * that leaves open.
 */

/** The plan's own kind of one-sentence brief: "a village being shaken down by bandits". */
const BANDITS: GameSpec = {
  title: 'The Bandits of Ash Hollow',
  seed: 1,
  party: [1, 2],
  areas: [
    { key: 'village', name: 'Ash Hollow' },
    { key: 'forest', name: 'Whispering Wood', connects: ['village'] },
    { key: 'hideout', name: 'Bandit Hideout', connects: ['forest'] },
  ],
  quests: [
    {
      key: 'herb',
      title: 'Medicine for the Wounded',
      giver: { area: 'village', name: 'Herbalist' },
      objective: { kind: 'fetch', area: 'forest', name: 'Herb Patch', item: { name: 'Bitterleaf' }, count: 2 },
      reward: { gold: 100 },
    },
    {
      key: 'scout',
      title: "The Scout's Report",
      giver: { area: 'village', name: 'Militia Captain' },
      objective: { kind: 'talk', area: 'forest', name: 'Wounded Scout' },
      requires: ['herb'],
      reward: { gold: 50 },
    },
    {
      key: 'wolves',
      title: 'Wolves at the Gate',
      giver: { area: 'village', name: 'Militia Captain' },
      objective: { kind: 'defeat', area: 'forest', name: 'Wolf Pack', troop: { enemyId: 1, count: 2 } },
      requires: ['scout'],
    },
  ],
  finale: { area: 'hideout', name: 'Bandit Chief', troop: { enemyId: 1, count: 3 } },
};

describe('generateGame', () => {
  let project: { dir: string; cleanup: () => Promise<void> };

  beforeAll(async () => {
    project = await makeTestProject();
  });
  afterAll(async () => project.cleanup());

  /** Every case opens the fixture fresh and never commits, so they don't see each other's writes. */
  const open = (): Promise<ProjectSession> => openProject(project.dir);

  it('builds a three-area quest chain and plays it through to the clear switch', async () => {
    const session = await open();
    const report = await generateGame(session, BANDITS);

    expect(report.issues).toEqual([]);
    expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(report.summary).toMatch(/completable end to end/);
    expect(report.ok).toBe(true);

    const [walkthrough, gates] = report.scenarios;
    expect(walkthrough.failures).toEqual([]);
    expect(gates.failures).toEqual([]);
    // A green run with unmodeled commands in it proved less than it looks
    // (M8's own warning), so the generator must stay inside the event layer.
    expect(walkthrough.unmodeled).toEqual([]);

    // Three areas, and the walkthrough actually walked between them.
    expect(report.build!.areas).toHaveLength(3);
    expect(report.build!.portals).toHaveLength(4);
    expect(walkthrough.state).toMatchObject({ gold: 150 });
  });

  it('leaves the project untouched on disk — the caller decides whether to commit', async () => {
    const session = await open();
    const report = await generateGame(session, BANDITS, { checkBattles: false });

    expect(report.build!.startMapId).toBeGreaterThan(1);
    expect(session.dirtyFiles()).toContain('System.json');
    await expect(access(path.join(project.dir, 'data', mapFileName(report.build!.startMapId)))).rejects.toThrow();
  });

  it('refuses a spec that could never be finished, before writing anything', async () => {
    const session = await open();
    const report = await generateGame(session, {
      ...BANDITS,
      quests: [
        { ...BANDITS.quests[0], requires: ['scout'] },
        { ...BANDITS.quests[1], requires: ['herb'] },
      ],
      finale: { ...BANDITS.finale, requires: ['herb', 'scout'] },
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('requirement-cycle');
    expect(report.build).toBeUndefined();
    expect(session.dirtyFiles()).toEqual([]);
  });

  it('reports a boss the party cannot beat instead of shipping a wall', async () => {
    const session = await open();
    // Reid alone against three slimes: the probe says 0%. The event layer would
    // never notice — run_scenario is *told* the battle was won.
    const report = await generateGame(session, { ...BANDITS, party: [1] }, { battleTrials: 100 });

    expect(report.ok).toBe(false);
    const finale = report.battles.find((b) => b.what.includes('finale'))!;
    expect(finale.ok).toBe(false);
    expect(finale.winRate).toBeLessThan(0.5);
    expect(report.summary).toMatch(/NOT completable/);
    // The scenarios still ran and still passed: that is the point of having a
    // battle gate at all — the event layer cannot see this failure.
    expect(report.scenarios.every((s) => s.pass)).toBe(true);
  });

  it('names the id that does not exist rather than half-building the game', async () => {
    const session = await open();
    const report = await generateGame(session, {
      ...BANDITS,
      finale: { ...BANDITS.finale, troop: { enemyId: 99 } },
    });

    expect(report.issues).toEqual([
      { code: 'missing-row', path: 'finale.troop.enemyId', message: 'Enemy 99 does not exist in Enemies.json' },
    ]);
    expect(session.dirtyFiles()).toEqual([]);
  });

  it('generates a suite with teeth: break the turn-in and the walkthrough fails', async () => {
    const session = await open();
    const report = await generateGame(session, BANDITS, { checkBattles: false });
    expect(report.ok).toBe(true);

    // The single most common generated-quest bug: the giver takes the item and
    // says thank you, but never sets the "done" switch, so the next quest — and
    // the finale — stay locked forever. A suite that passes through this is a
    // suite that proves nothing.
    const quest = report.build!.quests[0];
    session.updateFile<MapData>(mapFileName(quest.giver.mapId), (map) => {
      const page = map.events[quest.giver.eventId]!.pages[0];
      // Just the one command, left otherwise untouched: the giver still takes
      // the item and still thanks you, which is what makes this bug survive a
      // human playtest of the quest it belongs to.
      page.list = page.list.filter((c) => !(c.code === 121 && c.parameters[0] === quest.switches.done));
    });

    const after = runScenario(session, report.suite[0]);
    expect(after.pass).toBe(false);
    expect(after.failures.join('\n')).toMatch(new RegExp(`switch ${quest.switches.done}`));
  });

  it('handles the degenerate spec — one area, no quests, just a boss', async () => {
    // A plausible first draft from a model given a very short brief. It has no
    // gates at all, so the suite is the walkthrough alone.
    const session = await open();
    const report = await generateGame(
      session,
      {
        title: 'One Room',
        areas: [{ key: 'room', name: 'The Room' }],
        quests: [],
        finale: { area: 'room', name: 'The Thing', troop: { enemyId: 2 } },
      },
      { battleTrials: 50 }
    );

    expect(report.ok).toBe(true);
    expect(report.scenarios.map((s) => s.name)).toEqual(['walkthrough']);
  });

  /**
   * Generated events block movement (`priorityType: 1`), so two on adjacent
   * tiles can seal a third — or the spawn point — behind a ring nobody can step
   * into. The walkthrough cannot see it: `runEvent` never walks. Four quests in
   * one small area used to leave the player boxed in on frame one.
   */
  it('never places two events (or the spawn point) on adjacent tiles', async () => {
    const session = await open();
    const build = buildGame(session, {
      title: 'Crowded',
      areas: [{ key: 'town', name: 'Town', width: 15, height: 15 }],
      quests: Array.from({ length: 4 }, (_, q) => ({
        key: `q${q}`,
        title: `Quest ${q}`,
        giver: { area: 'town', name: `Giver ${q}` },
        objective: { kind: 'talk' as const, area: 'town', name: `Elder ${q}` },
      })),
      finale: { area: 'town', name: 'Boss', troop: { enemyId: 1 } },
    });

    const map = session.readFile<MapData>(mapFileName(build.startMapId));
    const taken = new Set([`${build.start.x},${build.start.y}`]);
    for (const event of map.events) if (event) taken.add(`${event.x},${event.y}`);
    expect(taken.size).toBe(map.events.filter(Boolean).length + 1);

    for (const key of taken) {
      const [x, y] = key.split(',').map(Number);
      const free = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].filter(([dx, dy]) => !taken.has(`${x + dx},${y + dy}`));
      expect({ key, free: free.length }).toEqual({ key, free: 4 });
    }
  });

  /**
   * Gap review #5/#6/#7: two quests from "Militia Captain" are one NPC, that
   * NPC has a face, and the switches read `quest.scout.started` rather than
   * `quest.scout.0`. All three are invisible to the walkthrough — it drives
   * events by id and never looks at the map — so they are asserted here.
   */
  it('gives one NPC both of their quests, with the sprite and the switch names the spec asked for', async () => {
    const session = await open();
    const build = buildGame(session, {
      ...BANDITS,
      quests: BANDITS.quests.map((quest) => ({
        ...quest,
        giver: { ...quest.giver, sprite: { characterName: 'People1', characterIndex: 3 } },
      })),
    });

    const [scout, wolves] = build.quests.filter((q) => q.giver.name === 'Militia Captain');
    expect(scout.giver.eventId).toBe(wolves.giver.eventId);
    expect([scout.giver.order, wolves.giver.order]).toEqual([0, 1]);
    expect(build.quests.filter((q) => q.giver.name === 'Herbalist')[0].giver.eventId).not.toBe(scout.giver.eventId);

    const map = session.readFile<MapData>(mapFileName(scout.giver.mapId));
    const captain = map.events[scout.giver.eventId]!;
    expect(map.events.filter((e) => e?.name === 'Militia Captain')).toHaveLength(1);
    expect(captain.pages[0].image).toMatchObject({ characterName: 'People1', characterIndex: 3 });

    const names = session.readFile<{ switches: string[] }>('System.json').switches;
    expect(names[scout.switches.started]).toBe('quest.scout.started');
    expect(names[scout.switches.done]).toBe('quest.scout.done');
    expect(names[build.clearSwitch]).toBe('game.clear');
  });

  /**
   * Gap review #2/#3: the generator used to leave every map on tileset 1, and a
   * map re-pointed at another tileset afterwards reads *that* one's flags — in a
   * stock project A4 kind 0 is cliff tops, which are passable, so every wall the
   * generator drew becomes a wall you walk through. Passing the tileset through
   * is what makes composeMap write the flags into the tileset the map uses.
   */
  it('draws each area with the tileset the spec named, and makes its walls solid there', async () => {
    const session = await open();
    session.updateFile<Array<Record<string, unknown> | null>>('Tilesets.json', (data) => {
      data[2] = { ...(data[1] as Record<string, unknown>), id: 2, name: 'Cave', flags: new Array(8192).fill(0) };
    });

    const build = buildGame(session, {
      ...BANDITS,
      areas: BANDITS.areas.map((area) => ({ ...area, tilesetId: 2 })),
    });

    for (const area of build.areas) {
      expect(session.readFile<MapData>(mapFileName(area.mapId)).tilesetId).toBe(2);
    }
    const tilesets = session.readFile<Array<{ flags: number[] } | null>>('Tilesets.json');
    // A4 kind 0 shape 0 = the wall composeMap fills with: all four direction
    // bits set (0xf) means blocked, and it has to be blocked in tileset 2.
    expect(tilesets[2]!.flags[5888] & 0xf).toBe(0xf);
    expect(tilesets[1]!.flags[5888] & 0xf).toBe(0);
  });

  it('is reproducible: the same spec and seed build byte-identical maps', async () => {
    const [a, b] = await Promise.all([open(), open()]);
    const first = buildGame(a, BANDITS);
    const second = buildGame(b, BANDITS);

    expect(second.startMapId).toBe(first.startMapId);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(b.readFile(mapFileName(second.startMapId)))).toBe(
      JSON.stringify(a.readFile(mapFileName(first.startMapId)))
    );
  });

  it('runs ten different games back to back, all of them completable', async () => {
    const results: Array<{ i: number; ok: boolean; summary: string }> = [];
    for (let i = 0; i < 10; i++) {
      const session = await open();
      const report = await generateGame(session, variation(i), { battleTrials: 100 });
      results.push({ i, ok: report.ok, summary: report.summary });
    }

    expect(results.filter((r) => !r.ok).map((r) => r.summary)).toEqual([]);
    expect(results).toHaveLength(10);
  });
});

/**
 * Ten different games, not one game ten times: the area count, the quest count,
 * the objective kinds and the length of the prerequisite chain all move, so the
 * run exercises multi-hop travel, all three objective kinds and a gate chain
 * rather than re-proving the same path.
 */
function variation(i: number): GameSpec {
  const areaCount = 2 + (i % 3);
  const questCount = 1 + (i % 4);
  const areas = Array.from({ length: areaCount }, (_, a) => ({
    key: `area${a}`,
    name: `Area ${a}`,
    ...(a > 0 ? { connects: [`area${a - 1}`] } : {}),
  }));

  const kinds = ['fetch', 'talk', 'defeat'] as const;
  const quests = Array.from({ length: questCount }, (_, q) => {
    const kind = kinds[(i + q) % kinds.length];
    const objectiveArea = `area${(q + 1) % areaCount}`;
    const objective =
      kind === 'fetch'
        ? { kind, area: objectiveArea, name: `Cache ${q}`, item: { name: `Token ${i}-${q}` }, count: q + 1 }
        : kind === 'talk'
          ? { kind, area: objectiveArea, name: `Elder ${q}` }
          : { kind, area: objectiveArea, name: `Pack ${q}`, troop: { enemyId: 1, count: 1 + (q % 2) } };

    return {
      key: `q${q}`,
      title: `Quest ${q}`,
      giver: { area: `area${q % areaCount}`, name: `Giver ${q}` },
      objective,
      ...(q > 0 ? { requires: [`q${q - 1}`] } : {}),
      reward: { gold: 10 * (q + 1) },
    };
  });

  return {
    title: `Variation ${i}`,
    seed: i,
    party: [1, 2],
    areas,
    quests,
    finale: { area: `area${areaCount - 1}`, name: `Warlord ${i}`, troop: { enemyId: 1, count: 2 } },
  };
}
