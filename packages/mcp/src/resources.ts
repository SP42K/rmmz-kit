import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectSession, SystemData, MapData, Tileset } from '@rmmz-kit/core';
import { NamespaceRegistry, mapFileName } from '@rmmz-kit/core';
import { decompile, printDsl, type DslNameLookup } from '@rmmz-kit/compiler';
import { TILE_ID_A1, TILE_ID_A2, TILE_ID_A3, TILE_ID_A4, autotileFamily } from '@rmmz-kit/mapgen';
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
    // The names apply_script and page conditions accept in place of ids —
    // listed for the same reason the asset catalog is: a model that can see
    // what exists doesn't invent what doesn't.
    namespaces: new NamespaceRegistry(session).list(),
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
  const registry = new NamespaceRegistry(session);
  const names: DslNameLookup = {
    switch: (id) => registry.nameOf('switches', id),
    variable: (id) => registry.nameOf('variables', id),
  };
  return {
    ...map,
    events: map.events.map((event) => {
      if (!event) return event;
      return {
        ...event,
        pages: event.pages.map((page) => {
          try {
            return { ...page, script: printDsl(decompile(page.list), names) };
          } catch {
            return page;
          }
        }),
      };
    }),
  };
}

/**
 * `rmmz://tileset/{id}` — which tile ids this tileset can actually draw, and
 * what they are.
 *
 * The asset-catalog argument (§4.5), applied to the one thing `paint_tiles` and
 * `set_tile_flags` take that nobody can produce from a text interface: a tile
 * id. Deriving one means knowing that A2 autotile kinds start at 2816, that a
 * kind is `base + rel * 48`, and that `rel = row * 8 + col` on a PNG the caller
 * cannot see — which in practice means opening the sheet in an image editor and
 * counting tiles. Ids, sheets and flags are mechanical, so they are listed here;
 * *names* ("this is the roof one") are not, because the art carries no labels
 * and inventing them would be worse than saying nothing.
 *
 * The A1-A4 pages are 8 columns of autotile kinds; A5 and B-E are plain 8- and
 * 16-column tile grids. `passable` is per-kind shape 0 / per-tile — the flags a
 * tile *currently* has, which is how a caller tells a floor from a wall without
 * looking at the picture.
 */
const AUTOTILE_PAGES = [
  { slot: 'A1', base: TILE_ID_A1, kinds: 16, note: 'water and waterfalls; odd upper kinds are waterfalls' },
  { slot: 'A2', base: TILE_ID_A2, kinds: 16, note: 'ground: grass, soil, floors' },
  { slot: 'A3', base: TILE_ID_A3, kinds: 16, note: 'building walls and roofs (drawn as wall autotiles)' },
  { slot: 'A4', base: TILE_ID_A4, kinds: 32, note: 'wall tops (first 8 of each 16) and wall sides' },
] as const;

const PLAIN_PAGES = [
  { slot: 'A5', base: 1536, tiles: 512, columns: 8, note: 'plain ground tiles, no autotiling' },
  { slot: 'B', base: 0, tiles: 256, columns: 16, note: 'objects drawn on the upper layers' },
  { slot: 'C', base: 256, tiles: 256, columns: 16, note: 'objects drawn on the upper layers' },
  { slot: 'D', base: 512, tiles: 256, columns: 16, note: 'objects drawn on the upper layers' },
  { slot: 'E', base: 768, tiles: 256, columns: 16, note: 'objects drawn on the upper layers' },
] as const;

export function tilesetResource(session: ProjectSession, tilesetId: number): unknown {
  if (!session.listFiles().includes('Tilesets.json')) throw new Error('This project has no Tilesets.json');
  const tileset = session.readFile<Array<Tileset | null>>('Tilesets.json')[tilesetId];
  if (!tileset) throw new Error(`Tileset ${tilesetId} does not exist`);
  const flags = tileset.flags ?? [];

  const describe = (tileId: number) => {
    const flag = flags[tileId] ?? 0;
    return {
      tileId,
      // Direction bits are *blocked* flags, so 0 is passable — reported the way
      // set_tile_flags takes them, not the way the file stores them.
      passable: { down: (flag & 0x01) === 0, left: (flag & 0x02) === 0, right: (flag & 0x04) === 0, up: (flag & 0x08) === 0 },
      ...(flag & 0x10 ? { star: true } : {}),
      ...(flag >> 12 ? { terrainTag: flag >> 12 } : {}),
    };
  };

  return {
    id: tileset.id,
    name: tileset.name,
    mode: tileset.mode,
    // Empty means the tileset does not use that page at all: every id in its
    // range draws nothing, which is what a wall painted with a tileset that has
    // no A4 sheet looks like in the editor.
    sheets: tileset.tilesetNames ?? [],
    howToUseIds:
      'paint_tiles takes an autotile kind\'s `tileId` (the base, shape 0) and derives the shape; a plain tile is its id as listed. ' +
      'set_tile_flags takes any of these ids. A kind occupies 48 consecutive ids (base..base+47), one per border shape.',
    autotiles: AUTOTILE_PAGES.filter((page) => (tileset.tilesetNames ?? [])[sheetIndex(page.slot)]).flatMap((page) =>
      Array.from({ length: page.kinds }, (_, rel) => ({
        sheet: page.slot,
        file: (tileset.tilesetNames ?? [])[sheetIndex(page.slot)],
        row: Math.floor(rel / 8),
        col: rel % 8,
        family: autotileFamily(page.base + rel * 48),
        note: page.note,
        ...describe(page.base + rel * 48),
      }))
    ),
    plainTiles: PLAIN_PAGES.filter((page) => (tileset.tilesetNames ?? [])[sheetIndex(page.slot)]).map((page) => ({
      sheet: page.slot,
      file: (tileset.tilesetNames ?? [])[sheetIndex(page.slot)],
      tileIdRange: [page.base, page.base + page.tiles - 1],
      columns: page.columns,
      note: `${page.note} — tileId = ${page.base} + row * ${page.columns} + col`,
      // Only the tiles that are not plain-passable-and-unflagged: on a real
      // sheet that is a handful out of 256, and the rest carry no information.
      flagged: Array.from({ length: page.tiles }, (_, i) => page.base + i)
        .filter((tileId) => (flags[tileId] ?? 0) !== 0)
        .map(describe),
    })),
  };
}

/** MZ stores the nine sheet filenames in one array, in this order. */
function sheetIndex(slot: string): number {
  return ['A1', 'A2', 'A3', 'A4', 'A5', 'B', 'C', 'D', 'E'].indexOf(slot);
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
 * `rmmz://game-brief-guide` (plan §3 M10) — the milestone's "prompt engineering"
 * half, checked in as a resource rather than left in whatever prompt happened to
 * be in front of the model. Two parts, and the second is the one that earns it:
 *
 * - The *method*: how a one-sentence brief becomes a spec, and what to do with
 *   each way the report can come back unfinishable. `GameSpecSchema`'s field
 *   descriptions already document the shape; this documents the decisions.
 * - The *project*: the actors, enemies and items this particular game has. The
 *   generator arranges content, it doesn't invent enemies, so a model writing
 *   `enemyId: 3` against a project with two enemies has written a spec that
 *   fails at the first gate. Same argument as the asset catalog (§4.5): naming
 *   what exists is disproportionately effective against hallucinated ids.
 */
export function gameBriefGuide(session: ProjectSession): string {
  const files = new Set(session.listFiles());
  const list = (file: string, label: string): string => {
    if (!files.has(file)) return `- ${label}: none (${file} is missing)`;
    const rows = session
      .readFile<Array<{ id: number; name?: string } | null>>(file)
      .filter((row): row is { id: number; name?: string } => row != null)
      .map((row) => `${row.id} ${row.name ?? ''}`.trim());
    return `- ${label}: ${rows.length > 0 ? rows.join(', ') : 'none'}`;
  };

  return `# Turning a brief into a \`generate_game\` spec

## Method

1. **Read the sentence for its places, its people and its ending.** Areas are
   places the player walks between; quests are what people ask for; the finale
   is the thing that ends the game. A brief that names none of these still needs
   all three — invent them, but keep the count small: 2-4 areas and 3-5 quests is
   the 30-60 minutes the plan asks for.
2. **Sequence with \`requires\`, not with geography.** The generator gates a quest
   giver on the switches of the quests it requires. Chaining every quest to the
   previous one gives a linear story; chaining several to one gives a hub.
3. **Only arrange content that exists.** \`troop\`/\`item\` ids and party actors must
   already be in the database (see below) — the exception is a fetch quest's
   \`item\`, where passing \`{ name }\` creates the quest item for you. If you want
   an enemy the project doesn't have, write it with \`upsert_database\` *first*,
   then check it with \`simulate_battle\`.
4. **Call \`generate_game\`, read the report, then commit or roll back.** Nothing
   is on disk until you commit.

## When the report says it is not finishable

| What it says | What it means | What to do |
|---|---|---|
| \`issues\` non-empty | The spec itself is incoherent (a cycle in \`requires\`, an area nothing connects to, an id that doesn't exist). Nothing was built. | Fix the spec and call again. |
| a battle with \`ok: false\` | The party loses that fight too often. The event layer cannot see this — it is *told* who won. | Weaken the troop (fewer members, a different enemy), strengthen the party, or raise \`options.minWinRate\` if you disagree with the threshold. |
| \`findings\` with severity \`error\` | The generated data is structurally wrong. This is a bug in the generator, not in your spec. | Report it; the scenarios were not even run. |
| a scenario with \`pass: false\` | The game does not play through. \`failures\` names the check, expected and actual. | Hand \`suite\` to \`repair\` (action \`start\`), fix with \`apply_script\`/\`upsert_map_event\`, then \`check\`. |

## What this project has

${list('Actors.json', 'Actors (for `party`)')}
${list('Enemies.json', 'Enemies (for `troop.enemyId`)')}
${list('Troops.json', 'Troops (for a numeric `troop`)')}
${list('Items.json', 'Items (for `reward.itemId` and a numeric fetch `item`)')}

## Art the generator will use if you name it

It never invents any — but an unnamed event is a blank tile the player bumps
into, so on a project that has art, name it:

- \`sprite: { characterName, characterIndex }\` on a quest's \`giver\`, on its
  \`objective\`, on the \`finale\`, and \`portalSprite\` on an area. Filenames come
  from \`rmmz://asset-catalog\`.
- \`tilesetId\` on an area. The default is tileset 1, which in a stock project is
  *Overworld* — it has no building tiles, so the walls this generator draws come
  out as nothing. Pick one whose A3/A4 pages exist: \`rmmz://tileset/{id}\`.

Two quests naming the same \`giver.area\` and \`giver.name\` are **one** NPC who
offers both, in \`requires\` order — not two people with the same name.

## What it does not do

Decoration and music. Lay out a village by hand with \`find_free_rect\` +
\`paint_tiles\` (tile ids come from \`rmmz://tileset/{id}\`), set map music and
random encounters with \`update_map\`. Balance beyond "is the fight winnable" is
\`simulate_battle\`'s question, not this one's.
`;
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
