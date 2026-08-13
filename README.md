# rmmz-kit

An MCP server, plus the toolchain under it, for automating RPG Maker MZ projects. An agent
edits `data/*.json`, writes events from a YAML DSL, validates references and structure,
simulates battles, and runs headless event-layer scenarios — without opening the editor.

Everything happens in one transaction: reads and mutations are in memory, nothing touches
disk until `commit`, and a failed validation writes nothing. `rollback` throws the session's
changes away.

## Requirements

- **Node 20+**
- **`git` on PATH** — the transaction commits through the `git` binary, and the test fixtures
  `git init` a temp copy per test.
- **An RPG Maker MZ project directory**, or `create_project` to make one from
  `templates/blank-project`.

The MZ **runtime** (`js/rmmz_*.js`) and the editor ship with the paid product and are not in
this repo. A project created here has data but no engine or art: it opens as a project, it
does not boot. Point `create_project --runtimeFrom <an installed project>` at a licensed
install to get one that does.

## Install

```bash
npm ci
npm run build
```

## Wire it into an MCP client

The server speaks stdio and is opened against **one project**, given as the single argument:

```bash
node packages/mcp/dist/bin.js /path/to/my-project
```

Claude Code:

```bash
claude mcp add rmmz -- node /abs/path/to/rmmz-kit/packages/mcp/dist/bin.js /path/to/my-project
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "rmmz": {
      "command": "node",
      "args": [
        "/abs/path/to/rmmz-kit/packages/mcp/dist/bin.js",
        "/path/to/my-project"
      ]
    }
  }
}
```

Try it against the bundled fixture first — `fixtures/minimal-project` is a hand-written
minimal MZ project, deliberately including one structurally broken event so `validate` has
something to find.

`create_project` is the one tool that ignores the open session, because it makes a *different*
project. Re-point the client at the new path to edit it.

## A session, end to end

Adding a herb-fetch quest to an existing project looks like this:

1. Read `rmmz://project/summary` — maps, database row counts, the namespaces already
   allocated. Read `rmmz://asset-catalog` before naming any sprite or sound.
2. `allocate_namespace` `quest.herb` with `switches: ["started", "done"]` — from then on
   `"quest.herb.started"` works anywhere a switch id is taken.
3. `upsert_map_event` places the NPC and declares its pages (position, trigger, sprite, page
   conditions).
4. `apply_script` compiles the YAML DSL into that page's command list. This is the only tool
   that writes a command list, so moving the NPC later can't delete its dialogue.
5. `validate` — dangling ids, broken branch structure, dead pages, unread self switches.
6. `run_scenario` — drive the events headlessly and assert the quest actually completes.
7. `diff` to see which files would be written, then `commit` — or `rollback` and try again.

Steps 1–6 write nothing to disk. That is the point: an agent can ask "did that break the
quest?" about an edit it has not committed.

## Tools

### Edit

| Tool | |
|---|---|
| `apply_script` | Compile a YAML DSL script and write it as a map event page or common event's command list. Switch/variable fields take a numeric id or an `allocate_namespace` name like `"quest.herb.started"`. |
| `upsert_map_event` | Create or fully replace a map event's metadata and pages. Command lists are left alone — an existing page keeps its, a new page starts empty. |
| `upsert_database` | Shallow-merge entries into a database table by id (Actors, Classes, Skills, Items, Weapons, Armors, Enemies, States, Troops, CommonEvents, Tilesets, Animations, MapInfos). Omit id to append. |
| `update_system` | Shallow-merge a patch into System.json (title, terms, currency, starting map/party, option flags). Returns any keys the file did not already have — a typo shows up there. |
| `allocate_namespace` | Allocate a contiguous block of switch/variable ids for a quest or feature, and return member→id. |

### Maps

| Tool | |
|---|---|
| `create_map` | Write `Map###.json` and its MapInfos row; returns the allocated map id. |
| `resize_map` | Resize anchored top-left. Events are never moved; any left out of bounds are returned. |
| `paint_tiles` | Fill rectangles of one layer with a tile id, then re-derive autotile shapes over what changed. |
| `set_tile_flags` | Passability, terrain tags and tile options (star/ladder/bush/counter/damage) for individual tile ids. |
| `compose_map` | Generate a connected room-and-corridor map (BSP) and create it. Returns the room rectangles to place events in — don't paint tile by tile. |
| `update_map` | Shallow-merge a map's own fields: random encounters, display name, BGM/BGS, parallax. Tiles, events and size have their own tools and are refused here. |
| `find_free_rect` | Non-overlapping rectangles where every tile is walkable and no event stands — where a house or a field can go. |

### Project files

| Tool | |
|---|---|
| `manage_plugins` | Read `js/plugins.js`, and enable/disable/configure plugins by name. The plugin's `js/plugins/<name>.js` must already exist. |
| `import_asset` | Copy an image or audio file into the right project folder. Lands with `commit` like every other change. |

### Check

| Tool | |
|---|---|
| `validate` | Run the L4 validator (structure, reference integrity, semantics) and return all findings. |
| `simulate_battle` | Run N headless battles against the in-memory data: win rate, turns, TTK, damage distribution, one-shot kills, stalemates. |
| `run_scenario` | Run a headless event-layer scenario and report every assertion, the messages shown, the final state and event coverage. Runs event commands, not frames. |
| `repair` | The L6 repair loop: `start` snapshots what is already failing, then you edit and `check` to have the attempt graded — feedback, or a verdict (converged / exhausted / oscillating). |

### Build and ship

| Tool | |
|---|---|
| `generate_game` | Spec → a whole small RPG (a map per area, portals, a gated quest chain, a boss), then prove it is finishable: validate, simulate every fight, play a generated walkthrough to the clear switch. |
| `playtest` | Local playtest site over the project — the editor's Playtest button. Also stages `AutoTest.js`, which exposes `window.__AT` for browser automation. |
| `deploy` | Export a shippable package, minus the editor project file, save data and unreferenced assets. `target: "windows"` wraps it in an NW.js shell you supply. |
| `create_project` | Create a new MZ project from the blank template, git-initialised and ready for `openProject`. |

### Transaction

| Tool | |
|---|---|
| `diff` | List the data files `commit` would write right now. |
| `commit` | Validate, then atomically write dirty files and git-commit them. Throws (writing nothing) if validation fails. |
| `rollback` | Discard all in-memory mutations since open or the last commit. |

**`playtest` and `deploy` read the disk, not the session** — a browser and a build both read
files. Commit before either, or you will play the last commit and wonder why.

## Resources

| URI | |
|---|---|
| `rmmz://project/summary` | Title, map list, database row counts, namespaces, named switch/variable counts. |
| `rmmz://map/{id}` | A map's full JSON, each event page annotated with its decompiled DSL script. |
| `rmmz://database/{table}` | One table: `actors`, `classes`, `skills`, `items`, `weapons`, `armors`, `enemies`, `states`, `troops`, `commonEvents`, `tilesets`, `animations`, `mapInfos`. |
| `rmmz://tileset/{id}` | Every tile id one tileset can draw: each autotile kind's base id, sheet, family and passability, plus each plain page's id range. Read it before `paint_tiles` — a tile id cannot be guessed from a filename. |
| `rmmz://asset-catalog` | Filenames actually present under `img/` and `audio/` — ground tool calls in what exists instead of guessing. |
| `rmmz://game-brief-guide` | How to turn a one-sentence brief into a `generate_game` spec, and what to do with each way its report comes back. Read before calling `generate_game`. |

## Development

```bash
npm test                                            # all tests (vitest)
npx vitest run packages/core/test/session.test.ts   # one file
npx vitest run -t "rollback"                        # one test by name
npm run build                                       # tsc per workspace; also the typecheck
```

There is no linter. CI runs `npm run build` (which typechecks every package's `src`) and the
full suite on Linux and Windows.

Tests are slow by design, not hung: each one copies `fixtures/minimal-project` to a temp dir
and `git init`s it, which costs 1–2s per test on Windows. `vitest.config.ts` raises
`testTimeout` accordingly.

Architecture, and the reasoning behind each decision, is in [CLAUDE.md](CLAUDE.md). The
roadmap is `docs/rmmz-automation-implementation-plan.md` (Chinese).

## Status and known limits

Milestones M0–M11 are delivered — see `CLAUDE.md` for what each one covers.

Several acceptance criteria are **unmet by construction rather than by neglect**: they need
something this repo cannot contain. Each is written up honestly where it lives, and none of
them needs a source change to close (plan §8.3):

| Gap | Needs |
|---|---|
| Battle sim within 10% of real play | MZ's sample database + a real playthrough to compare against |
| Driving `window.__AT` from a browser | The MZ runtime (paid) |
| Repair-rate and one-sentence→spec numbers | A real model in the loop — in this architecture the model is the MCP client, not this process |
| Deployed build playable / project opens in editor | The engine and editor (paid) |

The headless scenario runner covers the event layer, not rendering, movement or TPB timing.
Anything it does not model increments an `unmodeled` counter in its report instead of being
skipped silently — a green run with a non-empty `unmodeled` proved less than it looks.
