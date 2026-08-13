// Entry point esbuild bundles into the demo page.
//
// The point of the demo is that the browser runs *this repo's* event semantics,
// not a second implementation written for the page. So it pulls `Interpreter`
// and `GameState` straight out of `packages/playtest`'s build output — the same
// classes `run_scenario` and the walkthrough suite drive in Node.
//
// Imported by path rather than by package name on purpose: `@rmmz-kit/playtest`'s
// entry point re-exports `startPlaytestServer`, which imports node:http. Reaching
// past the barrel keeps the bundle to the two modules a browser can actually run.
import { Interpreter } from '../packages/playtest/dist/interpreter.js';
import { GameState } from '../packages/playtest/dist/state.js';
import { runScenario } from '../packages/playtest/dist/scenario.js';
import { decompile } from '../packages/compiler/dist/decompile.js';
import { mapFileName } from './core-shim.js';

/**
 * `ProjectSession`'s read half, over data held in memory.
 *
 * The interpreter only calls `listFiles()` and `readFile()` (checked against
 * `interpreter.ts` — every other session method is core's I/O and transaction
 * machinery, which nothing in the runtime path touches). So the page can hand it
 * the JSON the generator produced and get the real thing back, with no fs.
 */
class MemorySession {
  constructor(data) {
    this.data = data;
  }
  listFiles() {
    return Object.keys(this.data);
  }
  readFile(name) {
    const file = this.data[name];
    if (file === undefined) throw new Error(`No such data file: ${name}`);
    return file;
  }
}

globalThis.RmmzKit = { Interpreter, GameState, MemorySession, runScenario, decompile, mapFileName };
