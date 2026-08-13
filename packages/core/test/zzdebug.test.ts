import { describe, it } from 'vitest';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// TEMPORARY diagnostic — remove before merge.
describe('path diagnostics', () => {
  it('prints what cp hands the filter', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'rmmz-dbg-'));
    const src = path.join(base, 'src');
    const dst = path.join(base, 'dst');
    await mkdir(path.join(src, 'data'), { recursive: true });
    await writeFile(path.join(src, 'Game.rmmzproject'), 'x');
    await writeFile(path.join(src, 'data', 'System.json'), '{}');

    const seen: string[] = [];
    await cp(src, dst, {
      recursive: true,
      filter: (from) => {
        seen.push(from);
        return true;
      },
    });

    console.log('DBG tmpdir      =', tmpdir());
    console.log('DBG base        =', base);
    console.log('DBG base real   =', realpathSync.native(base));
    console.log('DBG src         =', src);
    console.log('DBG cwd         =', process.cwd());
    for (const from of seen) {
      const rel = path.relative(src, from);
      console.log(`DBG from=${from} | rel=${JSON.stringify(rel)} | abs=${path.isAbsolute(rel)}`);
    }
  });
});
