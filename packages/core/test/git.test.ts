import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitRepo } from '../src/git.js';

/** Only the two branch helpers M9 added — the rest of GitRepo is covered through session.test.ts. */
describe('GitRepo branch helpers', () => {
  async function emptyRepo(): Promise<{ dir: string; git: GitRepo }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'rmmz-git-test-'));
    const git = new GitRepo(dir);
    await git.init();
    return { dir, git };
  }

  it('answers currentBranch on an unborn branch instead of rejecting', async () => {
    const { dir, git } = await emptyRepo();
    try {
      // `rev-parse --abbrev-ref HEAD` exits 128 here; a repo that has been
      // init'ed but never committed is a state openProject accepts.
      expect(await git.currentBranch()).not.toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('checkoutNew switches to a branch that already exists rather than failing', async () => {
    const { dir, git } = await emptyRepo();
    try {
      await writeFile(path.join(dir, 'a.txt'), 'x');
      await git.add(['a.txt']);
      await git.commit('initial');
      const main = await git.currentBranch();

      await git.checkoutNew('repair/x');
      expect(await git.currentBranch()).toBe('repair/x');

      await git.checkoutNew(main);
      await git.checkoutNew('repair/x'); // second repair run onto the same branch
      expect(await git.currentBranch()).toBe('repair/x');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
