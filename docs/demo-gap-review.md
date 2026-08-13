# Gap review: building a playable game with the toolchain (2026-08-13)

Findings from driving the whole stack end to end against a **real, licensed MZ
install** — `create_project`-style copy of `RPGMZ/NewData`, then `generate_game`
→ decoration → `validate` → `commit` → `deploy` → `playtest` server → played in
Chrome. This is the first time anything in this repo has been run against the
paid engine instead of `fixtures/minimal-project`, so most of these are gaps
that could not have been seen from inside the repo.

The demo script itself is scratch (`scratchpad/play.mjs`), not part of the repo.
What matters is the list below: everything the script had to do *for* the
toolchain, and everything that bit us at runtime.

Ranked by how badly it hurts a caller who does not already know the answer.

---

## 1. A generated game boots to a black screen if `advanced.windowOpacity` is missing

**Severity: high — the game does not run at all.**

`Game_System.windowOpacity()` is `return $dataSystem.advanced.windowOpacity;`
with no fallback, and `Window_Base.updateBackOpacity` calls it while building
the very first window. Missing field ⇒

```
TypeError: Cannot read properties of undefined (reading 'clamp')
  at Window_Base.updateBackOpacity → Scene_Map.createMapNameWindow
```

The editor writes that field the first time a project is *saved*, so the
shipped `NewData` template does not have it. `templates/blank-project` **does**
(`windowOpacity: 192`), so `create_project` is fine — but any project this
toolchain opens that was never saved by the editor is one where every generated
map crashes on entry, and nothing in the stack says so.

**Fix candidates**
- A `validate` rule: System.json fields the engine dereferences with no
  nullcheck (`advanced.windowOpacity`, `advanced.screenWidth`,
  `advanced.uiAreaWidth`, `itemCategories`, `sounds[0..23]`). This is the same
  class of bug `templates/blank-project`'s comment already documents — the
  knowledge exists in a comment where no caller can act on it.
- Severity should be `error`: the game is unbootable, not lint-dirty.

## 2. `generate_game` never sets a map's `tilesetId`

**Severity: high — the game is playable but the maps are unreadable.**

`buildGame` calls `composeMap` without a tileset, so every generated map keeps
`blankMap`'s default (tileset 1). In a stock MZ project tileset 1 is
*Overworld*, which has no A3/A4 building tiles — so `composeMap`'s walls draw as
black nothing. The demo had to rewrite `tilesetId` on all seven maps afterwards.

**Fix**: `AreaSpec.tilesetId?: number` in `GameSpec`, passed straight through to
`ComposeSpec.tilesetId` (which already exists). One field, no new logic.

## 3. Walls are passable after a tileset change — `ensureFlags` writes to the wrong tileset

**Severity: high — the player walks through every wall.**

`composeMap`'s `ensureFlags` writes passability for the floor/wall tiles into
*the tileset the map was composed against*. Point the map at a different
tileset (see #2) and the game reads that one's flags instead: stock Outside
marks most of A4 kind 0's 48 shapes **passable** (in MZ they are cliff *tops*,
which you are meant to walk on). Result: solid-looking walls you stroll through.

The demo fixed it with `set_tile_flags` over all 48 shapes of tile 5888.

**Fix candidates**
- Once #2 exists, `ensureFlags` naturally targets the right tileset — that
  covers the generated case.
- A `validate` rule is the general answer: "a map's wall tile is passable in the
  tileset the map actually uses". `analyzeReachability` already has every piece
  needed; today it only reports *regions*, and a map whose walls are all
  passable is still exactly one region, so the existing check is blind to this.

## 4. Nothing exposes tile ids, so a caller cannot use `paint_tiles` without arithmetic

**Severity: medium — the two map-painting tools are unusable from an MCP client.**

`paint_tiles` / `set_tile_flags` take raw tile ids. Producing one means knowing
that A2 kinds start at 2816, A3 at 4352, that a kind is `base + rel*48`, and
that `rel = row*8 + col` on a sheet the caller cannot see. The demo derived
`SOIL = 2816 + 16*48` by **opening `Outside_A2.png` and counting tiles**. An MCP
client cannot do that.

This is the exact argument §4.5 makes for `rmmz://asset-catalog`: a model that
can see what exists does not invent what does not.

**Fix**: `rmmz://tileset/{id}` listing, per tileset, each sheet's autotile kinds
with their base tile id and passability — plus the B–E page's id ranges. Names
would have to come from the caller (the art has no labels), but ids + flags +
"which sheet" is mechanical and is the part nobody can guess.

## 5. `generate_game` emits invisible NPCs

**Severity: medium — every character in the generated game is an invisible tile.**

Generated events get `characterName: ''`. That is documented as deliberate (the
repo ships no art), but the moment there *is* art — which is the only case where
anyone plays the result — every giver, objective and portal is a blank tile you
bump into. The demo had to patch 23 events with a name→sprite table.

**Fix**: optional `sprite: { characterName, characterIndex }` on `QuestSpec.giver`,
`ObjectiveSpec`, `FinaleSpec`, and an `AreaSpec.portalSprite`. Still no art
invented by the generator; the caller names what it has, exactly like `troop`.

## 6. One giver NPC per quest, even when two quests share a giver

**Severity: medium — the world reads as broken.**

Two quests with `giver.name: "Old Mira"` produce two separate Mira events
standing in different rooms. Nothing is functionally wrong (each is correctly
gated) but it looks like a bug to a player, and the fix is not available to the
caller — the placement is internal.

**Fix**: key giver events by `(area, name)` and merge their pages, ordering by
the quest topological order `questOrder()` already computes. The page-order rule
(unconditional page first) is unchanged.

## 7. Namespace members are numbered, not named

**Severity: low — cosmetic, but it undoes §8.1-1 exactly where it would pay.**

`buildGame` allocates namespaces by *count*, so the switches read
`quest.herb.0` / `.1` / `.2`. §8.1-1 supports member names, and `BuiltQuest`
already calls them `started` / `done` / `objective` in TypeScript. A human
opening the editor, or a repair loop reading feedback, sees the numbers.

**Fix**: pass `["started","done","objective"]` to `allocateNamespace`. One line.

## 8. No tool writes `encounterList`

**Severity: low — but it is a whole gameplay system with no surface.**

Random encounters live on the map object (`encounterList`, `encounterStep`).
`create_map`/`compose_map` write the empty defaults, `upsert_database` cannot
touch maps, and there is no map-level upsert. The demo went behind the tools
with `session.updateFile`.

**Fix**: either an `encounters` field on `compose_map`/`create_map`, or a small
`update_map` tool for the map-level fields that are not tiles or events
(`encounterList`, `encounterStep`, `displayName`, `bgm`, `parallaxName`,
`autoplayBgm`, …). The second is more honest — those fields are a real category.

## 9. Decoration has no home

**Severity: low — known and documented as out of scope; recording the shape of it.**

Houses and fields in the demo are `paint_tiles` rectangles chosen by hand: roof
and wall A3 autotiles with a one-tile doorway gap, soil A2 with crop rows two
tiles apart so the field stays walkable. It worked, and it needed #4 to be
possible at all. Nothing here argues for prefabs in `mapgen` (the reasoning
against them still holds) — but a caller doing this needs, in order: tile ids
(#4), a placement query ("free w×h rect inside a room, no events"), and a
post-check that nothing got walled off (`analyzeReachability`, which exists and
worked).

The middle one is the only piece with no home today. `composeMap` already
returns `rooms`; a `freeRect(session, mapId, w, h)` helper next to it would
close it.

---

## What worked, and is worth not breaking

- **`validate` caught the real bug of the session**: `!Gate1` instead of
  `!$Gate1.png` — a sprite that would have silently never drawn. Case-sensitive
  asset checking earned its keep on the first real run.
- **`simulate_battle` is the only gate that can see an unwinnable encounter.**
  Confirmed the three random-encounter troops at 100% / 2.2–2.8 turns for a
  level-1 party. The event layer is *told* battle outcomes and is structurally
  blind to this.
- **`deploy` pruning**: 101 MB template → 23.3 MB bundle, 799 assets pruned, and
  nothing referenced went missing (the over-keeping bias is the right one).
- **`analyzeReachability` after decoration**: houses are solid, and this is what
  proves no room, event or corridor got sealed off. Ran clean on all 7 maps.
- **The transaction model**: seven maps, ~40 events, tile painting, tileset
  flags, System edits — one `commit`, and every failed intermediate run left
  nothing behind.
