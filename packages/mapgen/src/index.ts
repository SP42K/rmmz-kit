export {
  TILE_ID_A1,
  TILE_ID_A2,
  TILE_ID_A3,
  TILE_ID_A4,
  TILE_ID_MAX,
  applyAutotiles,
  autotileFamily,
  autotileKind,
  autotileShape,
  isAutotile,
  makeAutotileId,
  shapeAt,
  tileAt,
  tileIndex,
} from './autotile.js';
export type { AutotileFamily } from './autotile.js';

export { LAYERS, REGION_LAYER, SHADOW_LAYER, blankMap, createMap, paintMapData, paintTiles, resizeMap } from './edit.js';
export type { CreateMapSpec, PaintOp, PaintSpec, ResizeResult } from './edit.js';

export { FLAGS_LENGTH, analyzeReachability, checkPassage, defaultTilesetFlags, setTileFlags } from './passage.js';
export type { Direction, Reachability, TileFlagSpec } from './passage.js';

export { composeMap } from './compose.js';
export type { ComposeResult, ComposeSpec, Rect } from './compose.js';
