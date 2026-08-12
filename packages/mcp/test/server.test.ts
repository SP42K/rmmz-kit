import { describe, it, expect, afterEach } from 'vitest';
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
        'diff',
        'commit',
        'rollback',
      ])
    );

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('rmmz://project/summary');
    expect(resources.map((r) => r.uri)).toContain('rmmz://asset-catalog');
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
