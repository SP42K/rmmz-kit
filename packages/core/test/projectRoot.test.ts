import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { relativeUnderRoot } from '../src/io/projectRoot.js';

/**
 * The regression this exists for: every root-relative match in this package
 * (`deploy`'s EXCLUDED and prunable roots, `createProject`'s RUNTIME_SKIP) is a
 * string compare against `path.relative(root, file)`, and that quietly returns
 * a `../..` walk when the two ends spell the same directory differently. A
 * GitHub Windows runner does exactly that — `os.tmpdir()` hands back the 8.3
 * short name `C:\Users\RUNNER~1` for a directory `fs` reports as
 * `C:\Users\runneradmin` — and the failure is silent in the worst direction:
 * nothing matches, so the project marker ships and no asset is pruned.
 *
 * A symlinked root is the portable stand-in for that mismatch (junction on
 * Windows, which needs no privileges).
 */
describe('relativeUnderRoot', () => {
  it('returns a root-relative POSIX path', () => {
    const root = path.join(path.sep, 'projects', 'game');
    expect(relativeUnderRoot(root, path.join(root, 'data', 'System.json'))).toBe('data/System.json');
    expect(relativeUnderRoot(root, path.join(root, 'Game.rmmzproject'))).toBe('Game.rmmzproject');
  });

  it('resolves a root and a file that spell the same directory differently', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'rmmz-relative-'));
    const real = path.join(base, 'real');
    await mkdir(path.join(real, 'img', 'faces'), { recursive: true });
    await writeFile(path.join(real, 'img', 'faces', 'Actor1.png'), '');

    const link = path.join(base, 'link');
    await symlink(real, link, 'junction');

    // The naive answer is `../real/img/faces/Actor1.png`, which matches no rule.
    expect(relativeUnderRoot(link, path.join(real, 'img', 'faces', 'Actor1.png'))).toBe('img/faces/Actor1.png');
  });
});
