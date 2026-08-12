import type { MapData, MapInfo, ProjectSession } from '@rmmz-kit/core';
import { mapFileName } from '@rmmz-kit/core';
import { TILE_ID_MAX, applyAutotiles, tileIndex } from './autotile.js';

/**
 * Map lifecycle and drawing primitives (plan §3 M7, "前半：編輯原語"). These are
 * the primitives *programs* call — the plan's own warning is that an LLM must
 * not paint tile by tile; it decides which rooms exist and where events go, and
 * compose.ts draws.
 */

export const LAYERS = 6;

/** MZ's six layers per tile: 0-1 ground autotiles, 2-3 upper (B-E) tiles, 4 shadow, 5 region id. */
export const SHADOW_LAYER = 4;
export const REGION_LAYER = 5;

export interface CreateMapSpec {
  name: string;
  width: number;
  height: number;
  /** Defaults to tileset 1 — the only one a fresh project is guaranteed to have. */
  tilesetId?: number;
  /** Position in the editor's map tree; 0 (default) is the root. */
  parentId?: number;
  /** Tile id to flood layer 0 with. Autotile shapes are derived, so pass the kind's base id. */
  fillTileId?: number;
}

/**
 * A map file MZ can load and the editor can open. Every field the editor writes
 * is present with its default — an absent field is not "default" to MZ, it is
 * `undefined` reaching engine code that never nullchecks it (R1).
 */
export function blankMap(spec: CreateMapSpec): MapData {
  const { width, height } = spec;
  return {
    autoplayBgm: false,
    autoplayBgs: false,
    battleback1Name: '',
    battleback2Name: '',
    bgm: { name: '', pan: 0, pitch: 100, volume: 90 },
    bgs: { name: '', pan: 0, pitch: 100, volume: 90 },
    disableDashing: false,
    displayName: '',
    encounterList: [],
    encounterStep: 30,
    height,
    note: '',
    parallaxLoopX: false,
    parallaxLoopY: false,
    parallaxName: '',
    parallaxShow: true,
    parallaxSx: 0,
    parallaxSy: 0,
    scrollType: 0,
    specifyBattleback: false,
    tilesetId: spec.tilesetId ?? 1,
    width,
    data: new Array<number>(width * height * LAYERS).fill(0),
    // Events are 1-indexed behind the same mandatory leading null every MZ
    // table uses.
    events: [null],
  };
}

function assertDimensions(width: number, height: number): void {
  // MZ's own editor limits; the lower bound is the engine's (a map narrower
  // than the screen is legal, one with a zero dimension divides by zero).
  for (const [name, value] of [
    ['width', width],
    ['height', height],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 256) {
      throw new Error(`Map ${name} must be an integer in 1..256, got ${JSON.stringify(value)}`);
    }
  }
}

/**
 * Creates `Map###.json` *and* its MapInfos row, in that order — `upsert_database`
 * refuses a MapInfos row whose map file doesn't exist (M6.5), and rightly so:
 * the row is what the rest of the toolchain treats as proof the map exists.
 * Returns the allocated map id.
 */
export function createMap(session: ProjectSession, spec: CreateMapSpec): number {
  assertDimensions(spec.width, spec.height);

  const infos = session.readFile<Array<MapInfo | null>>('MapInfos.json');
  const files = new Set(session.listFiles());
  // A free id needs *both* halves free: a null MapInfos slot whose Map###.json
  // still exists on disk is an orphaned map, and reusing that id would silently
  // adopt its tiles and events.
  let id = 1;
  while (infos[id] != null || files.has(mapFileName(id))) id++;

  session.createFile(mapFileName(id), applyFill(blankMap(spec), spec.fillTileId));

  session.updateFile<Array<MapInfo | null>>('MapInfos.json', (data) => {
    const maxOrder = data.reduce((max, info) => Math.max(max, info?.order ?? 0), 0);
    while (data.length <= id) data.push(null);
    data[id] = {
      id,
      name: spec.name,
      parentId: spec.parentId ?? 0,
      order: maxOrder + 1,
      expanded: false,
      scrollX: 0,
      scrollY: 0,
    };
  });

  return id;
}

function applyFill(map: MapData, fillTileId: number | undefined): MapData {
  if (fillTileId === undefined) return map;
  paintMapData(map, [{ x: 0, y: 0, width: map.width, height: map.height, tileId: fillTileId }], 0, true);
  return map;
}

export interface PaintOp {
  x: number;
  y: number;
  /** Rectangle size; both default to 1, i.e. a single tile. */
  width?: number;
  height?: number;
  tileId: number;
}

/** Fills rectangles on one layer, then re-derives autotile shapes over what changed. */
export function paintMapData(map: MapData, ops: PaintOp[], layer: number, autotile: boolean): void {
  if (!Number.isInteger(layer) || layer < 0 || layer >= LAYERS) {
    throw new Error(`Layer must be an integer in 0..${LAYERS - 1}, got ${JSON.stringify(layer)}`);
  }

  for (const op of ops) {
    const width = op.width ?? 1;
    const height = op.height ?? 1;
    if (!Number.isInteger(op.tileId) || op.tileId < 0 || op.tileId >= TILE_ID_MAX) {
      throw new Error(`Tile id must be an integer in 0..${TILE_ID_MAX - 1}, got ${JSON.stringify(op.tileId)}`);
    }
    if (
      !Number.isInteger(op.x) ||
      !Number.isInteger(op.y) ||
      width < 1 ||
      height < 1 ||
      op.x < 0 ||
      op.y < 0 ||
      op.x + width > map.width ||
      op.y + height > map.height
    ) {
      // Out of bounds is silent corruption otherwise: the flat index wraps onto
      // the next row (or the next layer), so painting past the right edge draws
      // on the left edge one row down.
      throw new Error(
        `Paint rect ${op.x},${op.y} ${width}x${height} is outside the ${map.width}x${map.height} map`
      );
    }

    for (let y = op.y; y < op.y + height; y++) {
      for (let x = op.x; x < op.x + width; x++) {
        map.data[tileIndex(map.width, map.height, layer, x, y)] = op.tileId;
      }
    }

    if (autotile) {
      applyAutotiles(map.data, map.width, map.height, layer, { x: op.x, y: op.y, width, height });
    }
  }
}

export interface PaintSpec {
  mapId: number;
  ops: PaintOp[];
  /** Default 0 (the lower ground layer). */
  layer?: number;
  /** Default true. Turn off only to write raw shape bits verbatim. */
  autotile?: boolean;
}

export function paintTiles(session: ProjectSession, spec: PaintSpec): void {
  session.updateFile<MapData>(mapFileName(spec.mapId), (map) => {
    paintMapData(map, spec.ops, spec.layer ?? 0, spec.autotile ?? true);
  });
}

export interface ResizeResult {
  /** Event ids now outside the map. MZ keeps them in the file but they are unreachable. */
  outOfBoundsEvents: number[];
}

/**
 * Resizes in place, anchored top-left: overlapping tiles keep their coordinates,
 * new area is 0, cropped area is dropped. Events are never moved or deleted —
 * that is data an agent wrote deliberately — but any left outside the new bounds
 * are reported so the caller can move them instead of losing them silently.
 */
export function resizeMap(session: ProjectSession, mapId: number, width: number, height: number): ResizeResult {
  assertDimensions(width, height);

  const outOfBoundsEvents: number[] = [];
  session.updateFile<MapData>(mapFileName(mapId), (map) => {
    const data = new Array<number>(width * height * LAYERS).fill(0);
    const copyWidth = Math.min(width, map.width);
    const copyHeight = Math.min(height, map.height);
    for (let layer = 0; layer < LAYERS; layer++) {
      for (let y = 0; y < copyHeight; y++) {
        for (let x = 0; x < copyWidth; x++) {
          data[(layer * height + y) * width + x] = map.data[tileIndex(map.width, map.height, layer, x, y)];
        }
      }
    }
    map.data = data;
    map.width = width;
    map.height = height;

    // Growing the map puts empty tiles next to what used to be the border, so
    // the old edge tiles need borders they didn't have. (Shrinking needs no
    // pass: shapeAt clamps out-of-bounds reads, so a tile that becomes the
    // border sees the same neighbours it did as an interior tile.) Layers 2-3
    // hold B-E tiles and 4-5 shadow/region, none of which are autotiles.
    for (const layer of [0, 1]) {
      applyAutotiles(data, width, height, layer, { x: 0, y: 0, width, height });
    }

    for (const event of map.events) {
      if (event && (event.x >= width || event.y >= height)) outOfBoundsEvents.push(event.id);
    }
  });

  return { outOfBoundsEvents };
}
