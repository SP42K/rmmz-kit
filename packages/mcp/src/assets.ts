import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectSession } from '@rmmz-kit/core';

/**
 * The standard asset folders MZ loads from, and what may go in them. Shared by
 * the asset-catalog resource (what exists) and import_asset (where a new file
 * is allowed to land) — plan §4.5 leans on the catalog to stop models inventing
 * filenames, which only holds if imports can't invent folders either.
 */
export const ASSET_DIRS = [
  'img/characters',
  'img/faces',
  'img/enemies',
  'img/sv_actors',
  'img/sv_enemies',
  'img/pictures',
  'img/parallaxes',
  'img/tilesets',
  'img/battlebacks1',
  'img/battlebacks2',
  'img/titles1',
  'img/titles2',
  'audio/bgm',
  'audio/bgs',
  'audio/me',
  'audio/se',
] as const;

/**
 * MZ picks the extension itself (`ImageManager` appends `.png`, `AudioManager`
 * tries `.ogg`/`.m4a`), so a file with any other extension is invisible to the
 * game — it just silently fails to load. Reject at import instead.
 */
const ALLOWED_EXTENSIONS: Record<'img' | 'audio', string[]> = {
  img: ['.png'],
  audio: ['.ogg', '.m4a'],
};

export interface ImportAssetSpec {
  /** One of ASSET_DIRS. */
  dir: string;
  /** Path to the file to copy in. */
  source: string;
  /** Target filename; defaults to the source's own basename. */
  name?: string;
}

/**
 * Copies a file into the project under `dir`. The bytes are staged on the
 * session, so the import lands with commit() and disappears with rollback()
 * along with whatever database row was written to reference it.
 */
export async function importAsset(session: ProjectSession, spec: ImportAssetSpec): Promise<{ path: string }> {
  if (!(ASSET_DIRS as readonly string[]).includes(spec.dir)) {
    throw new Error(`Unknown asset folder: ${spec.dir}. Known folders: ${ASSET_DIRS.join(', ')}`);
  }
  const name = spec.name ?? path.basename(spec.source);
  if (name !== path.basename(name) || name.startsWith('.')) {
    throw new Error(`Asset name must be a plain filename, got ${JSON.stringify(name)}`);
  }
  const allowed = ALLOWED_EXTENSIONS[spec.dir.split('/')[0] as 'img' | 'audio'];
  const extension = path.extname(name).toLowerCase();
  if (!allowed.includes(extension)) {
    throw new Error(`${spec.dir} takes ${allowed.join(' or ')} files; ${name} is ${extension || 'extensionless'}`);
  }

  const bytes = await readFile(spec.source).catch((err: Error) => {
    throw new Error(`Cannot read ${spec.source}: ${err.message}`);
  });
  const target = `${spec.dir}/${name}`;
  session.writeRaw(target, bytes);
  return { path: target };
}
