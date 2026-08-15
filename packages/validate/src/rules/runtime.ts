import type { MapData, ProjectSession, Tileset } from '@rmmz-kit/core';
import { checkPassage } from '@rmmz-kit/mapgen';
import type { Finding } from '../types.js';

/**
 * The two ways a project that passes every other rule still fails in front of a
 * player. Both were found by running the toolchain against a real licensed MZ
 * install for the first time; neither is reachable from the event layer, which
 * is why they are not in semantics.ts.
 *
 * - A System.json field the engine dereferences with no nullcheck. The editor
 *   writes these on first save, so a project it has never saved (`NewData`, or
 *   anything this toolchain produced from something other than
 *   `templates/blank-project`) is missing them and crashes on boot.
 * - A map on which nothing blocks movement. Note `analyzeReachability` is
 *   structurally blind to this: an all-passable map is still exactly one
 *   walkable region, so compose_map's connectivity assertion passes on the map
 *   whose walls you walk straight through.
 */
export function checkRuntime(session: ProjectSession): Finding[] {
  const findings: Finding[] = [];
  checkSystemFields(session, findings);
  checkMapPassability(session, findings);
  return findings;
}

/**
 * Fields with no fallback in `js/rmmz_*.js`, each one an immediate TypeError
 * rather than a degraded game. Deliberately a short list of *named crashes*
 * rather than every field the editor writes: `SystemData` in core is a subset
 * of MZ's own System.json (see update_system's doc comment), so a completeness
 * check here would report legitimate projects as broken.
 */
const REQUIRED_SYSTEM_FIELDS: Array<{ path: string; why: string }> = [
  // Game_System.windowOpacity() is `return $dataSystem.advanced.windowOpacity`,
  // called from Window_Base.updateBackOpacity while the *first* window is built:
  // "Cannot read properties of undefined (reading 'clamp')" before the first map
  // is drawn.
  { path: 'advanced.windowOpacity', why: 'Window_Base.updateBackOpacity reads it while building the first window' },
  { path: 'advanced.screenWidth', why: 'Scene_Boot.resizeScreen sizes the canvas from it' },
  { path: 'advanced.screenHeight', why: 'Scene_Boot.resizeScreen sizes the canvas from it' },
  { path: 'advanced.uiAreaWidth', why: 'Scene_Boot.adjustBoxSize lays out every window from it' },
  { path: 'advanced.uiAreaHeight', why: 'Scene_Boot.adjustBoxSize lays out every window from it' },
  { path: 'itemCategories', why: 'Window_ItemCategory.makeCommandList indexes it when the menu opens' },
  // Worse than advanced.windowOpacity, and found the same way: rmmz_scenes.js
  // reads `$dataSystem.titleCommandWindow.background` (:579) and `.offsetX` /
  // `.offsetY` (:590-591) in Scene_Title.createCommandWindow, with no guard on
  // the object. The title screen is the *first* scene, so a project missing it
  // never reaches a map at all — and the editor only writes it on first save,
  // which is exactly the state create_project's output is in.
  { path: 'titleCommandWindow', why: 'Scene_Title.createCommandWindow reads .background/.offsetX/.offsetY off it before the first scene draws' },
];

/** SoundManager.loadSystemSound reads $dataSystem.sounds[0..23]; a short array is a crash on the first cursor move. */
const SYSTEM_SOUND_COUNT = 24;

function checkSystemFields(session: ProjectSession, findings: Finding[]): void {
  if (!session.listFiles().includes('System.json')) return;
  const system = session.readFile<Record<string, unknown>>('System.json');

  const add = (path: string, message: string) =>
    findings.push({ rule: 'runtime/missing-system-field', severity: 'error', message, file: 'System.json', path });

  // One finding per missing *object*, not one per field under it: a project
  // with no `advanced` at all is one mistake, and five findings for it buries
  // the other four rules under it.
  const reported = new Set<string>();
  for (const { path, why } of REQUIRED_SYSTEM_FIELDS) {
    const [head, tail] = path.split('.');
    const top = system[head] as Record<string, unknown> | undefined;
    if (top === undefined || top === null) {
      if (reported.has(head)) continue;
      reported.add(head);
      add(head, `System.json has no "${head}" — the engine dereferences it with no fallback (${why})`);
      continue;
    }
    if (tail !== undefined && top[tail] === undefined) {
      add(path, `System.json is missing ${path} — the game crashes on boot (${why})`);
    }
  }

  const sounds = system.sounds;
  if (!Array.isArray(sounds) || sounds.length < SYSTEM_SOUND_COUNT) {
    add(
      'sounds',
      `System.json needs ${SYSTEM_SOUND_COUNT} entries in "sounds" (has ${Array.isArray(sounds) ? sounds.length : 0}) — ` +
        `SoundManager.loadSystemSound reads them by index`
    );
  }
}

/**
 * A warning, not an error: a small open field with no walls is legal MZ, and a
 * rule that cried wolf on those would get ignored wholesale (the same reasoning
 * that kept an "every event is reachable" rule out of the validator). What makes
 * the signal worth having anyway is that it only fires when *nothing at all* on
 * the map blocks movement, which on a map drawn with walls means the tileset's
 * flags are wrong for it — the state a stock tileset leaves you in after
 * re-pointing a generated map at it.
 */
function checkMapPassability(session: ProjectSession, findings: Finding[]): void {
  const tilesets = session.listFiles().includes('Tilesets.json')
    ? session.readFile<Array<Tileset | null>>('Tilesets.json')
    : [];

  for (const file of session.listFiles()) {
    if (!/^Map\d+\.json$/.test(file)) continue;
    const map = session.readFile<MapData>(file);
    const flags = tilesets[map.tilesetId]?.flags;
    // No tileset row, or one with no flags array, is a different bug — and one
    // this rule cannot tell apart from "not checkable", so it says nothing.
    if (!flags || flags.length === 0) continue;

    let blocked = false;
    for (let y = 0; y < map.height && !blocked; y++) {
      for (let x = 0; x < map.width && !blocked; x++) {
        blocked = !checkPassage(map, flags, x, y, 'down') || !checkPassage(map, flags, x, y, 'up');
      }
    }
    if (blocked) continue;

    findings.push({
      rule: 'runtime/map-all-passable',
      severity: 'warning',
      message:
        `Every tile of this map is walkable in tileset ${map.tilesetId} — nothing on it blocks the player. ` +
        `If it was drawn with walls, the tileset's passage flags do not match the tiles it uses (set_tile_flags).`,
      file,
    });
  }
}
