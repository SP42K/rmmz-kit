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
inside this repo, see below). L2 Tier 3 and everything from M9 onward not
started.

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
npx tsc -p packages/mcp/tsconfig.json --noEmit
npm run build                                  # tsc per workspace
```

No linter. CI (`.github/workflows/test.yml`) = one typecheck per package + vitest on Node 20.
vitest strips types without checking them, so a new package must add its own `tsc` step there
or its type errors reach `master` unnoticed.

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
event as text). The DSL addresses switches/variables by raw numeric id —
the plan's namespaced expression sugar (`quest.herb.started`) is a
`IdAllocator`-aware layer that would sit on top of this and is not built yet.

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
  treats the filler as optional (present or not) rather than required.
- `emit.ts` always writes the full canonical parameter array for a command
  (e.g. Show Choices' 5-element `[choices, cancelType, defaultType,
  positionType, background]`), even when decompiling data that had a
  shorter/older array. Round-tripping through this compiler is therefore
  idempotent (`decompile(compile(x))` is stable) but not always byte-identical
  to arbitrary pre-existing data — see `decompile.test.ts`'s fixture test.

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

Grain follows plan §4.5 (12–18 tools, not the 28–35 a reference repo used): 4 read resources
(`rmmz://project/summary`, `rmmz://map/{id}`, `rmmz://database/{table}`, `rmmz://asset-catalog`)
plus 19 tools (`apply_script`, `upsert_map_event`, `upsert_database`, `update_system`,
`create_map`, `resize_map`, `paint_tiles`, `set_tile_flags`, `compose_map`, `manage_plugins`,
`import_asset`, `allocate_namespace`, `validate`, `simulate_battle`, `playtest`, `run_scenario`,
`diff`, `commit`, `rollback`). §4.5's `coverage()` is *not* a twentieth: coverage with no scenario
behind it is a table of zeroes, so it rides in `run_scenario`'s report instead. `simulate_battle`
and `run_scenario` both run against the *in-memory* session, so an agent can ask "did that buff
break the boss fight?" or "does the quest still complete?" about an edit it has not committed —
`playtest` is the exception and serves what is on disk, because a browser reads files, not memory.

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
TP, extra action times, counter/reflect/substitute, dual wield) rather than approximating it
silently. The one thing that is a judgement call and not an engine port is action *selection* —
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

Deliberately out of scope: an "every event is reachable" *validator* rule. `analyzeReachability`
exports the machinery and `compose_map` uses it, but running it over hand-made maps warns on
things that are fine (parallel-process events parked at 0,0, decoration events on impassable
tiles), and a validator that cries wolf gets ignored wholesale.

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
  `step` / `waitIdle` / `captureMessages` / `coverage`). It lives at the package root because
  `src/autotest.ts` and the built `dist/autotest.js` are both exactly one directory below it, so
  `new URL('../AutoTest.js', import.meta.url)` resolves in both and no build step has to copy an
  asset. `playtest`'s `install-autotest` action stages it plus its `js/plugins.js` entry through
  the same transaction as everything else.

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

To close it later, on a real licensed project: `playtest` → `install-autotest` → `commit` → point
Playwright at the URL and call `window.__AT` over `page.evaluate`. The assertion vocabulary and the
report shape are already the ones `run_scenario` uses, so what is missing is the transport, not the
test model. Nothing in this package should need to change — which is why this is written here
rather than left as a TODO in code.

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
