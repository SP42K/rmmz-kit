import { readFile } from 'node:fs/promises';
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
    private readonly rootPath: string,
    private readonly dataDir: string,
    private readonly files: Map<string, unknown>,
    private readonly originalText: Map<string, string>,
    private readonly dirty: Set<string>,
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

    const files = new Map<string, unknown>();
    const originalText = new Map<string, string>();
    for (const name of fileNames) {
      const text = await readFile(path.join(dataDir, name), 'utf-8');
      originalText.set(name, text);
      files.set(name, parseJson(text));
    }

    const lockSnapshot = await EditorLockSnapshot.capture(fileNames.map((name) => path.join(dataDir, name)));
    const git = new GitRepo(rootPath);

    return new ProjectSession(rootPath, dataDir, files, originalText, new Set(), lockSnapshot, git, {
      requireEditorClosed: options.requireEditorClosed ?? true,
    });
  }

  listFiles(): string[] {
    return [...this.files.keys()];
  }

  readFile<T = unknown>(name: string): T {
    if (!this.files.has(name)) {
      throw new Error(`Unknown data file: ${name}`);
    }
    return this.files.get(name) as T;
  }

  /** Mutate a file's in-memory data. Return a replacement, or mutate in place and return nothing. */
  updateFile<T = unknown>(name: string, updater: (data: T) => T | void): void {
    const current = this.readFile<T>(name);
    const result = updater(current);
    this.files.set(name, result === undefined ? current : result);
    this.dirty.add(name);
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
      this.files.set(name, parseJson(this.originalText.get(name)!));
    }
    this.dirty.clear();
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
    if (this.dirty.size === 0) {
      return null;
    }

    const writtenPaths: string[] = [];
    for (const name of this.dirty) {
      const filePath = path.join(this.dataDir, name);
      const text = stringifyCompact(this.files.get(name));
      await atomicWriteFile(filePath, text);
      this.originalText.set(name, text);
      writtenPaths.push(filePath);
    }
    this.dirty.clear();

    let hash: string | null = null;
    if (await this.git.isRepo()) {
      await this.git.add(writtenPaths);
      hash = await this.git.commit(message);
    }

    this.lockSnapshot = await EditorLockSnapshot.capture(this.listFiles().map((name) => path.join(this.dataDir, name)));
    return hash;
  }
}

export async function openProject(rootPath: string, options?: OpenProjectOptions): Promise<ProjectSession> {
  return ProjectSession.open(rootPath, options);
}
