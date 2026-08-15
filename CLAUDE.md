# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`rmmz-kit` — a monorepo toolchain for automating RPG Maker MZ projects (edit `data/*.json`,
compile events, validate, headless-test). `packages/mcp` is the thin MCP adapter the plan calls
for; the value still lives in `packages/core`/`compiler`/`validate` — the MCP layer is plumbing,
not logic.

The full roadmap is `docs/rmmz-automation-implementation-plan.md` (Chinese). It defines the layer
naming (L0 I/O → L1 data model → L2 event compiler → L3 MCP → L4 validator → L5 headless runtime)
and a risk register (R1, R3, ...) that source comments reference by number. **Read it before
starting a new milestone** — it records why decisions were made and which reference-repo code was
deliberately rejected.

Status: M1 / L0 done (project I/O + transaction). M2 / L1 done (data model types,
ID allocator, reference index). M3 / L2 Tier 1 done (`packages/compiler`: YAML DSL,
IR, emit, decompile — see below). M4 / L4 done (`packages/validate`: structure,
reference-integrity, and semantic/graph rules — see below). M5 / L3 done
(`packages/mcp`: MCP tool/resource layer — see below). M6 / L4.5 done
(`packages/battlesim`: headless battle simulator — see below). M6.5 done
(Tilesets/Animations/MapInfos in `upsert_database`, plus `update_system`). M7 /
L3.5 done (`packages/mapgen`: autotiles, map lifecycle, paint/passage
primitives, BSP composition — see below). M7.5 done (L2 Tier 2: the remaining
§4.3 command groups, plus `PageSpec.moveRoute` — see below). M7.6 done
(`manage_plugins`, `import_asset`, and the staged non-data writes in core they
sit on — see below). M8 / L5 done **as the plan's own R2 fallback**
(`packages/playtest`: playtest server, headless *event-layer* runtime and
scenario assertions, `AutoTest.js` — the browser half cannot be closed from
inside this repo, see below). M9 / L6 done (`packages/agent`: the repair loop as
a state machine the MCP client drives, plus the 20-bug corpus its acceptance
names — the *repair rate* needs a model this process doesn't have, see below).
M10 done (`packages/gamegen`: spec → whole playable game, plus the walkthrough
that proves it is finishable — the one-sentence-to-spec half is the MCP client's,
see below). M11 done (`deploy` + `create_project` in `packages/core`, plus the
`templates/blank-project` tree — both halves of the editor-parity table's last
two rows, minus what needs the paid editor's runtime, see below). §8.1-1 done
(namespace registry + `quest.herb.started` name sugar across core/compiler/mcp,
closing M6.5 gap #2 — see below). The nine gaps from the first end-to-end run
against a **real licensed MZ install** are closed (a boot crash, unreadable and
walk-through-able maps, no way to name a tile id, invisible NPCs, duplicated
givers, numbered namespace members, no map-level tool, no placement query) —
each one is written up where it landed, below. L2 Tier 3: the picture subset
(231/232/233/235) is delivered as `SIMPLE_COMMANDS` entries — the first
need-driven slice of §8.1-3, since pictures are how a game shows character
busts; 234 (nested tone array), 261, vehicles, 281–285 and 331–333 still ride
`RawNode`. `import_asset` additionally accepts `js/plugins` (`.js`), so a
third-party plugin can be imported and enabled by `manage_plugins` in one
session instead of dead-ending at "copy the file in by hand". §8.1-2 done
(dangling weapon/armor/skill/state/troop/actor ids off decompiled typed nodes,
plus actor→class / learnings→skill / enemy-actions→skill database rows — the
rule's first run caught the fixture's own dangling classIds, now fixed).
§8.1-4 done (`deleteFile` as core's third verb — unlink + `git add` at commit,
resurrection at rollback, create-over-delete is a replace — and `delete_map`
on top of it, refused while the starting map, a MapInfos child, or another
file's transfer still points at the map). `deploy` grew `target: "macos"`
(the game lands in `<Title>.app/Contents/Resources/app.nw`; the bundle is not
codesigned and the report says so). The §8.1-1 tail (expression language,
`!`/`&&`) remains not started.

## Commands

```bash
npm test                                       # all tests (vitest)
npx vitest run packages/core/test/session.test.ts   # one file
npx vitest run -t "rollback"                   # one test by name
npx tsc -p packages/core/tsconfig.json --noEmit      # typecheck one package
npx tsc -p packages/compiler/tsconfig.json --noEmit
npx tsc -p packages/validate/tsconfig.json --noEmit
npx tsc -p packages/battlesim/tsconfig.json --noEmit
npx tsc -p packages/mapgen/tsconfig.json --noEmit
npx tsc -p packages/playtest/tsconfig.json --noEmit
npx tsc -p packages/agent/tsconfig.json --noEmit
npx tsc -p packages/gamegen/tsconfig.json --noEmit
npx tsc -p packages/mcp/tsconfig.json --noEmit
npm run build                                  # tsc per workspace
```

No linter. CI (`.github/workflows/test.yml`) = `npm run build` + vitest on Node 20, Linux and
Windows. vitest strips types without checking them, so the typecheck rides on `npm run build`
(`tsc -p` per workspace) — a new package needs a `build` script like every other one, or its
type errors reach `master` unnoticed. Note `build` only covers each package's `src`: `test/`
is outside every tsconfig's `include` and has never been typechecked.

Tests require a working `git` binary on PATH: `packages/core/test/testProject.ts` (and each other
package's own `test/testProject.ts`, deliberately duplicated rather than cross-imported) copies
`fixtures/minimal-project` to a temp dir and `git init`s it for every test. That costs 1–2s per
test on Windows, so `vitest.config.ts` raises `testTimeout` well above the 5s default — a failure
there was queueing behind other files, not a hang. `packages/battlesim`'s tests share one copy
per file (`beforeAll`) because they never write.

## Architecture

### The transaction model (the central design decision)

Both reference MCP implementations read-modify-write a whole JSON file per tool call. This repo
does not. `ProjectSession` (`packages/core/src/session.ts`) is the only entry point:

```
openProject(path)  → reads every data/*.json into memory + snapshots mtimes
  ... N mutations, zero disk I/O ...
validate()         → mtime drift check + JSON-serializability
commit(message)    → atomic write of dirty files only, then git commit
rollback()         → re-parse from the retained original text
```

Invariant to preserve: **validation failure writes nothing**. `commit()` calls `validate()` first
and throws before touching disk, so a failed agent attempt never pollutes the project. Any new
validation belongs in `validate()`, not in `commit()`'s write loop.

Only dirty files are written. `updateFile()` marks dirty; `readFile()` must not.

`writeRaw()`/`readRaw()` (M7.6) are the same transaction for the project files that aren't
`data/*.json`: `js/plugins.js` and imported `img/`/`audio/` assets. They stage bytes keyed by a
root-relative path, `commit()` writes and git-adds them after the data files, `rollback()` drops
them. They are deliberately *not* modeled as data files — not JSON, no id-indexed structure, and
an asset is megabytes we have no reason to parse — but they must join the transaction at its two
ends, or an agent that imports an asset and then hits a validation error is left with the asset
already on disk. The path is a trust boundary (it comes from an MCP client and the whole point is
writing outside `data/`), so `resolveRawPath` rejects anything absolute or escaping the root.
Two rules elsewhere consult `rawWriteFiles()` so a staged import is visible before it lands:
`rmmz://asset-catalog` and `validate`'s asset-existence check — an agent is meant to validate
*before* deciding to commit, which is exactly when "that file doesn't exist" is guaranteed wrong.

`createFile()` (M7, the prerequisite for `create_map`) adds a file the project doesn't have. It
joins the same transaction — invisible on disk until `commit()`, dropped whole by `rollback()` —
but tracks its names in a separate `created` set, because the two ends differ: rollback has no
original text to re-parse, and the mtime snapshot has nothing to compare against, so `validate()`
substitutes "does this file exist on disk now?" for the drift check. That one is *not* gated on
`requireEditorClosed`: that option opts out of refusing on concurrent edits, not out of refusing
to destroy a file we never read. It is deliberately not an `updateFile` upsert flag — "create
Map012.json" and "edit Map012.json" want opposite things to be true of the disk.

### Assumptions isolated on purpose

- `io/format.ts` — MZ's on-disk JSON format is undocumented (risk R1). The assumption "fully
  minified `JSON.stringify`" lives in this one module so a correction against real editor output
  is a one-file change. Never inline `JSON.stringify` for data files elsewhere.
- `editorLock.ts` — MZ has no lock file (risk R3). Substitute: mtime snapshot at open, compared
  before commit; drift = refuse to write. `requireEditorClosed: false` opts out.
- `io/atomicWrite.ts` — temp file **in the same directory** + rename. Same-volume placement is
  what makes the rename atomic; do not move temp files to the system temp dir.
- `git.ts` — shells out to the `git` binary rather than depending on `simple-git`.

### L2 event compiler (`packages/compiler`)

`ir.ts` defines a tree (`Node[]`) with one variant per Tier 1 command group
(§4.3 of the plan: text, comment, if/else, choice, loop, set-switch,
set-variable, self-switch, common-event call, transfer, wait, play-SE) plus
`RawNode`, a code+parameters passthrough for anything else. `emit.ts`
(`compile`) walks the tree into a flat `EventCommand[]`, deriving `indent`
from tree depth — indent is never hand-tracked. `decompile.ts` is the exact
inverse: a recursive-descent parser over the flat list that groups by
indent+code back into the same tree, falling back to `RawNode` for any code
or operand shape (e.g. a Control Variables command with a variable operand
instead of a constant) it doesn't model. This `RawNode` fallback is what
makes decompiling an arbitrary existing project safe — nothing outside Tier 1
is ever silently dropped, only left unparsed. `RawNode.body` extends that to
unmodeled *structural* commands (Battle Processing's 301/601/602/603/604
indent their branch bodies exactly like 111/411/412): the deeper-indented run
following a raw command is absorbed as its body, so decompile never has to
throw on a shape it doesn't understand.

`dsl/` is the YAML authoring surface an LLM/human writes (plan §4.2), a Zod
schema (`schema.ts`) over a much smaller "Step" shape, `parse.ts` compiling
YAML → IR, `print.ts` decompiling IR → YAML (used to show an LLM an existing
event as text). Switch/variable fields take a raw numeric id or a
`namespace.member` name (§8.1-1, see "Namespaces and DSL name sugar" below):
names are resolved at parse time through the `DslNameResolver` the caller
hands `parseDsl`, so the IR and everything downstream stays numeric and this
package still doesn't depend on core.

**Tier 2 (M7.5)** adds the rest of §4.3's list. Most of it — 22 command groups
whose whole payload is a flat positional parameter list (gold/item/weapon/armor,
party, actor HP/MP/state/EXP/level/param/skill, labels and jumps, fades,
animation, balloon, break/exit) — is one table, `SIMPLE_COMMANDS` in `ir.ts`:
node types, emit, decompile, the Zod schema, parse and print are all *derived*
from it. Hand-writing them would have been ~600 lines encoding one fact (the
parameter order `Game_Interpreter` reads) in six places that can disagree; the
table encodes it once, and the type-level derivation (`SimpleNode`,
`SimpleFields`) is the price of not having a second, hand-maintained copy of it
in the DSL types. Anything with real structure stays hand-written: movement
routes (205 plus its 505 mirror rows), Battle Processing (301 with typed
win/escape/lose branches, so `walkNodes` in the validator sees inside them),
Shop Processing (302 + 605), Script (355 + 655) and MZ's structured Plugin
Command (357). Two details worth knowing:
- A flat command only decompiles to its typed node when the data actually has
  that shape — no extra trailing parameters, no type disagreement with the
  table. Anything else stays a `RawNode`, because the fallback's whole promise
  is that nothing is lost and a silently dropped tail is a loss.
- `MOVE_ROUTE_CODES` names all 46 `Game_Character.ROUTE_*` codes so the DSL
  reads `moveLeft`, not `code: 2` — the same reasoning §4.5 gives for the asset
  catalog. `buildMoveRoute` is exported because `upsert_map_event` writes a
  page's *autonomous* route and must produce the identical object.

Two R1-class assumptions specific to this package (undocumented MZ format,
see plan §6 R1), both isolated to `ir.ts`'s doc comments and `emit.ts`:
- Every Show Choices branch (402/403 body) always emits a trailing
  `{code:0}` filler at the branch's indent — inferred from
  `fixtures/minimal-project`, the only ground truth available; decompile
  treats the filler as optional (present or not) rather than required. The
  licensed-machine run found the editor writing that same filler at the end of
  **Conditional Branch** bodies too (report §5.3 F5), where decompile threw and
  took down `rmmz://map/{id}` for the whole map. It is now consumed wherever a
  block parser opens a body — 111/411, 112, and a RawNode's absorbed body — and
  still written back only for 402/403, since `Game_Interpreter` skips a code-0
  wherever it appears.
- `emit.ts` always writes the full canonical parameter array for a command
  (e.g. Show Choices' 5-element `[choices, cancelType, defaultType,
  positionType, background]`), even when decompiling data that had a
  shorter/older array. Round-tripping through this compiler is therefore
  idempotent (`decompile(compile(x))` is stable) but not always byte-identical
  to arbitrary pre-existing data — see `decompile.test.ts`'s fixture test.

Both of those were finally measured rather than assumed: running the compiler
over MZ's own `samplemaps` + `newdata` on a licensed machine (2498 real command
lists, report §5) put byte-identity at **97.4%**, and named every difference.
68 were the 205 mirror count — the editor writes one 505 per route *step* and
none for the trailing ROUTE_END, where this wrote one for the terminator too
and so pushed every following command a row down in the editor's event list
(report §5.4 F6, fixed). 5 were the Conditional Branch filler above, which is
now a deliberate normalization: those lists come back semantically identical,
not byte-identical. The rest is the canonical-parameter-array rule. The corpus
itself is KADOKAWA's and is **not** in this repo — `test/editorShapes.test.ts`
is a hand-written minimal reproduction of each shape, so re-measuring the
percentage needs an installed copy.

### L4 validator (`packages/validate`)

`validateProject(session)` (`src/index.ts`) runs three independent rule groups (plan §4.4) and
returns a flat `Finding[]` (`rule`, `severity`, `message`, `file`, `path?`) — no report class,
callers filter by `severity`/`rule` themselves:
- `rules/structure.ts` — reuses `@rmmz-kit/compiler`'s `decompile()` as the structural check
  (it already throws on every 111/412, 112/413, 102/402/403/404, 301/604 pairing or indent
  mistake) instead of re-deriving bracket-matching; adds only what `decompile()` deliberately
  doesn't catch (an orphan continuation — 401/408, and since M7.5 505/605/655 — and a 113 Break
  Loop outside any 112 Loop).
- `rules/references.ts` — dangling item/actor/commonEvent/map ids (via `RefIndex.entries()`,
  a small addition to core alongside making `ProjectSession.rootPath` public — both added because
  this package needed them), transfer-destination bounds, and face/character/SE asset existence
  (case-sensitive, with a separate warning for a case-only mismatch) under `img/`, `audio/se/`.
  Switches/variables aren't a bounded table in MZ (any numeric id "works"), so a referenced-but-
  unnamed switch/variable is a warning, not the error a truly dangling database id gets.
- `rules/runtime.ts` — the two ways a project that passes every other rule still fails in front of
  a player, both found by running this toolchain against a licensed install for the first time. A
  System.json field the engine dereferences with no fallback (`advanced.windowOpacity` is
  `Window_Base.updateBackOpacity`'s first read, so a missing one is a black screen before the first
  map draws; `titleCommandWindow` is worse — `Scene_Title.createCommandWindow` reads `.background`
  off it, so the *first* scene throws and the game never reaches a map; the editor writes these on
  first *save*, which is why its own `NewData` lacks them) —
  a short list of *named crashes*, not a completeness check, since core's `SystemData` is
  deliberately a subset of what MZ writes. That list and `templates/blank-project/data/System.json`
  are one fact in two places and are meant to be edited together — the licensed-machine run found
  `create_project`'s own output crashing in `Scene_Title` *while this rule reported it clean*,
  because the field was missing from both (report §8 F2/F2b); `templates/README.md` carries the
  field→call-site table. And a map on which nothing blocks movement, which is
  where a map re-pointed at a stock tileset ends up: `analyzeReachability` is structurally blind to
  it, because an all-passable map is still exactly one walkable region. That one is a *warning* —
  an open field with no walls is legal MZ, and a rule that cried wolf on those would be ignored
  wholesale, the same reasoning that kept "every event is reachable" out of this package.
- `rules/semantics.ts` — dead event pages (MZ matches pages last-to-first; a page is dead if a
  *later* page's condition set is a subset of its own), a self switch written but read by no page
  of the same event (**not** "never turned back off" — the one-way latch is the treasure-chest
  idiom, so that framing warned once per chest), unused named switches/variables, and two heuristics explicitly
  documented as heuristics in their doc comments (cross-namespace switch writes, gold/item
  decreases with no enclosing possession check).

`walk.ts` has the shared traversal: `forEachMapEvent`/`forEachCommandList` mirror `RefIndex`'s own
"scan every Map*.json + CommonEvents.json" loop; `walkNodes` recurses a decompiled `Node[]` tree
while threading Conditional-Branch guards (gold/item) through `if.then` — several rules key off
this instead of re-scanning raw command arrays.

Deliberately out of scope, not silently approximated: dangling weapon/armor/skill/state/troop/class
ids (M7.5's Tier 2 nodes now carry those ids, so the blocker is gone — but adding the rules is M4
work nobody has scheduled, not part of shipping the compiler) and a generic softlock/quest-
graph reachability engine (the plan's own namespaced-switch sugar isn't built, so "quest graph"
has no formal node/edge model to check against — see each rule file's doc comment for exactly
what's covered instead).

This is independent of `ProjectSession.validate()` (drift + JSON-serializability, gates `commit()`)
— `validateProject()` is a separate pass an agent or human runs before deciding to commit at all.

### L3 MCP tool layer (`packages/mcp`)

`server.ts`'s `createServer(session)` is the entire adapter: every `registerTool`/`registerResource`
handler is a one-line call into `tools.ts`/`resources.ts`, which hold the actual logic as plain
functions over a `ProjectSession` and are unit-tested without any MCP transport (`test/tools.test.ts`,
`test/resources.test.ts`). `test/server.test.ts` covers the wiring itself, connecting a real
`McpServer`/`Client` pair over the SDK's `InMemoryTransport` — including the plan's own M5
acceptance scenario ("在 Map001 加一個賣藥水的 NPC") end to end over the protocol. `bin.ts` is the
stdio entry point for a client like Claude Desktop: `npm run build`, then
`node packages/mcp/dist/bin.js <project-path>` (or the `rmmz-mcp` bin). This works because each
package's `exports` map defaults to `dist/` while the `rmmz-kit-source` custom condition (issue #7,
resolved) keeps dev tooling on the TS sources — see Conventions.

Grain follows plan §4.5 (12–18 tools, not the 28–35 a reference repo used): 6 read resources
(`rmmz://project/summary`, `rmmz://map/{id}`, `rmmz://database/{table}`, `rmmz://tileset/{id}`,
`rmmz://asset-catalog`, `rmmz://game-brief-guide`) plus 25 tools (`apply_script`,
`upsert_map_event`, `upsert_database`,
`update_system`, `create_map`, `resize_map`, `update_map`, `paint_tiles`, `set_tile_flags`,
`compose_map`, `find_free_rect`,
`manage_plugins`, `import_asset`, `allocate_namespace`, `validate`, `simulate_battle`, `playtest`,
`run_scenario`, `repair`, `generate_game`, `deploy`, `create_project`, `diff`, `commit`,
`rollback`). §4.5's `coverage()` is
*not* one of them: coverage with
no scenario behind it is a table of zeroes, so it rides in `run_scenario`'s report instead. `simulate_battle`
and `run_scenario` both run against the *in-memory* session, so an agent can ask "did that buff
break the boss fight?" or "does the quest still complete?" about an edit it has not committed —
`playtest` and `deploy` are the exceptions and work on what is on disk, because a browser (and a
build) reads files, not memory. `create_project` is the one tool that ignores `session` entirely:
it makes a *different* project, so the server has to be reopened against the new path to edit it.

`rmmz://game-brief-guide` (M10) is the odd resource out: the other four report what the project
*contains*, this one is prose about how to write a `generate_game` spec and what to do with each
way its report can come back unfinishable. It is a resource rather than a doc file because the
half of it that matters is generated — the actor/enemy/item ids this particular project has, for
the same reason §4.5 makes the asset catalog a resource.

`apply_script` and `upsert_map_event` are deliberately split: `upsert_map_event` is a full-replace
declarative write of one event's metadata + pages (conditions/trigger/image — nothing that makes
sense read independently); `apply_script` is the only
thing that ever writes `list`, compiling a DSL string through `@rmmz-kit/compiler`. Structure and
behavior stay separately editable this way — which is why "full replace" stops at the page's `list`:
page N inherits the list of the page N it replaced (a new page starts empty), so
`upsert_map_event` to move an NPC one tile can't silently delete its dialogue. `upsert_database` is the opposite: a shallow merge onto
whatever row already has that id (or a new row via `IdAllocator.allocEntityId`), since Actor/Item/
.../Troop fields don't have the same "only makes sense together" coupling a page's fields do — and
per-table Zod schemas for all thirteen tables is exactly the upfront modeling §4.5 says not to build
ahead of need. M6.5 added Tilesets/Animations/MapInfos to that list — flat id-indexed arrays, so
they cost one line each in `tables.ts` — with one guard: MapInfos rows may only be *edited*, never
appended, because a row with no `Map###.json` is a map the game 404s on *and* is what
`validate`'s `references/dangling-map` rule treats as proof the map exists (creating the file is
`compose_map`'s job, M7).

`manage_plugins` and `import_asset` (M7.6) are the two tools that write outside `data/`, both over
core's `writeRaw` staging. `plugins.ts` isolates the `js/plugins.js` format the way `io/format.ts`
isolates the data one (risk R1): read is `JSON.parse` over the `var $plugins = [...]` array literal
— the editor writes strict JSON there, and a file hand-edited into something `JSON.parse` rejects
is one this tool should refuse to rewrite rather than guess at — and write regenerates it one
compact entry per line, preserving whatever header the project shipped with. Patching an entry
first checks `js/plugins/<name>.js` exists, because the name is a filename an agent typed from
memory and MZ turns a missing one into a crash on boot. `assets.ts` holds `ASSET_DIRS` (shared with
the asset-catalog resource, so an import can't invent a folder any more than a reference can invent
a filename) and rejects an extension MZ won't load — `ImageManager` appends `.png` and
`AudioManager` tries `.ogg`/`.m4a` themselves, so a `.jpg` character sheet is not a warning, it is
a sprite that silently never appears. Not implemented: reordering the plugin list (load order is
append order) and removing entries — `status: false` is what "停用" means, and neither has had a
caller.

`update_map` and `rmmz://tileset/{id}` are the two surfaces the first real-project run found
missing. A map's own fields — `encounterList`/`encounterStep`, `displayName`, `bgm`, parallax — are
neither tiles nor events nor a MapInfos row, so nothing could write them and random encounters, a
whole gameplay system, had no surface at all; `update_map` shallow-merges them and refuses the four
fields that have their own tool (writing `data` would skip autotiling, writing `width` would leave
the tile array the wrong length). The tileset resource is the asset-catalog argument applied to tile
ids: producing one by hand means knowing A2 kinds start at 2816, that a kind is `base + rel*48` and
that `rel = row*8 + col` on a PNG the caller cannot see — so it lists every autotile kind's base id,
sheet, family and current flags, and each plain page's id range. Names are not listed, because the
art carries none and inventing them would be worse than silence. `find_free_rect` fronts mapgen's
`freeRects`.

Plus `update_system` for the one database file that isn't
a table: System.json is a single object, shallow-merged (nested fields like `terms` replaced whole).
`upsert_map_event`'s `PageSpec` gained `moveRoute` in M7.5 (it used to hardcode MZ's empty
default), taking the same named steps as the DSL via the compiler's `moveStep`/`buildMoveRoute`.
`update_system` deliberately does *not* reject unknown patch keys the way `upsert_map_event` does,
because core's `SystemData` is a known subset of what MZ writes (`advanced`, `itemCategories`,
`optAutosave`, …) and an allowlist would reject real fields; it returns `newFields` instead, so a
typo is visible in the tool result rather than silent. The fixture gained `Tilesets.json` (real
8192-length `flags`, since a short one is a broken map in the editor) and `Animations.json`. `ProjectSession.dirtyFiles()` (a small core addition, same pattern as `RefIndex.entries()`
for M4) backs the `diff` tool.

### L4.5 battle simulator (`packages/battlesim`)

`simulate(session, spec)` runs N battles in pure Node and returns one `BattleReport` — win rate,
turn stats, TTK per side, damage distribution, one-shot-kill and stalemate flags, plus `warnings`
that name those last two in prose. The premise (plan §3 M6) is that MZ's damage formula is an
`eval` string, so the whole of L5's cost buys nothing here: no PIXI, no browser, ~0.7s for 1000
trials.

Three files, in the order data flows through them:
- `battler.ts` — the `Game_BattlerBase`/`Game_Actor`/`Game_Enemy` subset: params from class curve
  + equipment + traits, xparams/sparams, element and state rates, state turns, regeneration.
- `action.ts` — `Game_Action`: hit/evade/crit rolls and `makeDamageValue()`. Its step order
  (element → pdr/mdr → rec → critical → variance → guard → round) is a port, not a paraphrase;
  reordering variance and guard alone moves mean damage several percent, which is most of the
  acceptance criterion's 10% budget. Formulas run through `node:vm` with only `{a, b, v, Math}`
  in scope — the string comes from a data file an agent may have just written, and MZ's own
  "any failure evaluates to 0" contract is kept. No host object crosses into that context
  (`a`/`b` are null-prototype number bags, `Math.random`/`v` are installed by a script compiled
  *inside* it), because one reachable host function is `x.constructor.constructor` away from
  the host realm.
- `simulate.ts` — the turn loop (turn-based, never TPB), the trial runner and the aggregation.

`battler.ts` and `action.ts` each carry an explicit list of what is *not* modeled (buffs/debuffs,
TP, extra **action** times, counter/reflect/substitute, dual wield) rather than approximating it
silently. That list used to say "extra action times (trait 34)", conflating two different
mechanics under one line — and the one it named the wrong code for turned out to matter: extra
**attack** times (`TRAIT_ATTACK_TIMES`, 34, `Game_Action.numRepeats` adding
`subject.attackTimesAdd()` to a normal attack) is carried by MZ's own stock Cestus, so a party
equipped from the default database swings twice and this simulator had it swinging once. That
was most of the worst divergence a real playtest found (8.10 simulated turns against 5.47 played,
report §6/§8 F8) and is now modeled. Extra *action* times is trait 61, is rare, and is still not.
The one thing that is a judgement call and not an engine port is action *selection* —
MZ leaves that to the player — so the chosen policy is heuristic and is echoed back in the
report's `policy` field, because a party that never heals loses fights a real player wins.

**M6's acceptance criterion is not met, and cannot be met from inside this repo.** The plan (§3 M6)
asks for "對 MZ 內建範例的幾組敵我配置，模擬勝率與實際遊戲測試誤差 < 10%", which needs three
things this repo does not have and cannot legally or practically acquire on its own:

1. **MZ's sample project database.** The built-in Actors/Classes/Enemies/Troops/Skills rows are
   shipped with the (paid, licensed) editor — `fixtures/minimal-project` is a hand-written minimal
   project, so its numbers are plausible, not RPG Maker's. Simulating a fixture matchup and
   comparing it to itself measures nothing.
2. **A real playtest to compare against.** The right-hand side of "誤差 < 10%" is a human (or M8's
   headless runtime, which is M8) playing those same matchups enough times for a win rate to mean
   something. There is no runtime here yet — that is precisely what M6 was scheduled *before*.
3. **Agreement on the parts MZ leaves to the player.** A win rate is a function of action policy as
   much as of damage math; a party that never heals loses fights a human wins. `BattleReport.policy`
   states the policy this simulator used, so a future comparison is at least apples-to-apples.

What is verified instead is the half that is checkable without a game, and it is the half a 10%
drift would come from: exact hand-computed damage for known params — formula evaluation, element
rate, guard division, the variance band's bounds — plus MZ's own "broken formula evaluates to 0"
contract (`test/action.test.ts`). If the ported arithmetic is right, the remaining error is policy
and unmodeled features, both listed above and in `battler.ts`.

To close it later: point `simulate()` at a real MZ project (it takes any `ProjectSession`), run the
same matchups in M8's headless runtime once that exists, and compare win rates. No change to this
package should be needed — which is why it is listed here rather than left as a TODO in code.

The fixture grew for this milestone: `fixtures/minimal-project/data/` gained Classes, Enemies,
Troops, States, Weapons and Armors (a real MZ project always has them), and Skills 1/2 became
real Attack/Guard rows because MZ hardcodes those ids in `attackSkillId()`/`guardSkillId()`.

### L3.5 maps (`packages/mapgen`)

Four files, in dependency order:

- `autotile.ts` — the deterministic half of M7 and the only module here with no judgement calls.
  An MZ tile id ≥ 2048 is `2048 + kind * 48 + shape`: only `kind` is authored, `shape` is a pure
  function of the eight neighbours, so painting means "write the kind everywhere, then derive every
  shape". The shape *numbering* is undocumented (risk R9 — a wrong shape is a visibly broken map),
  so it is derived here from MZ's own `Tilemap.FLOOR_AUTOTILE_TABLE` / `WALL_` / `WATERFALL_`
  rather than transcribed: reading off which quarter-tile each shape draws gives an enumeration
  (16 corner combinations, then one/two/three/four open edges) that the code *generates* instead of
  hardcoding 47 magic numbers. One trap is called out in a comment and pinned by a test — within a
  single-open-edge group the corners are enumerated cyclically *past* that edge, so the right-open
  group reads lower-left first and every naive "always start at upper-left" port is off by one
  there. `autotileFamily()` is the port of `_drawAutotile`'s branches (A3 and A4's upper kinds use
  the 16-shape wall table, A1's odd upper kinds the 4-shape waterfall one, everything else floor).
  A test walks all 256 neighbour configurations and asserts the shapes produced are exactly 0–46.
  The one R1/R9 assumption left is a single `Math.min/max` clamp: out-of-bounds neighbours count as
  a continuation of the edge tile, so an autotile painted to the map border draws no seam.
- `edit.ts` — `blankMap` (every field the editor writes, present with its default; an absent field
  is not "default" to MZ, it is `undefined` reaching code that never nullchecks it), `createMap`,
  `paintTiles`, `resizeMap`. `createMap` writes `Map###.json` *before* its MapInfos row, since
  `upsert_database` rightly refuses a row whose map file doesn't exist (M6.5), and allocates an id
  free on *both* sides — a null MapInfos slot whose `Map###.json` still exists is an orphan, and
  reusing that id would silently adopt its events. Painting takes a list of rectangles and rejects
  one that leaves the map: the flat index would otherwise wrap onto the next row (or next layer),
  so painting past the right edge draws on the left edge one row down. `resizeMap` never moves or
  deletes events — that is data an agent wrote deliberately — but returns the ids left out of
  bounds, and re-derives shapes afterwards because *growing* exposes old edge tiles to empty ones.
- `passage.ts` — `setTileFlags` (per-tile passability, terrain tag, star/ladder/bush/counter/damage
  over `Tilesets.json`'s 8192-entry `flags`; `upsert_database` can only write that array whole,
  which no caller can produce by hand without clobbering every other tile) and
  `analyzeReachability`, a `Game_Map.checkPassage` port flood-filling walkable regions the way a
  player walks them (a step needs both tiles to agree, so one-way cliff tiles stay one-way).
  Watch tile id 0: it is not "no tile" to MZ but the first B-sheet tile, and every stock tileset
  flags it ★ so empty upper layers abstain instead of voting "passable" — a tileset that doesn't
  reads as passable everywhere, walls included.
- `compose.ts` — BSP, not the plan's 20–30 hand-drawn prefabs. Prefabs are content authored against
  a tileset this repo doesn't ship (`fixtures/minimal-project` has no real MZ art), so a prefab
  drawn against guessed tile ids is worth less than a rectangle drawn against the caller's. BSP
  also makes the checkable half of the acceptance criterion structural rather than a repair pass:
  every room is carved inside a leaf and every internal node joins its two children with one
  L-corridor, so the walkable area is connected by construction. `analyzeReachability` then asserts
  that against the real passage flags instead of trusting the argument, and `composeMap` throws
  rather than returning a broken map (nothing is on disk yet, so a caller that rolls back loses
  nothing). A test generates 20 maps across sizes and seeds and checks each is one region.
  **Not implemented**, and not silently approximated: the plan's decoration rules (furniture against
  walls, doorways kept clear) and the "looks hand-made ≥ 70%" half of acceptance — both need a real
  tileset's B–E tiles to place, and both are judgement, not algorithm.

`upsert_database` gained one table-specific default alongside this (`NEW_ROW_DEFAULTS` in
`tables.ts`), closing M6.5's review gap #1: an appended Tilesets row now gets the 8192-long `flags`
array `Game_Map.checkPassage` indexes, instead of crashing the game on the player's first step.
The list is deliberately near-empty — per-table schemas are the upfront modeling §4.5 says not to
build, so an entry has to earn its place by naming a crash.

`freeRects` sits next to `analyzeReachability` in `passage.ts` and is the whole of what this
package does for decoration: "give me N non-overlapping w×h rects where every tile is walkable and
no event stands". Prefabs still don't belong here (the reasoning above holds), but a caller laying
out a village by hand has to ask that question somehow, and the two things they would otherwise
guess at — an event's tile, a wall — are exactly the ones that seal a room off. It answers "the
space was free", not "filling it in is safe"; `analyzeReachability` is still what proves the second.

Deliberately out of scope: an "every event is reachable" *validator* rule. `analyzeReachability`
exports the machinery and `compose_map` uses it, but running it over hand-made maps warns on
things that are fine (parallel-process events parked at 0,0, decoration events on impassable
tiles), and a validator that cries wolf gets ignored wholesale. (What *is* a rule, since it needs
no such judgement: a map where nothing at all blocks movement — see `validate`'s `rules/runtime.ts`.)

### L5 playtest and headless testing (`packages/playtest`)

**M8 is delivered as the plan's own R2 fallback — "只跑事件層測試、不跑畫面" — and the trigger
was not a timebox overrun but arithmetic: MZ's runtime (`js/rmmz_*.js`, PIXI, the scene graph)
ships with the paid editor, so `fixtures/minimal-project` has no game to boot.** Every row of §3
M8's known-traps table (swiftshader, WebAudio stubs, rAF vs logical frames, TPB determinism) is a
trap you hit *while running MZ*; none of them can be hit, or fixed, or even reproduced here. What
is buildable and checkable from inside this repo is the layer under them — the interpreter's
command semantics — and that is where the assertions a generated quest fails would live anyway
(§4.6 already argues for driving the state machine instead of the UI).

Four modules plus one plugin, in the order data flows:

- `server.ts` — the front-half deliverable (§3 M8's first week): `node:http` over the project
  root, which is the editor's Playtest button's equivalent. MZ's `index.html` `fetch`es
  `data/*.json`, so `file://` fails CORS and a server is the entire requirement; the plan named
  `serve-handler` because the reference repo already had it, and one directory is not worth a
  dependency. The traversal guard is a `path.relative` containment test, not a `..` filter —
  this serves a whole project directory, including whatever else lives under it.
- `state.ts` — the slice of game state event commands read and write: switches, variables, self
  switches, inventory (three id spaces behind one prefixed key), party, player position, shown
  messages. HP/MP/states are deliberately absent: `@rmmz-kit/battlesim` already models them
  properly, and a second half-model would just disagree with the first.
- `interpreter.ts` — `Game_Interpreter`'s semantics over the L2 *tree* (`decompile()`), not over
  the flat list MZ walks. MZ tracks `_indent` and skips branches by scanning forward; the tree
  already encodes that, correctly, in both directions since M3/M7.5, so branches and loops are
  plain recursion here and there is no second indent-matcher to keep in sync — the same reuse
  `@rmmz-kit/validate`'s structure rule makes. Page selection is MZ's own last-to-first condition
  match. Two things MZ leaves to a human are answered from a queue and echoed in the report rather
  than guessed silently: Show Choices answers, and Battle Processing outcomes (which branch ran,
  not who won — damage math is `simulate_battle`'s job). Everything the layer does not model
  (Script, Set Movement Route, Shop, script-typed conditions, battler-state commands) increments
  `unmodeled` instead of being skipped quietly, because **a green scenario with a non-empty
  `unmodeled` proved less than it looks** — that counter is the difference between a fallback and
  a fake. Plugin commands are recorded, not run, so a project whose rewards go through a plugin
  can still be asserted on. A runaway loop hits a command budget and throws, which is the one
  softlock class this layer genuinely catches.
- `scenario.ts` — the agent-facing surface: a scenario is *data* (steps + assertions), and the
  report says which check failed with expected/actual, what was shown, the final state and the
  coverage. That shape is chosen for M9's repair loop, which needs a failure trajectory rather
  than a test runner's stdout. A step that *throws* stops the run (every later assertion would be
  about a game that never got there); a failed *assertion* does not.
- `AutoTest.js` (package root, not `src/`) — the injected MZ plugin from §3 M8, exposing
  `window.__AT` with the plan's API (`teleport` / `runEvent` / `setSwitch` / `dumpState` / `seed` /
  `step` / `waitIdle` / `captureMessages` / `coverage`), plus `newGame` and `answerChoice` — the two
  things a driver otherwise cannot reach, since the title screen and the choice window both want
  input synthesised into a canvas. It lives at the package root because
  `src/autotest.ts` and the built `dist/autotest.js` are both exactly one directory below it, so
  `new URL('../AutoTest.js', import.meta.url)` resolves in both and no build step has to copy an
  asset. `playtest`'s `install-autotest` action stages it plus its `js/plugins.js` entry through
  the same transaction as everything else.

  Two things about it are not style choices but the difference between working
  and silently doing nothing, both found by driving a licensed install over CDP (report §8 F3/F4):
  - `step()` and `waitIdle()` force `SceneManager.isGameActive` true for their duration (saved,
    overridden, restored in `finally`, exactly as `Window_Message.isTriggered` already was). The
    real one is `document.hasFocus()`, and `updateScene()` skips `_scene.update()` when it is
    false — so under any driver, in any background tab, every frame was a no-op: the frame counter
    climbed, the interpreter did not move, and `waitIdle` could only ever return its timeout.
  - **`waitIdle()` is async** and yields a macrotask per frame, so `DataManager.loadMapData`'s
    fetch can resolve; a synchronous loop times out on every cross-map transfer. It yields through
    `MessageChannel`, **not** `setTimeout`, because a background tab clamps timers to about a
    second and a 600-frame wait would take ten minutes to report a timeout it reached immediately.
    A test asserts the source contains no `setTimeout(` for this reason.

Coverage (§4.5's `coverage()`) is folded into the scenario report rather than being its own tool,
and it is counted over *every* command list in the project, not only the ones a scenario touched —
"which quests has nobody tested" is the question worth asking. A list `decompile()` refuses is
named in `unparsed` instead of being scored 0%: that is a structural bug `validate` reports
properly, and burying it in a percentage hides it. The fixture's own EV001 is such a list (a Break
Loop at the Loop's own indent), which is why the tests assert it by name.

**Acceptance, honestly split.** The measurable half is met: the plan's three-event herb chain runs
green on the fixture in ~1 ms (`test/scenario.test.ts`; the seconds in the test output are the
per-test fixture copy + `git init`, not the run). The half that needs a real game is not met and
cannot be from here — no browser is driven, no frame is rendered, and there is no Playwright
dependency, because a driver with nothing to drive is scaffolding. `AutoTest.js` is verified only
against stubs in `test/autotest.test.ts`: that catches the failure mode an injected plugin actually
has (a typo or renamed member taking the game down on boot) and proves nothing about behaviour
against a real `Game_Map`.

That last sentence was demonstrated the hard way. The plugin *was* driven against a licensed
install over CDP, and the stub suite had been green the whole time while two bugs made it
useless in the only environment it exists for: no `isGameActive` override, and a synchronous
`waitIdle` (F3/F4 above, both fixed). Neither is reachable from a stub, because a stub has no
`updateScene` to skip the frame and no fetch to starve. So the browser half of M8 is now
*demonstrated* rather than only designed — a driver can boot the game, start it, run events and
read state back — while what is still unverified here is everything a scenario asserts *about a
real* `Game_Map`, and it stays that way until a licensed project is in CI.

To close the rest, on a real licensed project: `playtest` → `install-autotest` → `commit` → point
Playwright (or CDP, which is what the verification run used, with no new dependency) at the URL and
call `window.__AT` over `page.evaluate` — `await` `waitIdle`. The assertion vocabulary and the
report shape are already the ones `run_scenario` uses, so what is missing is the transport, not the
test model. Nothing in this package should need to change — which is why this is written here
rather than left as a TODO in code.

### L6 repair loop (`packages/agent`)

**The generator is not in this package, and cannot be.** Plan §3 M9's pipeline is
`plan → generate(DSL) → compile → validate → …`, and the thing that turns feedback back into a
DSL is an LLM — which in this architecture *is the MCP client*. So the loop is written as a state
machine the client drives (`RepairLoop.start()` / `.check()`, exposed as the `repair` tool), with
`runRepairLoop(session, spec, generate)` as the callback-shaped convenience for programmatic
callers and tests. `start()` snapshots what is already failing so a generator writes its first
draft against reality; each `check()` grades whatever is in the session as one attempt and returns
either the feedback to act on or a verdict (`converged` / `exhausted` / `oscillating`).

Two files. `loop.ts` is the state machine and the plan's 必要配套; `feedback.ts` is the part §3 M9
names as the determining variable for repair rate (「錯誤訊息品質是修復率的決定變數，投資在這裡比
投資在 prompt 上划算」) and is the only place in the package where formatting detail is the point.
What it adds over dumping `Finding[]` + `ScenarioReport[]`, each of which costs an attempt when
missing: the **edit address** (a finding's `path` is `event 3 > page 1 > …`, but the agent edits
through `apply_script`, which takes map/event/page), the **trajectory** (which distinguishes "the
switch was never set" from "the event never ran", two causes with opposite fixes), and the **state
diff against the previous attempt** — including the single most useful line in the report, *your
last edit changed nothing this scenario reads*, which is the signal that comes one attempt before
oscillation.

Three deviations from the plan's sketch, all forced by this repo's own architecture:

- **No "commit to a temp branch, then playtest".** `run_scenario` runs against the *in-memory*
  session (M8's decision), so the dynamic gate needs no commit. The loop commits exactly once, on
  convergence — which is also why there is **no `git reset` on failure**: a failed attempt never
  wrote anything. It deliberately does not call `session.rollback()` either, because that drops
  *every* in-memory change since the last commit, including edits made before the loop started.
- **Branch isolation is optional** (`spec.branch`), not mandatory. R4's "oscillation ruins the
  project" is already answered by committing only on convergence; the branch is for keeping a
  converged-but-unreviewed result off the main line, a different concern.
- **Pre-existing findings are excused.** `start()` snapshots the validator's output and only *new*
  blocking findings fail an attempt. A real project always carries some lint noise (the fixture's
  own EV001 is structurally broken), and a loop that blames the generator for it spends all three
  attempts on someone else's bug. Scenario failures get no such amnesty — the suite *is* the spec.

Oscillation detection is one `Map<signature, attempt>`: if this attempt's failure set was already
seen, the loop stops and escalates. That covers A/B/A alternation and the stuck-in-place case with
one rule, which is why it isn't the "same test flips between A and B" matcher the plan describes.
The signature includes each finding's *message*, because one rule firing on two different ids is
two different bugs and collapsing them would report a converging loop as oscillating.

**Acceptance, honestly split** — the same shape as M6 and M8. The 20 injected bugs are built and
checked in (`test/bugs.test.ts`: 10 static, one per error-severity rule the validator has; 10
dynamic, each breaking M8's herb quest a different way, including the runaway-loop softlock). Every
one is invisible to `tsc` and to `ProjectSession.validate()`, every one is caught, and the test
asserts the feedback names the *cause* in the agent's own vocabulary — not that "something failed".
The **repair rate** (「≥ 靜態 8/10、動態 4/10」) is *not* measured, because repairing means
regenerating and there is no model in this test process; wiring one in would measure that model on
that day, not this package. To close it: point `runRepairLoop`'s `generate` at a real model, run the
same table, count. Nothing in `src/` needs to change.

### Lv9 end-to-end (`packages/gamegen`)

M10 is「一句話 → 30-60 分鐘可玩小 RPG」, and §3 M10 says up front that it is 編排與 prompt 工程,
not new architecture. It is split the way every model-shaped milestone in this repo is split: the
**plan** — which places exist, who wants what, what the boss is — needs a model, and in this
architecture the model is the MCP client; everything downstream of the plan is deterministic and
lives here.

The contract between the two is `GameSpec` (`spec.ts`), a Zod schema whose every field carries a
`.describe()` because **that schema is the prompt** — the same argument §4.5 makes for the asset
catalog and `server.ts` makes for the scenario step union. `GameSpecSchema.shape` is spread
directly into `generate_game`'s `inputSchema`, so there is exactly one copy of it.

Four files, in the order a call moves through them:

- `spec.ts` — the schema, plus `checkSpec()`: the ways a spec describes a game nobody could
  finish, caught before a file is touched. A cycle in `requires` (neither quest can ever be
  offered), an area no `connects` reaches (everything in it is unreachable), a dangling key.
  `questOrder()` topologically sorts the quests, which is both the order the gates unlock in and
  the order the walkthrough plays.
- `build.ts` — spec → project, deterministically: one `composeMap` per area (M7 gives connectivity
  by construction, so nothing here re-checks the inside of a map), a two-way portal pair per
  `connects` edge, one giver event per NPC + a two-page objective per quest, and a gated finale.
  Three details worth knowing. **Placement is an allocator, not a formula** (`Placer`): two events on one
  tile is legal MZ and always a bug, so tiles are handed out room-by-room, middle-first, and each
  one reserves its four neighbours. That last part is not tidiness — a generated event is
  `priorityType: 1`, so middle-first on its own packs them into a solid blob whose inner tiles no
  player can step beside, and with the arrival tile first in line four events in the starting room
  boxed the player in on frame one. Nothing downstream catches it: the walkthrough drives events
  with `runEvent` and never walks. **The unconditional page must be
  page 1**: MZ matches pages last-to-first, so an unconditional page anywhere else kills every page
  above it, which `validate`'s `semantics/dead-event-page` reports as an error. **A giver is one
  event with one page, and its quest state machine is branches, not pages.** Three pages per quest
  is the natural MZ idiom for *one* quest and has no answer for two: two quests keyed to the same
  `(area, name)` are one person, and their page sets concatenated either shadow each other (which
  the dead-page rule correctly calls an error) or need a gate invented between them. The branch
  chain — `if quest 1 done → acknowledge and fall through, else → offer/remind/take it and stop`,
  in `questOrder` — says the same thing without either problem, and an NPC who offers their next
  quest in the same breath is why the walkthrough answers "not now" after a turn-in.
- `walkthrough.ts` — the build's own regression suite, derived from the *spec* and not from the
  events that were emitted. That is the whole point: a walkthrough read back out of the generated
  data would agree with it by construction and prove nothing. Two scenarios, because "finishable"
  and "not skippable" are different claims — `walkthrough` plays start to finish and asserts the
  clear switch comes on; `gates` asserts every lock is still locked at the start (the finale
  refuses, a gated giver refuses, and every objective event is inert — `activePage: 0` — until its
  quest is running). Item counts are asserted against a running ledger rather than `>= 1`, because
  a reward paid twice is exactly what a `gte` assertion is blind to.
- `generate.ts` — the orchestration: `checkSpec` → `buildGame` → `validate` (L4) → `simulate` (L4.5)
  → `runScenario` (L5). The three gates catch three different failures and none subsumes another —
  and the battle gate is the one worth arguing for: `run_scenario` is *told* the outcome of a
  battle, so a boss the party loses to every time is invisible to the event layer and is a wall.
  Pre-existing validator findings are excused against a baseline taken before the build, for the
  reason M9's loop takes one. Nothing is committed: every write went through `ProjectSession`, so
  a caller who doesn't like the report rolls back and the project never saw it.

Deliberately not done: decoration, and any notion of *pacing* or *story*. The generator arranges
content; it never invents an enemy, because designing one is a balance question `simulate_battle`
answers — and by the same rule it never invents *art*: `sprite`/`portalSprite`/`tilesetId` name what
the project already has (`rmmz://asset-catalog`, `rmmz://tileset/{id}`), and an area with no
`tilesetId` keeps `blankMap`'s tileset 1, which in a stock project is Overworld and draws the walls
this generator paints as nothing.

**Acceptance, honestly split** — the same shape as M6, M8 and M9. The plan asks for「連續 10 次生成，
≥ 6 次可完整通關且不卡關」. `test/generate.test.ts` runs ten different games back to back — the area
count, quest count, objective kinds and prerequisite chain all vary — and asserts **10/10**, not
6/10, because the generator under test is deterministic; the plan's 6/10 budgets for a model
writing the spec, and there is no model in this process. What is therefore *not* measured is
whether a model turns an arbitrary English sentence into a spec worth generating, and whether the
result is *fun* — `checkSpec` and the walkthrough between them prove a player can reach the end,
not that they would want to. To close it: point a model at `rmmz://game-brief-guide`, give it ten
briefs, and count how many of the resulting specs come back `ok`. Nothing in `src/` needs to change.

The suite's teeth are pinned by their own test rather than assumed: breaking the turn-in (dropping
the giver's `setSwitch done`, the most common generated-quest bug there is) must make the
walkthrough fail and name that switch.

### M11 deploy and project creation (`packages/core`)

The plan's last two editor-parity rows. Both live in **core**, not a package of their own: the
plan itself says M11「只依賴 L0/L1」, and both are exactly that — copy a directory tree, minus what
the destination shouldn't have. A package here maps to a *layer*, and neither of these is one; a
sixth `tsconfig`, `exports` map and CI step would buy nothing.

- `deploy.ts` — `deployProject(rootPath, { outDir, target, excludeUnusedAssets, nwPath })`. Takes a
  **path, not a session**, the same choice `playtest` makes and for the same reason: what ships is
  what is on disk, and a build assembled out of a session's uncommitted memory matches no commit.
  The MCP tool names `dirtyFiles()` in the report instead, so the caller commits and deploys again.
  Excluded from every build: `Game.rmmzproject` (a leaked build should not reopen as a project),
  `save/` and `*.rmmzsave` (the developer's playthrough is not the player's), `.git`/`node_modules`.
  A build containing `js/plugins/AutoTest.js` gets a warning — M8's automation hooks let anyone
  drive the shipped game.
  - **Pruning does not use `RefIndex`, which §3 M11 names.** `RefIndex` indexes numeric *ids*
    (switch 7, Map012) found in event commands; asset references are strings, and most of them live
    outside events entirely — an actor's `faceName`, a tileset's `tilesetNames`, System's title
    screen and its 24 SEs. Teaching it string kinds means enumerating every asset-bearing field of
    every table, which is the per-table modeling §4.5 says not to build. So the collector is blunt
    on purpose: **every string in every `data/*.json`**, and an asset survives if its
    extension-stripped basename matches one (case-insensitively). It over-keeps — an item named
    "Slime" keeps `img/enemies/Slime.png` — and that is the correct direction to be wrong in. A
    kept-but-unused file is a few KB; a pruned-but-used one is a sprite that silently fails to load
    in front of a player, in a build nobody plays before release. Same reasoning for the two
    escapes: `img/system/` is never pruned (MZ hardcodes IconSet/Window/Balloon, so no data file
    mentions them), and `js/plugins.js` is scanned as loose tokens because plugin parameters are
    free-form text. A `data/*.json` that won't parse aborts the deploy rather than pruning against
    a half-known reference set.
  - `target: 'windows'` is the plan's「NW.js 殼複製」and nothing more: copy the caller's unpacked
    NW.js distribution, put the web bundle in `www/`, rename `nw.exe` to the game title, write the
    `package.json` NW.js reads for its entry point. `nwPath` is required — this repo does not ship
    or download a browser runtime, the same wall M8 hit with MZ's own.
- `createProject.ts` — `createProject(target, { title, templatePath, runtimeFrom })`: copy the
  template, set the title, `git init` + one baseline commit (every other tool here assumes a repo;
  a git failure warns instead of discarding a project that is complete on disk).
- `templates/blank-project/` — a checked-in tree, not code that builds one. It is data, so "change
  the default currency unit" should be a JSON edit. It is deliberately **not** `fixtures/
  minimal-project`: the fixture is minimal on purpose (a 4-field System.json, an event whose
  command list is structurally broken so the validator has something to catch), none of which
  belongs in a project someone is about to work in. Its System.json is reconstructed from the field
  list in `types/mz.ts`, and every asset-name field in it — `title1Name`, all 24 `sounds`, every
  vehicle — is **empty rather than a plausible default filename**, because this repo ships no art
  or audio and a plausible name would be a dangling reference the validator is right to report.
  Reconstructing from `types/mz.ts` is also how the file came to be missing `titleCommandWindow`
  until a licensed machine booted the result (report §8 F2): the type is a *subset* of what MZ
  writes, so the template's real job is carrying the fields **outside** it that the engine
  dereferences with no guard. `templates/README.md` is that list, with a call site per field, and
  `validate`'s `REQUIRED_SYSTEM_FIELDS` is its executable half — add a field to one and the other.

**Acceptance, honestly split** — the same shape as M6, M8, M9 and M10. The plan asks that the
deployed web bundle 「可在瀏覽器完整遊玩」 and that the created project 「編輯器可直接開啟」. Neither
right-hand side exists here: `js/rmmz_*.js` and the editor are both paid, so there is no game to
play through and no editor to open anything. What *is* checked is the half that doesn't need them,
and it is the half a broken build would come from: a created project opens with `openProject` and
comes back **clean from `validateProject` with zero errors** (`packages/mcp/test/deploy.test.ts`),
and a bundle deployed from it is served over the playtest HTTP server and its `data/System.json`
fetched back with the right title, with `Game.rmmzproject` 404ing (same file). Pruning is pinned
from both ends — a referenced face survives, an unreferenced one and an unreferenced SE do not, an
`img/system/` file survives being referenced by nothing, and a filename that appears only as a bare
positional parameter of a Show Picture command survives (that case is what a keyed-fields-only
collector would delete). To close the rest: run `create_project --runtimeFrom <an installed
project>` on a licensed machine, open the result in the editor, then `deploy` it and play it.
Nothing in `src/` should need to change.

### Namespaces and DSL name sugar (§8.1-1)

Plan §8's top-ranked gap, one feature in three halves:

- `packages/core/src/namespaces.ts` — `NamespaceRegistry`, the allocator's own
  occupancy record, closing M6.5 gap #2. It is a *data file*
  (`data/RmmzKitNamespaces.json`) so it rides the ProjectSession transaction
  unchanged — commit/rollback/drift all just work, and MZ ignores unknown
  files under `data/` (plugins park their own JSON there routinely).
  System.json's name arrays are still written (`quest.herb.started`) but they
  are a mirror for a human skimming the editor, not the record: `update_system`
  replaces those arrays whole, and before the registry that made every
  allocated id look free again. A slot is free only when it is unnamed *and*
  unregistered, so a hand-named editor switch still counts as taken. `deploy`
  excludes the file from builds for the reason it excludes `Game.rmmzproject`:
  dev metadata, and it names every quest flag.
- `allocate_namespace` takes member *names* (`switches: ["started", "done"]`)
  as well as counts (members "0".."n-1") and returns member→id. Members may
  not contain `.`, so `namespace.member` splits unambiguously at the last dot.
  Re-allocating a member the namespace already owns is refused (naming the
  existing ids) rather than served: the registry keeps one id per member, so a
  second allocation would leave the first named in System.json but unregistered
  — free again the moment `update_system` replaces the names array, which is
  gap #2 reopened on an id live events already reference.
- Resolution happens at the edges, never in the middle: `parseDsl` takes a
  `DslNameResolver`, `printDsl` the inverse `DslNameLookup` (so
  `rmmz://map/{id}`'s decompiled scripts read `quest.herb.started`, not `11`),
  and `apply_script` / `upsert_map_event`'s page conditions
  (`switch1Id`/`switch2Id`/`variableId`) wire both to the registry.
  `rmmz://project/summary` lists the namespaces — the asset-catalog argument:
  a model that can see what names exist doesn't invent ones that don't. An
  unknown name (or a named id with no resolver) is an error that names what
  *is* known, never a silent switch NaN/0.

Deliberately not done: names in `run_scenario` steps (the scenario comes from
the same client that just allocated the ids; add when a caller wants it), the
plan's full `when: "!quest.herb.started"` expression language (`!`/`&&` — this
resolver is the layer it would compile against), and §4.4's quest-graph rules
(unblocked by the namespace model, but they are M4 work nobody has scheduled).

### Legacy JS carried over

`packages/core/src/errors.js` and `logger.js` are lifted from a reference repo. They are **not**
exported from `index.ts` and nothing imports them; `checkJs` is off. Treat them as a parts bin,
not as the project's conventions — new code is TypeScript and throws plain `Error`s.

## Conventions

- ESM, `NodeNext` resolution: relative imports carry the `.js` extension even in TS sources.
- Workspace packages carry an `exports` map with two faces: the `rmmz-kit-source` custom
  condition resolves to `src/index.ts` (activated by `customConditions` in `tsconfig.base.json`
  and `resolve.conditions` in `vitest.config.ts`, so typecheck/tests need no build step), while
  the `default` condition resolves to `dist/index.js` so plain Node can run compiled output —
  the `rmmz-mcp` bin depends on this (issue #7). New packages must copy the same `exports` shape.
- New packages go under `packages/<name>/` following the layout in plan §1.2, with tests in
  `packages/<name>/test/*.test.ts` (the glob `vitest.config.ts` picks up).
- Comments explain *why*, especially where an assumption or a rejected alternative is involved;
  the existing files are the reference for the expected density.
