# demo/

A single self-contained HTML page that generates a game with the toolchain and
then lets you walk around it in a browser.

It exists because the obvious way to demo this repo — `playtest` → open the game
— cannot work here: MZ's runtime (`js/rmmz_*.js`, PIXI, the scene graph) ships
with the paid editor, so `fixtures/minimal-project` has no game to boot. That is
the same wall `packages/playtest`'s own header describes, and the answer is the
same one M8 took: **drive the event layer, not the screen**. The page runs
`packages/playtest`'s `Interpreter` — the real one, bundled for the browser —
over a project `packages/gamegen` produced, and draws the passability grid
`packages/mapgen` computed instead of tiles it has no art for.

Nothing here is a second implementation of anything. That is the point: a demo
whose renderer disagrees with the toolchain it demonstrates is worse than no
demo. Every fact on the page — walkability, page conditions, quest gating,
win rates, scenario verdicts — comes from the package that owns it.

## Build it

```bash
npm install && npm run build

# 1. spec → project + report. Writes nothing to disk: the whole build happens in
#    a ProjectSession and is read back out of memory.
node demo/generate-demo.mjs /tmp/game.json

# 2. the interpreter, bundled for the browser (see browser-entry.js for why the
#    imports reach past the package barrel, and core-shim.js for the alias).
npx esbuild demo/browser-entry.js --bundle --format=iife --platform=browser \
  --minify --alias:@rmmz-kit/core=./demo/core-shim.js --outfile=/tmp/runtime.js

# 3. template + bundle + payload → one file, no external requests.
node demo/build-page.mjs /tmp/game.json /tmp/runtime.js demo.html
```

`PARTY='[1,2]' node demo/generate-demo.mjs …` regenerates with the two-actor
party the spec started with, which is worth doing once: the finale drops to a 1%
win rate and `generate_game` comes back `ok: false` naming it as a wall. That is
the battle gate earning its place — `run_scenario` is *told* the outcome of a
battle, so the event layer sees nothing wrong with a boss nobody can beat.

## Files

| file | what it is |
| --- | --- |
| `generate-demo.mjs` | The `GameSpec`, and the Node half: generate, validate, simulate, run the suite, then dump the in-memory data plus a per-tile passability grid. |
| `browser-entry.js` | What esbuild bundles — `Interpreter`, `GameState`, `runScenario`, `decompile`, and a read-only `ProjectSession` stand-in over the embedded JSON. |
| `core-shim.js` | Alias target for `@rmmz-kit/core`, so the bundle gets `mapFileName` without the I/O layer behind it. |
| `page.template.html` | The page: schematic renderer, movement against the passage flags, dialogue, and the report. |
| `build-page.mjs` | Injects the bundle and the payload into the template. |

## What the page does not prove

Written on the page itself, and repeated here because it is the part that
matters: no MZ frame is rendered, no damage is rolled in the browser (outcomes
are drawn against the win rate `simulate_battle` measured in Node), and the
generated `data/*.json` has never been opened by the real editor. What is
demonstrated is the layer under all of that — the command semantics, the
gating, and the three gates that decide whether a generated game is finishable.

## Asking the player a question

The interpreter is synchronous and takes Show Choices answers from a queue up
front, because its callers are scenarios, which know the answers in advance. A
page cannot: it has to stop and ask. Rather than teach the interpreter to
suspend, the page **re-runs the event from a copy of the state** every time it
finds an unanswered question, with one more answer in the queue — discarded runs
never touch the live state, so nothing is applied twice. Which messages came
*before* the question falls out for free: run every branch and take the common
prefix of what each one showed. The divergence point is the question.
