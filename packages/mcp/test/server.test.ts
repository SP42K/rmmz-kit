import { describe, it, expect, afterEach } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openProject, type ProjectSession } from '@rmmz-kit/core';
import { createServer } from '../src/server.js';
import { makeTestProject } from './testProject.js';

async function connectedClient(session: ProjectSession): Promise<Client> {
  const server = createServer(session);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function text(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const first = (result.content as Array<{ type: string; text: string }>)[0];
  return JSON.parse(first.text);
}

describe('MCP server wiring', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  it('lists the plan §4.5 tools and resources', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const client = await connectedClient(await openProject(dir));

    const { tools } = await client.listTools();
    expect(new Set(tools.map((t) => t.name))).toEqual(
      new Set([
        'apply_script',
        'upsert_map_event',
        'upsert_database',
        'allocate_namespace',
        'validate',
        'simulate_battle',
        'update_system',
        'create_map',
        'resize_map',
        'paint_tiles',
        'set_tile_flags',
        'compose_map',
        'manage_plugins',
        'import_asset',
        'playtest',
        'run_scenario',
        'repair',
        'generate_game',
        'deploy',
        'create_project',
        'diff',
        'commit',
        'rollback',
      ])
    );

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('rmmz://project/summary');
    expect(resources.map((r) => r.uri)).toContain('rmmz://asset-catalog');
    expect(resources.map((r) => r.uri)).toContain('rmmz://game-brief-guide');
  });

  /** Plan §3 M5 acceptance test: "在 Map001 加一個賣藥水的 NPC" end to end over the MCP protocol. */
  it('adds a potion-selling NPC to Map001 and commits it', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const client = await connectedClient(await openProject(dir));

    const created = text(
      await client.callTool({
        name: 'upsert_map_event',
        arguments: {
          mapId: 1,
          name: 'Potion Seller',
          x: 5,
          y: 5,
          pages: [{ trigger: 0, image: { characterName: 'Actor1', characterIndex: 0 } }],
        },
      })
    ) as { id: number };
    expect(created.id).toBe(2);

    const applied = text(
      await client.callTool({
        name: 'apply_script',
        arguments: {
          target: { map: 1, event: created.id, page: 1 },
          dsl: '- say: "Welcome! Potions, 100G each."\n- raw:\n    code: 302\n    parameters: [0, 1, 0, false]\n',
        },
      })
    ) as { ok: boolean };
    expect(applied.ok).toBe(true);

    // The fixture's pre-existing event 1 has one known, documented structural quirk
    // unrelated to this NPC (see packages/compiler/test/decompile.test.ts) — assert
    // the new event (id 2) itself introduced no errors, not that the whole project is clean.
    const findings = text(await client.callTool({ name: 'validate', arguments: {} })) as Array<{
      severity: string;
      path?: string;
    }>;
    expect(findings.filter((f) => f.severity === 'error' && f.path?.includes('event 2'))).toEqual([]);

    const dirty = text(await client.callTool({ name: 'diff', arguments: {} })) as { files: string[] };
    expect(dirty.files).toEqual(['Map001.json']);

    const committed = text(
      await client.callTool({ name: 'commit', arguments: { message: 'add potion seller NPC to Map001' } })
    ) as { commit: string };
    expect(committed.commit).toMatch(/^[0-9a-f]{40}$/);

    const map = await client.readResource({ uri: 'rmmz://map/1' });
    const mapData = JSON.parse((map.contents[0] as { text: string }).text) as {
      events: Array<{ name: string; pages: Array<{ script?: string }> } | null>;
    };
    expect(mapData.events[2]?.name).toBe('Potion Seller');
    expect(mapData.events[2]?.pages[0].script).toContain('Welcome! Potions');
  });

  /** Plan §3 M7.6 acceptance: enable a plugin and import a character image over MCP, reference the image from an event, validate clean, commit. */
  it('imports an asset, enables a plugin, and uses both in one event', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const client = await connectedClient(await openProject(dir));

    const source = path.join(dir, 'Hero.png');
    await writeFile(source, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const imported = text(
      await client.callTool({ name: 'import_asset', arguments: { dir: 'img/characters', source, name: 'Hero.png' } })
    ) as { path: string };
    expect(imported.path).toBe('img/characters/Hero.png');

    const plugins = text(
      await client.callTool({ name: 'manage_plugins', arguments: { entries: [{ name: 'TestPlugin', status: true }] } })
    ) as { plugins: Array<{ name: string; status: boolean }> };
    expect(plugins.plugins).toEqual([{ name: 'TestPlugin', status: true, description: 'Test Plugin', parameters: {} }]);

    // The uncommitted import is already in the catalog, which is what makes
    // referencing it in the same session a legal move rather than a guess.
    const catalog = await client.readResource({ uri: 'rmmz://asset-catalog' });
    expect(JSON.parse((catalog.contents[0] as { text: string }).text)['img/characters']).toContain('Hero');

    const created = text(
      await client.callTool({
        name: 'upsert_map_event',
        arguments: {
          mapId: 1,
          name: 'Patrol',
          x: 6,
          y: 6,
          pages: [
            {
              trigger: 0,
              image: { characterName: 'Hero', characterIndex: 0 },
              moveType: 3,
              moveRoute: { route: ['moveLeft', 'moveRight', { step: 'wait', parameters: [30] }], repeat: true },
            },
          ],
        },
      })
    ) as { id: number };

    // The plugin command is Tier 2 (M7.5), so this is the DSL, not a raw escape.
    text(
      await client.callTool({
        name: 'apply_script',
        arguments: {
          target: { map: 1, event: created.id, page: 1 },
          dsl: '- pluginCommand:\n    plugin: TestPlugin\n    command: greet\n    args: { who: Hero }\n',
        },
      })
    );

    // Green *including* the asset reference, even though Hero.png is still only
    // staged — the point of validating before deciding to commit.
    const findings = text(await client.callTool({ name: 'validate', arguments: {} })) as Array<{
      severity: string;
      path?: string;
    }>;
    expect(findings.filter((f) => f.severity === 'error' && f.path?.includes(`event ${created.id}`))).toEqual([]);

    text(await client.callTool({ name: 'commit', arguments: { message: 'feat: patrolling hero' } }));

    expect([...(await readFile(path.join(dir, 'img', 'characters', 'Hero.png')))]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(await readFile(path.join(dir, 'js', 'plugins.js'), 'utf-8')).toContain('"TestPlugin"');
    const map = await client.readResource({ uri: 'rmmz://map/1' });
    const mapData = JSON.parse((map.contents[0] as { text: string }).text) as {
      events: Array<{ pages: Array<{ moveRoute: { list: Array<{ code: number }> }; script?: string }> } | null>;
    };
    // moveLeft, moveRight, wait 30, ROUTE_END.
    expect(mapData.events[created.id]?.pages[0].moveRoute.list.map((c) => c.code)).toEqual([2, 3, 15, 0]);
    expect(mapData.events[created.id]?.pages[0].script).toContain('pluginCommand');
  });

  /** Plan §3 M6.5 acceptance: change the game title, a term, and a tileset passage flag over MCP, then commit. */
  it('edits System.json and Tilesets.json over the protocol', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const client = await connectedClient(await openProject(dir));

    text(
      await client.callTool({
        name: 'update_system',
        arguments: { patch: { gameTitle: 'Herb Quest', currencyUnit: 'Gil' } },
      })
    );

    const tilesets = JSON.parse(
      ((await client.readResource({ uri: 'rmmz://database/tilesets' })).contents[0] as { text: string }).text
    ) as Array<{ flags: number[] } | null>;
    const flags = [...tilesets[1]!.flags];
    flags[48] = 15;
    text(await client.callTool({ name: 'upsert_database', arguments: { table: 'tilesets', entries: [{ id: 1, flags }] } }));

    const dirty = text(await client.callTool({ name: 'diff', arguments: {} })) as { files: string[] };
    expect(new Set(dirty.files)).toEqual(new Set(['System.json', 'Tilesets.json']));

    const committed = text(
      await client.callTool({ name: 'commit', arguments: { message: 'retitle the game and block a tile' } })
    ) as { commit: string };
    expect(committed.commit).toMatch(/^[0-9a-f]{40}$/);

    // Reopening reads what was actually written to disk — the editor's view of it.
    const reopened = await connectedClient(await openProject(dir));
    const summary = JSON.parse(
      ((await reopened.readResource({ uri: 'rmmz://project/summary' })).contents[0] as { text: string }).text
    ) as { gameTitle: string };
    expect(summary.gameTitle).toBe('Herb Quest');
    const written = JSON.parse(
      ((await reopened.readResource({ uri: 'rmmz://database/tilesets' })).contents[0] as { text: string }).text
    ) as Array<{ flags: number[]; name: string } | null>;
    expect(written[1]!.flags[48]).toBe(15);
    expect(written[1]!.flags).toHaveLength(8192);
    expect(written[1]!.name).toBe('Field');
  });

  /**
   * M7's acceptance scenario, end to end over the protocol: generate a map,
   * put an NPC in one of its rooms, make sure the player can reach them, and
   * commit — the whole "new map, painted, passable, opens in the editor" chain.
   */
  it('composes a map, places an event in a room and commits it', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const client = await connectedClient(await openProject(dir));

    const composed = text(
      await client.callTool({
        name: 'compose_map',
        arguments: { name: 'Herb Cave', width: 27, height: 21, seed: 3 },
      })
    ) as { mapId: number; rooms: Array<{ x: number; y: number; width: number; height: number }>; regionSizes: number[] };

    expect(composed.mapId).toBe(2);
    expect(composed.regionSizes).toHaveLength(1);
    expect(composed.rooms.length).toBeGreaterThan(1);

    const room = composed.rooms[0];
    await client.callTool({
      name: 'upsert_map_event',
      arguments: { mapId: composed.mapId, name: 'Hermit', x: room.x, y: room.y, pages: [{ trigger: 0 }] },
    });
    await client.callTool({
      name: 'apply_script',
      arguments: { target: { map: composed.mapId, event: 1, page: 1 }, dsl: 'say: The herb grows deeper in.\n' },
    });

    // A region id painted over the room, to prove the non-tile layers round-trip.
    await client.callTool({
      name: 'paint_tiles',
      arguments: { mapId: composed.mapId, layer: 5, ops: [{ ...room, tileId: 1 }] },
    });

    const committed = text(await client.callTool({ name: 'commit', arguments: { message: 'feat: herb cave' } })) as {
      commit: string;
    };
    expect(committed.commit).toMatch(/^[0-9a-f]{40}$/);

    const reopened = await connectedClient(await openProject(dir));
    const map = JSON.parse(
      ((await reopened.readResource({ uri: `rmmz://map/${composed.mapId}` })).contents[0] as { text: string }).text
    ) as { width: number; height: number; data: number[]; events: Array<{ name: string } | null> };
    expect(map.width).toBe(27);
    expect(map.data).toHaveLength(27 * 21 * 6);
    expect(map.events[1]!.name).toBe('Hermit');
    expect(map.data[(5 * 21 + room.y) * 27 + room.x]).toBe(1);

    const infos = JSON.parse(
      ((await reopened.readResource({ uri: 'rmmz://database/mapInfos' })).contents[0] as { text: string }).text
    ) as Array<{ name: string } | null>;
    expect(infos[2]!.name).toBe('Herb Cave');
  });

  /** Plan §3 M8 acceptance, over the protocol: author a quest, then assert its state without playing it. */
  it('writes an event and tests it with run_scenario in the same session', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const client = await connectedClient(await openProject(dir));

    const created = text(
      await client.callTool({
        name: 'upsert_map_event',
        arguments: { mapId: 1, name: 'Herbalist', x: 3, y: 4, pages: [{ trigger: 0 }] },
      })
    ) as { id: number };

    text(
      await client.callTool({
        name: 'apply_script',
        arguments: {
          target: { map: 1, event: created.id, page: 1 },
          dsl: `
- choice:
    branches:
      Sure:
        - setSwitch: { from: 10, value: true }
        - say: "Thank you!"
      Not now:
        - say: "…so be it."
`,
        },
      })
    );

    const report = text(
      await client.callTool({
        name: 'run_scenario',
        arguments: {
          name: 'accepts the quest',
          choices: [0],
          steps: [
            { action: 'runEvent', map: 1, event: created.id },
            { action: 'expect', expect: { switch: { id: 10, value: true }, message: 'Thank you!' } },
          ],
        },
      })
    ) as { pass: boolean; failures: string[]; coverage: { messagesVisited: number } };

    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.coverage.messagesVisited).toBe(1);

    // The wrong answer is a different, also-green scenario — the report is what
    // says which branch was taken, not the tool's success.
    const declined = text(
      await client.callTool({
        name: 'run_scenario',
        arguments: {
          choices: [1],
          steps: [
            { action: 'runEvent', map: 1, event: created.id },
            { action: 'expect', expect: { switch: { id: 10, value: true } } },
          ],
        },
      })
    ) as { pass: boolean; failures: string[] };
    expect(declined.pass).toBe(false);
    expect(declined.failures[0]).toContain('switch 10');
  });

  /** Plan §3 M9, over the protocol: the client is the generator, the tool is the loop. */
  it('drives the repair loop from the client side: diagnose, edit, converge', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const client = await connectedClient(await openProject(dir));

    const created = text(
      await client.callTool({ name: 'upsert_map_event', arguments: { mapId: 1, name: 'Herbalist', x: 3, y: 4, pages: [{ trigger: 0 }] } })
    ) as { id: number };
    // A first draft that says the right thing and does nothing.
    text(await client.callTool({ name: 'apply_script', arguments: { target: { map: 1, event: created.id, page: 1 }, dsl: '- say: "Thank you!"' } }));

    const suite = [
      {
        name: 'quest starts',
        steps: [
          { action: 'runEvent', map: 1, event: created.id },
          { action: 'expect', expect: { switch: { id: 10, value: true } } },
        ],
      },
    ];

    const started = text(await client.callTool({ name: 'repair', arguments: { action: 'start', scenarios: suite, commitMessage: 'feat: herbalist' } })) as {
      outcome: string;
      feedback: string;
    };
    expect(started.outcome).toBe('repairing');
    expect(started.feedback).toContain('switch 10: expected true, got false');

    text(
      await client.callTool({
        name: 'apply_script',
        arguments: { target: { map: 1, event: created.id, page: 1 }, dsl: '- setSwitch: { from: 10, value: true }\n- say: "Thank you!"' },
      })
    );

    const done = text(await client.callTool({ name: 'repair', arguments: { action: 'check' } })) as { outcome: string; commit: string };
    expect(done.outcome).toBe('converged');
    expect(done.commit).toMatch(/^[0-9a-f]{40}$/);

    // Convergence is the only thing that writes, so the event is on disk now.
    const reopened = await connectedClient(await openProject(dir));
    const map = JSON.parse(((await reopened.readResource({ uri: 'rmmz://map/1' })).contents[0] as { text: string }).text) as {
      events: Array<{ name: string } | null>;
    };
    expect(map.events[created.id]!.name).toBe('Herbalist');

    text(await client.callTool({ name: 'repair', arguments: { action: 'abort' } }));
    expect(text(await client.callTool({ name: 'repair', arguments: { action: 'status' } }))).toEqual({ outcome: 'none' });
  });

  /** Plan §3 M10 over the protocol: one sentence's worth of spec in, a finishable game out. */
  it('generates a whole small RPG and commits it', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const client = await connectedClient(await openProject(dir));

    // The guide is what a client reads first, and it names the ids that exist
    // so the spec below doesn't have to guess at them.
    const guide = ((await client.readResource({ uri: 'rmmz://game-brief-guide' })).contents[0] as { text: string }).text;
    expect(guide).toContain('Enemies (for `troop.enemyId`): 1 Slime, 2 Bat');

    const report = text(
      await client.callTool({
        name: 'generate_game',
        arguments: {
          title: 'The Lantern of Grey Fen',
          seed: 3,
          party: [1, 2],
          areas: [
            { key: 'fen', name: 'Grey Fen' },
            { key: 'mire', name: 'The Mire', connects: ['fen'] },
          ],
          quests: [
            {
              key: 'lantern',
              title: 'The Lost Lantern',
              giver: { area: 'fen', name: 'Ferryman' },
              objective: { kind: 'fetch', area: 'mire', name: 'Sunken Crate', item: { name: 'Brass Lantern' } },
              reward: { gold: 80 },
            },
          ],
          finale: { area: 'mire', name: 'Fen Warden', troop: { enemyId: 2, count: 2 } },
          options: { battleTrials: 50 },
        },
      })
    ) as {
      ok: boolean;
      summary: string;
      scenarios: Array<{ name: string; pass: boolean; failures: string[] }>;
      build: { startMapId: number; quests: Array<{ switches: { done: number } }> };
      suite: unknown[];
    };

    expect(report.scenarios.map((s) => [s.name, s.failures])).toEqual([
      ['walkthrough', []],
      ['gates', []],
    ]);
    expect(report.ok).toBe(true);
    // The trimmed report still carries the suite, because handing it to
    // `repair` is the intended next call.
    expect(report.suite).toHaveLength(2);

    text(await client.callTool({ name: 'commit', arguments: { message: 'feat: generate The Lantern of Grey Fen' } }));

    const summary = JSON.parse(
      ((await (await connectedClient(await openProject(dir))).readResource({ uri: 'rmmz://project/summary' })).contents[0] as { text: string }).text
    ) as { gameTitle: string; maps: Array<{ name: string }> };
    expect(summary.gameTitle).toBe('The Lantern of Grey Fen');
    expect(summary.maps.map((m) => m.name)).toContain('Grey Fen');
  });

  it('serves the project over the playtest tool and stops again', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const client = await connectedClient(await openProject(dir));

    const started = text(await client.callTool({ name: 'playtest', arguments: {} })) as { url: string };
    cleanups.push(async () => {
      await client.callTool({ name: 'playtest', arguments: { action: 'stop' } });
    });
    expect((await fetch(`${started.url}data/Map001.json`)).status).toBe(200);

    text(await client.callTool({ name: 'playtest', arguments: { action: 'stop' } }));
    expect(text(await client.callTool({ name: 'playtest', arguments: { action: 'status' } }))).toEqual({ running: false });
  });

  it('reports a tool error instead of throwing when applying a script to a nonexistent page', async () => {
    const { dir, cleanup } = await makeTestProject();
    cleanups.push(cleanup);
    const client = await connectedClient(await openProject(dir));

    const result = await client.callTool({
      name: 'apply_script',
      arguments: { target: { map: 1, event: 99, page: 1 }, dsl: 'say: hi\n' },
    });
    expect(result.isError).toBe(true);
  });
});
