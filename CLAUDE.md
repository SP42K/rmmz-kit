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
(`packages/battlesim`: headless battle simulator — see below). L2 Tier 2/3 and
everything from M7 onward not started.

## Commands

```bash
npm test                                       # all tests (vitest)
npx vitest run packages/core/test/session.test.ts   # one file
npx vitest run -t "rollback"                   # one test by name
npx tsc -p packages/core/tsconfig.json --noEmit      # typecheck one package
npx tsc -p packages/compiler/tsconfig.json --noEmit
npx tsc -p packages/validate/tsconfig.json --noEmit
npx tsc -p packages/battlesim/tsconfig.json --noEmit
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
  (it already throws on every 111/412, 112/413, 102/402/403/404 pairing or indent mistake) instead
  of re-deriving bracket-matching; adds only what `decompile()` deliberately doesn't catch (an
  orphan 401/408 continuation, a 113 Break Loop outside any 112 Loop).
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
ids (would need Tier 2/3 command support this repo doesn't have yet) and a generic softlock/quest-
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
intended stdio entry point for a client like Claude Desktop, but **it does not run yet**: the
`rmmz-mcp` bin points at `dist/bin.js`, and the compiled output resolves `@rmmz-kit/core` to
`src/session.js` because workspace `main` fields point at TypeScript sources (the "no build step
to consume a workspace package" convention above). Making the binary work means `exports` maps
with a custom condition on all four packages plus `customConditions` in `tsconfig.base.json` —
deliberately not done (issue #7 holds the open decision), so for now the server is only reachable
in-process via `createServer()`.

Grain follows plan §4.5 (12–18 tools, not the 28–35 a reference repo used): 4 read resources
(`rmmz://project/summary`, `rmmz://map/{id}`, `rmmz://database/{table}`, `rmmz://asset-catalog`)
plus 9 tools (`apply_script`, `upsert_map_event`, `upsert_database`, `allocate_namespace`,
`validate`, `simulate_battle`, `diff`, `commit`, `rollback`). §4.5 also lists `compose_map`,
`playtest`, and `coverage` — omitted here because they front L3.5/L5 (M7/M8), which
don't exist in this repo yet; adding tool stubs for layers with nothing behind them would violate
decision A (MCP is a thin transport over real logic, not the other way around). `simulate_battle`
runs against the *in-memory* session, so an agent can ask "did that buff break the boss fight?"
about an edit it has not committed.

`apply_script` and `upsert_map_event` are deliberately split: `upsert_map_event` is a full-replace
declarative write of one event's metadata + pages (conditions/trigger/image — nothing that makes
sense read independently); `apply_script` is the only
thing that ever writes `list`, compiling a DSL string through `@rmmz-kit/compiler`. Structure and
behavior stay separately editable this way — which is why "full replace" stops at the page's `list`:
page N inherits the list of the page N it replaced (a new page starts empty), so
`upsert_map_event` to move an NPC one tile can't silently delete its dialogue. `upsert_database` is the opposite: a shallow merge onto
whatever row already has that id (or a new row via `IdAllocator.allocEntityId`), since Actor/Item/
.../Troop fields don't have the same "only makes sense together" coupling a page's fields do — and
per-table Zod schemas for all ten tables is exactly the upfront modeling §4.5 says not to build
ahead of need. `ProjectSession.dirtyFiles()` (a small core addition, same pattern as `RefIndex.entries()`
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
  "any failure evaluates to 0" contract is kept.
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

### Legacy JS carried over

`packages/core/src/errors.js` and `logger.js` are lifted from a reference repo. They are **not**
exported from `index.ts` and nothing imports them; `checkJs` is off. Treat them as a parts bin,
not as the project's conventions — new code is TypeScript and throws plain `Error`s.

## Conventions

- ESM, `NodeNext` resolution: relative imports carry the `.js` extension even in TS sources.
- Workspace packages resolve via `main`/`types` pointing straight at `src/index.ts` — no build
  step is needed to consume `@rmmz-kit/core` from another package or from tests.
- New packages go under `packages/<name>/` following the layout in plan §1.2, with tests in
  `packages/<name>/test/*.test.ts` (the glob `vitest.config.ts` picks up).
- Comments explain *why*, especially where an assumption or a rejected alternative is involved;
  the existing files are the reference for the expected density.
