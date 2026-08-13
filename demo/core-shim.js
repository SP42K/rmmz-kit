// Browser stand-in for @rmmz-kit/core.
//
// The interpreter only ever reaches for two things from core: the `ProjectSession`
// *shape* (`listFiles`/`readFile`, both erased at runtime — they are types) and
// `mapFileName`. Core's real entry point pulls in node:fs, node:child_process and
// git, none of which a page can have, so esbuild aliases the package to this file
// instead of shimming node builtins. Kept a copy, not a re-export, precisely so
// the bundle cannot accidentally drag the I/O layer in behind it.
export function mapFileName(id) {
  return `Map${String(id).padStart(3, '0')}.json`;
}
