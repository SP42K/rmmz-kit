# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`rmmz-kit` — a monorepo toolchain for automating RPG Maker MZ projects (edit `data/*.json`,
compile events, validate, headless-test). Not an MCP server: MCP is planned as a thin adapter
over the core library, so the value lives in `packages/core` and future compiler/validator packages.

The full roadmap is `docs/rmmz-automation-implementation-plan.md` (Chinese). It defines the layer
naming (L0 I/O → L1 data model → L2 event compiler → L3 MCP → L4 validator → L5 headless runtime)
and a risk register (R1, R3, ...) that source comments reference by number. **Read it before
starting a new milestone** — it records why decisions were made and which reference-repo code was
deliberately rejected.

Status: M1 / L0 done (project I/O + transaction). L1 onward not started.

## Commands

```bash
npm test                                       # all tests (vitest)
npx vitest run packages/core/test/session.test.ts   # one file
npx vitest run -t "rollback"                   # one test by name
npx tsc -p packages/core/tsconfig.json --noEmit # typecheck (what CI runs)
npm run build                                  # tsc per workspace
```

No linter. CI (`.github/workflows/test.yml`) = typecheck + vitest on Node 20.

Tests require a working `git` binary on PATH: `packages/core/test/testProject.ts` copies
`fixtures/minimal-project` to a temp dir and `git init`s it for every test.

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
