import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../../../fixtures/minimal-project');

/** Copies the fixture project into a throwaway temp dir with its own git repo. */
export async function makeTestProject(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'rmmz-agent-test-'));
  await cp(FIXTURE, dir, { recursive: true });
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'rmmz-kit test'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'initial fixture'], { cwd: dir });
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
