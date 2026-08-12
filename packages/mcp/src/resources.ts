import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectSession, SystemData, MapData } from '@rmmz-kit/core';
import { mapFileName } from '@rmmz-kit/core';
import { decompile, printDsl } from '@rmmz-kit/compiler';
import { ASSET_DIRS } from './assets.js';
import { DATABASE_TABLES } from './tables.js';

/**
 * MCP resources (plan §4.5 "讀"). Pure functions over a ProjectSession, kept
 * separate from server.ts's McpServer wiring so they're testable without a
 * transport.
 */

export function projectSummary(session: ProjectSession): unknown {
  // listFiles() rebuilds the whole filename array per call; this asks it a
  // dozen times (once per DATABASE_TABLES entry), so snapshot it once.
  const files = new Set(session.listFiles());
  const system = files.has('System.json') ? session.readFile<SystemData>('System.json') : undefined;
  const maps = files.has('MapInfos.json')
    ? session
        .readFile<Array<{ id: number; name: string } | null>>('MapInfos.json')
        .filter((m): m is { id: number; name: string } => m != null)
    : [];

  const tables: Record<string, number> = {};
  for (const [table, file] of Object.entries(DATABASE_TABLES)) {
    if (!files.has(file)) continue;
    const count = session.readFile<Array<unknown | null>>(file).filter((e) => e != null).length;
    tables[table] = count;
  }

  return {
    gameTitle: system?.gameTitle ?? '',
    maps: maps.map((m) => ({ id: m.id, name: m.name })),
    tables,
    namedSwitches: (system?.switches ?? []).filter(Boolean).length,
    namedVariables: (system?.variables ?? []).filter(Boolean).length,
  };
}

/**
 * Returns the raw map JSON plus, per event page, a best-effort `script` field
 * (the L2 DSL, per plan §4.5's point that showing an LLM existing events as
 * text — not raw command arrays — is the whole reason decompile()/printDsl()
 * exist). A page decompile() can't handle (Tier 2/3 command, see CLAUDE.md)
 * is left without `script`; its raw `list` is still there.
 */
export function mapResource(session: ProjectSession, mapId: number): unknown {
  const file = mapFileName(mapId);
  if (!session.listFiles().includes(file)) {
    throw new Error(`Map ${mapId} does not exist`);
  }
  const map = session.readFile<MapData>(file);
  return {
    ...map,
    events: map.events.map((event) => {
      if (!event) return event;
      return {
        ...event,
        pages: event.pages.map((page) => {
          try {
            return { ...page, script: printDsl(decompile(page.list)) };
          } catch {
            return page;
          }
        }),
      };
    }),
  };
}

export function databaseResource(session: ProjectSession, table: string): unknown {
  const file = DATABASE_TABLES[table];
  if (!file) {
    throw new Error(`Unknown database table: ${table}. Known tables: ${Object.keys(DATABASE_TABLES).join(', ')}`);
  }
  if (!session.listFiles().includes(file)) {
    throw new Error(`${file} does not exist in this project`);
  }
  return session.readFile(file);
}

/**
 * Filenames (extension stripped) present under each standard asset folder
 * (ASSET_DIRS, shared with import_asset). Grounding an LLM in what actually
 * exists — plan §4.5's point that this is disproportionately effective at
 * stopping hallucinated filenames. A missing folder (the fixture project has
 * none) just reports an empty list, same "can't say anything" stance
 * validate/rules/references.ts takes.
 *
 * Assets imported in this session but not yet committed are included: they are
 * exactly the ones a model is about to reference, and a catalog that denied
 * their existence would talk it out of its own import.
 */
export async function assetCatalog(session: ProjectSession): Promise<Record<string, string[]>> {
  const catalog: Record<string, string[]> = {};
  const staged = session.rawWriteFiles();
  await Promise.all(
    ASSET_DIRS.map(async (rel) => {
      const onDisk = await readdir(path.join(session.rootPath, rel)).catch(() => []);
      const pending = staged.filter((file) => file.startsWith(`${rel}/`)).map((file) => file.slice(rel.length + 1));
      catalog[rel] = [...new Set([...onDisk, ...pending].map((f) => f.replace(/\.[^./]+$/, '')))].sort();
    })
  );
  return catalog;
}
