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

## What it does not do

Decoration, art and music: every generated event is invisible (no character
sprite) because this repo ships no tileset or character art to point at. Give an
event a sprite with \`upsert_map_event\` afterwards, or import one with
\`import_asset\` first. Balance beyond "is the fight winnable" is
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
