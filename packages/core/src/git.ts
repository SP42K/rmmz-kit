import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper over the system `git` binary. Shells out instead of adding
 * `simple-git` as a dependency — commit/add/diff is a handful of commands,
 * and pulling in another dependency tree wasn't worth it (this session already
 * hit Windows long-path failures cloning a repo with a deep node_modules).
 */
export class GitRepo {
  constructor(private readonly cwd: string) {}

  private async run(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: this.cwd });
    return stdout;
  }

  async isRepo(): Promise<boolean> {
    return this.run(['rev-parse', '--is-inside-work-tree'])
      .then(() => true)
      .catch(() => false);
  }

  async init(): Promise<void> {
    await this.run(['init']);
  }

  async add(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;
    await this.run(['add', '--', ...filePaths]);
  }

  /** Commits whatever is staged. Returns null (not an error) if nothing is. */
  async commit(message: string): Promise<string | null> {
    // `git commit` exits non-zero on an empty index, which happens routinely:
    // an edit that re-serializes byte-identical to HEAD stages nothing. That
    // is "nothing to record", not a failure the caller should have to parse
    // out of stderr. (--name-only is safe on an unborn HEAD.)
    if ((await this.run(['diff', '--cached', '--name-only'])).trim().length === 0) {
      return null;
    }
    await this.run(['commit', '-m', message]);
    return (await this.run(['rev-parse', 'HEAD'])).trim();
  }

  /** Current branch name, or 'HEAD' when detached. Returns 'HEAD' on an unborn branch too. */
  async currentBranch(): Promise<string> {
    return (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  }

  /** Create a branch at HEAD and switch to it, carrying the working tree over (M9's optional repair-branch isolation). */
  async checkoutNew(name: string): Promise<void> {
    await this.run(['checkout', '-b', name]);
  }

  /** True if there are no staged/unstaged changes and nothing untracked under `paths`. */
  async isClean(paths: string[] = []): Promise<boolean> {
    const output = await this.run(['status', '--porcelain', '--', ...paths]);
    return output.trim().length === 0;
  }
}
