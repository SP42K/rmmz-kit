import { cp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJson, stringifyCompact } from './io/format.js';
import { assertProjectRoot, relativeUnderRoot } from './io/projectRoot.js';
import { GitRepo } from './git.js';
import type { SystemData } from './types/mz.js';

/**
 * `create_project` (plan §3 M11): a new project from a template, openable by
 * the editor and immediately usable by `openProject`.
 *
 * The template is a checked-in tree (`templates/blank-project`), not code that
 * builds one: it is data, and "change the default currency unit" should be a
 * JSON edit, not a patch to a builder. It is deliberately *not* the test
 * fixture — the fixture is minimal on purpose (a 4-field System.json, an event
 * whose command list is structurally broken so the validator has something to
 * catch), and none of that belongs in a project a person is about to work in.
 *
 * Two R1-class assumptions live in that tree, both unverifiable here because
 * the editor is paid software this repo can't run:
 * - `Game.rmmzproject`'s content is a version marker (`RPGMZ 1.0.0`). Only its
 *   presence is load-bearing for this toolchain (`assertProjectRoot`).
 * - System.json's defaults are reconstructed from the field list in `types/mz.ts`,
 *   not copied from the editor. Every asset-name field in it is empty rather
 *   than a plausible default filename, because this repo ships no art or audio
 *   and a plausible name would be a dangling reference the validator reports.
 *   `types/mz.ts` is only a *subset* of what MZ writes, so the template also
 *   carries the fields the engine dereferences without a nullcheck and the type
 *   doesn't model — `advanced` (`Scene_Boot.resizeScreen` reads
 *   `advanced.screenWidth` on the first frame) and `itemCategories`
 *   (`Window_ItemCategory.needsCommand` indexes it) chief among them. A project
 *   missing those opens fine and crashes on boot.
 *
 * Which is the same wall M8 hit: `js/` (the MZ runtime), `img/`, `audio/` and
 * `fonts/` ship with the editor, so a project created from the bundled template
 * has data but no game to boot. `runtimeFrom` closes that on a machine that
 * owns a licence — point it at an installed project and its engine and assets
 * are copied in.
 */

const TEMPLATE_DIR = fileURLToPath(new URL('../../../templates/blank-project', import.meta.url));

/**
 * What a project needs from an existing one to actually run. `js/plugins.js`
 * and `js/plugins/` are excluded on purpose: they are the source project's
 * plugin *configuration*, and a new blank project inheriting someone else's
 * plugin list (half of it enabled, all of it unread) is a boot crash waiting on
 * the first missing file.
 */
const RUNTIME_ENTRIES = ['js', 'css', 'fonts', 'effects', 'icon', 'img', 'audio', 'movies', 'index.html'];
const RUNTIME_SKIP = ['js/plugins.js', 'js/plugins'];

export interface CreateProjectOptions {
  /** Written to System.json's gameTitle (and the stub index.html's <title>). */
  title?: string;
  /** Override the bundled template tree. */
  templatePath?: string;
  /** An installed MZ project to copy the engine and default assets from. */
  runtimeFrom?: string;
  /** git init + an initial commit. Default true — every other tool here assumes a repo. */
  git?: boolean;
}

export interface CreateProjectResult {
  path: string;
  files: string[];
  /** Commit hash of the initial commit, or null if git was skipped or unavailable. */
  commit: string | null;
  warnings: string[];
}

export async function createProject(targetPath: string, options: CreateProjectOptions = {}): Promise<CreateProjectResult> {
  const target = path.resolve(targetPath);
  const entries = await readdir(target).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  if (entries.length > 0) {
    throw new Error(`Target directory is not empty: ${target}`);
  }

  const template = options.templatePath ? path.resolve(options.templatePath) : TEMPLATE_DIR;
  await cp(template, target, { recursive: true });

  const warnings: string[] = [];
  if (options.runtimeFrom) {
    await copyRuntime(path.resolve(options.runtimeFrom), target);
  } else {
    warnings.push(
      'No runtimeFrom: this project has data but no engine (js/rmmz_*.js), art or audio — those ship with the editor. ' +
        'It opens as a project; it will not boot until the runtime is copied in.'
    );
  }

  if (options.title) await setTitle(target, options.title);

  let commit: string | null = null;
  if (options.git ?? true) {
    const git = new GitRepo(target);
    // A created project is worth having a baseline commit for (rollback() and
    // commit() both assume one), but git failing — no binary, no configured
    // identity, a signing prompt — must not throw away a project that is
    // otherwise complete on disk.
    commit = await git
      .init()
      .then(async () => {
        if (await git.ensureIdentity()) {
          warnings.push('git had no user.name/user.email, so this repo got a local "rmmz-kit <rmmz-kit@localhost>" identity — change it with `git config user.email`.');
        }
      })
      .then(() => git.add([target]))
      .then(() => git.commit('chore: create project'))
      .catch((err: Error) => {
        warnings.push(`git init/commit failed (the project is still on disk): ${err.message}`);
        return null;
      });
  }

  return { path: target, files: await listTree(target), commit, warnings };
}

async function copyRuntime(source: string, target: string): Promise<void> {
  // Must be a real project: pointing this at any directory would copy an
  // arbitrary tree in under names the game loads at boot.
  await assertProjectRoot(source);
  for (const entry of RUNTIME_ENTRIES) {
    await cp(path.join(source, entry), path.join(target, entry), {
      recursive: true,
      force: true,
      filter: (src) => {
        const rel = relativeUnderRoot(source, src);
        return !RUNTIME_SKIP.some((skip) => rel === skip || rel.startsWith(`${skip}/`));
      },
    }).catch((err: NodeJS.ErrnoException) => {
      // A project without movies/ or fonts/ is normal; anything else is not.
      if (err.code !== 'ENOENT') throw err;
    });
  }
}

async function setTitle(target: string, title: string): Promise<void> {
  const systemPath = path.join(target, 'data', 'System.json');
  const system = parseJson(await readFile(systemPath, 'utf-8')) as SystemData;
  system.gameTitle = title;
  await writeFile(systemPath, stringifyCompact(system), 'utf-8');

  const indexPath = path.join(target, 'index.html');
  const html = await readFile(indexPath, 'utf-8').catch(() => null);
  if (html) {
    // Replacer *function*: a string replacement would interpret `$&`/`$'` in
    // the title as match-substitution patterns and splice the old title back in.
    await writeFile(indexPath, html.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(title)}</title>`), 'utf-8');
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function listTree(dir: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listTree(path.join(dir, entry.name), rel)));
    else files.push(rel);
  }
  return files.sort();
}
