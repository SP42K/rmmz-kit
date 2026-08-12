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

  /**
   * Give the repo a local identity if git can't resolve one, returning whether
   * it had to. A machine with no global `user.name`/`user.email` — a CI runner,
   * a fresh container — fails `git commit` outright ("please tell me who you
   * are"), and for a repo this toolchain has just created that means no baseline
   * commit, which `rollback()` and `commit()` both assume exists. Written
   * repo-locally and only when absent, so a machine that has an identity keeps
   * using it.
   */
  async ensureIdentity(): Promise<boolean> {
    // `git var` is the probe rather than reading the two config keys: it applies
    // git's own resolution order (env, then config, then its auto-detect) and
    // fails exactly when `git commit` would.
    if (await this.run(['var', 'GIT_COMMITTER_IDENT']).then(() => true, () => false)) return false;
    await this.run(['config', 'user.name', 'rmmz-kit']);
    await this.run(['config', 'user.email', 'rmmz-kit@localhost']);
    return true;
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

  /**
   * Current branch name, or '' when detached. `--show-current`, not
   * `rev-parse --abbrev-ref HEAD`: the latter exits 128 on an unborn branch
   * (a repo that has been `git init`ed but never committed, which is a state
   * `openProject` accepts), so it would reject rather than answer.
   */
  async currentBranch(): Promise<string> {
    return (await this.run(['branch', '--show-current'])).trim();
  }

  /** Switch to `name`, creating it at HEAD if it doesn't exist yet (M9's optional repair-branch isolation). */
  async checkoutNew(name: string): Promise<void> {
    // `checkout -b` fails outright on a branch that already exists, which a
    // second repair run onto the same branch name hits routinely. `-B` is not
    // the fix — it would reset someone else's branch to HEAD.
    const exists = await this.run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
      .then((out) => out.trim().length > 0)
      .catch(() => false);
    await this.run(['checkout', ...(exists ? [] : ['-b']), name]);
  }

  /** True if there are no staged/unstaged changes and nothing untracked under `paths`. */
  async isClean(paths: string[] = []): Promise<boolean> {
    const output = await this.run(['status', '--porcelain', '--', ...paths]);
    return output.trim().length === 0;
  }
}
