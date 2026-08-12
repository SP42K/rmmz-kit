import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * AutoTest.js is a real .js file, not a template string in TypeScript: it is
 * MZ plugin source, and it should be lintable/openable as such. It sits at the
 * package root rather than under src/ so this resolves identically from
 * `src/autotest.ts` and from the built `dist/autotest.js` — both are one
 * directory below it, so no build step has to copy an asset.
 */
export const AUTOTEST_PLUGIN_NAME = 'AutoTest';
export const AUTOTEST_PLUGIN_PATH = 'js/plugins/AutoTest.js';

export function autoTestSource(): string {
  return readFileSync(fileURLToPath(new URL('../AutoTest.js', import.meta.url)), 'utf-8');
}
