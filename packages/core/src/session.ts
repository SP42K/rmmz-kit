import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './io/atomicWrite.js';
import { parseJson, stringifyCompact } from './io/format.js';
import { assertProjectRoot, listDataFiles } from './io/projectRoot.js';
import { EditorLockSnapshot } from './editorLock.js';
import { GitRepo } from './git.js';

export interface OpenProjectOptions {
  /** Refuse to commit if a tracked file changed on disk since open(). Default true. */
  requireEditorClosed?: boolean;
}

export interface ValidationReport {
  errors: string[];
}

/**
 * In-memory transaction over a project's data/*.json files. All mutations
 * happen in memory (zero disk I/O per call); commit() is the only point that
 * touches disk, and only for files actually changed. This replaces the
 * "read whole file -> mutate -> write whole file" pattern both reference
 * repos use, which amplifies I/O and has no cross-file atomicity.
 *
 * L1 (typed data model, referenced by the implementation plan) is out of
 * scope here — files are read/written as parsed JSON (`unknown`), not typed
 * MZ structures. `readFile`/`updateFile` are the generic primitives L1 would
 * build typed accessors on top of.
 */
export class ProjectSession {
  private lockSnapshot: EditorLockSnapshot;
  private readonly git: GitRepo;

  private constructor(
    readonly rootPath: string,
    private readonly dataDir: string,
    private readonly files: Map<string, unknown>,
    private readonly originalText: Map<string, string>,
    private readonly dirty: Set<string>,
    /** Subset of `dirty` that has no file on disk yet — rollback deletes these instead of re-parsing. */
    private readonly created: Set<string>,
    /** Staged writes to non-data files (js/plugins.js, imported assets), keyed by root-relative path. */
    private readonly rawWrites: Map<string, string | Uint8Array>,
    lockSnapshot: EditorLockSnapshot,
    git: GitRepo,
    private readonly options: Required<OpenProjectOptions>
  ) {
    this.lockSnapshot = lockSnapshot;
    this.git = git;
  }

  static async open(rootPath: string, options: OpenProjectOptions = {}): Promise<ProjectSession> {
    await assertProjectRoot(rootPath);
    const dataDir = path.join(rootPath, 'data');
    const fileNames = await listDataFiles(rootPath);

    // Snapshot mtimes *before* reading, not after: reading a full project is
    // hundreds of files and takes real time. Capturing afterwards would record
    // the post-write mtime of a file the editor saved mid-read while we hold
    // its pre-write content — drift we could never detect, and would clobber.
    const lockSnapshot = await EditorLockSnapshot.capture(fileNames.map((name) => path.join(dataDir, name)));

    const files = new Map<string, unknown>();
    const originalText = new Map<string, string>();
    for (const name of fileNames) {
      const text = await readFile(path.join(dataDir, name), 'utf-8');
      originalText.set(name, text);
      files.set(name, parseJson(text));
    }

    const git = new GitRepo(rootPath);

    return new ProjectSession(rootPath, dataDir, files, originalText, new Set(), new Set(), new Map(), lockSnapshot, git, {
      requireEditorClosed: options.requireEditorClosed ?? true,
    });
  }

  listFiles(): string[] {
    return [...this.files.keys()];
  }

  /** Files with in-memory mutations since open() (or the last commit/rollback) — what commit() would write. */
  dirtyFiles(): string[] {
    return [...this.dirty];
  }

  readFile<T = unknown>(name: string): T {
    if (!this.files.has(name)) {
      throw new Error(`Unknown data file: ${name}`);
    }
    return this.files.get(name) as T;
  }

  /**
   * Add a data file the project doesn't have yet (M7's prerequisite for
   * create_map: `updateFile` throws on a file that isn't there). It joins the
   * transaction like any other mutation — invisible on disk until commit(),
   * discarded whole by rollback(). Deliberately not an `updateFile` upsert
   * flag: "create Map012.json" and "edit Map012.json" have opposite failure
   * modes (one wants the file absent, the other present), and a caller that
   * gets it backwards should hear about it, not silently overwrite a map.
   */
  createFile(name: string, data: unknown): void {
    if (this.files.has(name)) {
      throw new Error(`Data file already exists: ${name}`);
    }
    this.files.set(name, data);
    this.created.add(name);
    this.dirty.add(name);
  }

  /**
   * Stage a write to a project file that isn't part of `data/` — js/plugins.js
   * and imported img//audio/ assets (M7.6). Path is relative to the project
   * root, and staged content is what `readRaw` returns from then on, so a tool
   * that reads-modifies-writes sees its own edits.
   *
   * These are deliberately *not* modeled as data files: they are not JSON, have
   * no id-indexed structure, and (for assets) can be megabytes of bytes we have
   * no reason to parse. They join the transaction only at its two ends —
   * commit() writes and git-adds them, rollback() drops them — which is the
   * part callers actually depend on: an MCP agent that imports an asset, edits
   * a database row, then hits a validation error must not be left with the
   * asset already on disk.
   */
  writeRaw(relPath: string, content: string | Uint8Array): void {
    this.rawWrites.set(this.resolveRawPath(relPath), content);
  }

  /**
   * Staged content if this session wrote it, otherwise what's on disk, or null
   * if there is no such file. Text only — assets are written, never read back.
   *
   * Only ENOENT becomes null: callers read this to decide whether a file needs
   * creating from scratch (managePlugins rewrites js/plugins.js from an empty
   * list when it reads null), so collapsing EACCES/EISDIR/EBUSY into "absent"
   * would turn a transient read failure into "drop every plugin in the list".
   */
  async readRaw(relPath: string): Promise<string | null> {
    const key = this.resolveRawPath(relPath);
    const staged = this.rawWrites.get(key);
    if (staged !== undefined) return typeof staged === 'string' ? staged : Buffer.from(staged).toString('utf-8');
    return readFile(path.join(this.rootPath, key), 'utf-8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
  }

  /** Non-data files staged by writeRaw(), root-relative with forward slashes. */
  rawWriteFiles(): string[] {
    return [...this.rawWrites.keys()];
  }

  /**
   * A trust boundary: `relPath` comes from an MCP client, and the whole point
   * of this channel is writing outside `data/`. Anything that escapes the
   * project root (or arrives absolute) is rejected rather than normalized into
   * something surprising.
   */
  private resolveRawPath(relPath: string): string {
    const normalized = path.normalize(relPath).split(path.sep).join('/');
    const full = path.resolve(this.rootPath, normalized);
    const relative = path.relative(this.rootPath, full);
    if (path.isAbsolute(relPath) || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Path escapes the project root: ${relPath}`);
    }
    return relative.split(path.sep).join('/');
  }

  /** Mutate a file's in-memory data. Return a replacement, or mutate in place and return nothing. */
  updateFile<T = unknown>(name: string, updater: (data: T) => T | void): void {
    const current = this.readFile<T>(name);
    // Marked dirty *before* the updater runs, not after: an updater that mutates
    // in place and then throws (a multi-entry write that rejects entry N) has
    // already changed `current`, which is the object in `files`. Marking after
    // would leave that change untracked — invisible to rollback(), and silently
    // committed by the next unrelated edit to the same file.
    this.dirty.add(name);
    const result = updater(current);
    this.files.set(name, result === undefined ? current : result);
  }

  async validate(): Promise<ValidationReport> {
    const errors: string[] = [];

    if (this.options.requireEditorClosed) {
      const drifted = await this.lockSnapshot.findDrift();
      for (const filePath of drifted) {
        errors.push(
          `File changed on disk since the project was opened (editor open, or another process wrote it?): ${path.relative(this.rootPath, filePath)}`
        );
      }
    }

    // A created file was absent at open(), so the mtime snapshot has nothing to
    // compare and findDrift() can't see it. Its equivalent of drift is "it
    // exists now" — someone else made that map meanwhile, and committing would
    // overwrite it. Checked regardless of requireEditorClosed: that option opts
    // out of refusing on *concurrent edits*, not out of refusing to destroy a
    // file we never read.
    for (const name of this.created) {
      const exists = await stat(path.join(this.dataDir, name)).then(
        () => true,
        () => false
      );
      if (exists) {
        errors.push(`File created in this session already exists on disk (another process wrote it?): ${name}`);
      }
    }

    for (const name of this.dirty) {
      try {
        JSON.stringify(this.files.get(name));
      } catch (err) {
        errors.push(`File ${name} is not JSON-serializable: ${(err as Error).message}`);
      }
    }

    return { errors };
  }

  /** Discard all in-memory mutations since open() (or the last commit). */
  rollback(): void {
    for (const name of this.dirty) {
      // A created file has no original text to restore — undoing it means
      // making the session forget the file exists at all.
      if (this.created.has(name)) {
        this.files.delete(name);
      } else {
        this.files.set(name, parseJson(this.originalText.get(name)!));
      }
    }
    this.dirty.clear();
    this.created.clear();
    this.rawWrites.clear();
  }

  /**
   * Validates, then atomically flushes only dirty files to disk and commits
   * them with git. Throws (writing nothing) if validation fails — a project
   * is never left in a state validate() rejected.
   * Returns the commit hash, or null if there was nothing to commit.
   */
  async commit(message: string): Promise<string | null> {
    const report = await this.validate();
    if (report.errors.length > 0) {
      throw new Error(`Cannot commit, validation failed:\n${report.errors.map((e) => `  - ${e}`).join('\n')}`);
    }
    if (this.dirty.size === 0 && this.rawWrites.size === 0) {
      return null;
    }

    const written = new Map<string, string>();
    const writtenRaw: string[] = [];
    try {
      for (const name of this.dirty) {
        const text = stringifyCompact(this.files.get(name));
        await atomicWriteFile(path.join(this.dataDir, name), text);
        written.set(name, text);
      }

      // After the data files: an asset referenced by a row we failed to write
      // is litter, but a row referencing an asset we failed to write is a
      // broken project.
      for (const [rel, content] of this.rawWrites) {
        const full = path.join(this.rootPath, rel);
        // img/pictures and the like may not exist yet in a project that never
        // used them; atomicWriteFile needs the directory for its temp file.
        await mkdir(path.dirname(full), { recursive: true });
        await atomicWriteFile(full, content);
        writtenRaw.push(rel);
      }

      if (await this.git.isRepo()) {
        await this.git.add([
          ...[...written.keys()].map((name) => path.join(this.dataDir, name)),
          ...writtenRaw.map((rel) => path.join(this.rootPath, rel)),
        ]);
        return await this.git.commit(message);
      }
      return null;
    } finally {
      // Reconcile with whatever actually landed, even on a partial write or a
      // failed git call. Our own writes moved those files' mtimes: leaving the
      // snapshot stale would make every later validate() report the session's
      // own writes as external editor drift, permanently wedging the session.
      for (const [name, text] of written) {
        this.originalText.set(name, text);
        this.dirty.delete(name);
        this.created.delete(name);
      }
      for (const rel of writtenRaw) this.rawWrites.delete(rel);
      this.lockSnapshot = await EditorLockSnapshot.capture(
        this.listFiles().map((name) => path.join(this.dataDir, name))
      );
    }
  }
}

export async function openProject(rootPath: string, options?: OpenProjectOptions): Promise<ProjectSession> {
  return ProjectSession.open(rootPath, options);
}
