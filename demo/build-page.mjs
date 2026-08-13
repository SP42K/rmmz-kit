// Assemble the demo page: template + the esbuild bundle + the generated game.
//
// Usage: node demo/build-page.mjs <game.json> <runtime.js> <out.html>
//
// Both inputs are injected as text rather than fetched at runtime, because the
// page has to work as a single self-contained file (no external requests at all).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [gamePath, runtimePath, outPath] = process.argv.slice(2);
if (!gamePath || !runtimePath || !outPath) {
  console.error('usage: node demo/build-page.mjs <game.json> <runtime.js> <out.html>');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.join(here, 'page.template.html'), 'utf8');
const runtime = fs.readFileSync(runtimePath, 'utf8');
const game = fs.readFileSync(gamePath, 'utf8');

// The payload rides in a `type="application/json"` script tag, so the only
// sequence that could end the tag early is a literal `<`. Escaping it as <
// keeps the JSON valid and the tag intact — the data contains event text an
// author typed, so this is not hypothetical.
const payload = game.replace(/</g, '\\u003c');

const html = template.replace('__RUNTIME__', () => runtime).replace('__PAYLOAD__', () => payload);
fs.writeFileSync(outPath, html);

console.log(`wrote ${outPath} — ${(html.length / 1024).toFixed(0)} KB`);
