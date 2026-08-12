/**
 * Autotile shape bits (plan §3 M7, risk R9). An MZ tile id >= 2048 is
 * `2048 + kind * 48 + shape`: `kind` is which autotile you painted, `shape` is
 * which of its 48 pre-drawn border variants to show. Only `kind` is authored —
 * `shape` is a pure function of the eight neighbours, so painting is "write the
 * kind everywhere, then derive every shape". Get it wrong and the map opens in
 * the editor visibly broken (R9), which is why this is the one module in the
 * package with no judgement calls in it.
 *
 * The shape *numbering* is not documented; it is derived here from MZ's own
 * `Tilemap.FLOOR_AUTOTILE_TABLE` / `WALL_AUTOTILE_TABLE` /
 * `WATERFALL_AUTOTILE_TABLE` (rmmz_core.js), which say which quarter-tile each
 * shape draws in each corner. Reading off which quarters are "edge" pieces
 * gives, for the floor table, exactly this enumeration:
 *
 *   - shapes 0-15   : no open edge, the 4 concave-corner bits
 *   - shapes 16-31  : one open edge (left, top, right, bottom in that order),
 *                     each with the 2 corners that edge doesn't touch
 *   - shapes 32-45  : two then three open edges, in the group order below
 *   - shape  46     : all four open (an isolated tile)
 *   - shape  47     : the borderless source tile; the editor never derives it
 *
 * with one trap: within a single-open-edge group the corners are enumerated
 * *cyclically starting just past the open edge*, not in a fixed order — the
 * right-open group is (lower-left, upper-left), while every other group reads
 * upper-left first. That is what `startCorner` below is for.
 */

export const TILE_ID_A1 = 2048;
export const TILE_ID_A2 = 2816;
export const TILE_ID_A3 = 4352;
export const TILE_ID_A4 = 5888;
export const TILE_ID_MAX = 8192;

export function isAutotile(tileId: number): boolean {
  return tileId >= TILE_ID_A1 && tileId < TILE_ID_MAX;
}

export function autotileKind(tileId: number): number {
  return Math.floor((tileId - TILE_ID_A1) / 48);
}

export function autotileShape(tileId: number): number {
  return (tileId - TILE_ID_A1) % 48;
}

export function makeAutotileId(kind: number, shape: number): number {
  return TILE_ID_A1 + kind * 48 + shape;
}

/**
 * Which of the three shape tables a tile id uses. Ported from the branches of
 * `Tilemap.prototype._drawAutotile`: A2 and non-waterfall A1 are floors, A3 is
 * always a wall, and A4 alternates — the first 8 kinds of each 16-kind row are
 * wall *tops* (drawn as floors) and the last 8 are wall *sides*.
 */
export type AutotileFamily = 'floor' | 'wall' | 'waterfall';

export function autotileFamily(tileId: number): AutotileFamily {
  if (tileId >= TILE_ID_A4) return autotileKind(tileId) % 16 >= 8 ? 'wall' : 'floor';
  if (tileId >= TILE_ID_A3) return 'wall';
  if (tileId >= TILE_ID_A2) return 'floor';
  return tileId >= TILE_ID_A1 + 192 && autotileKind(tileId) % 2 === 1 ? 'waterfall' : 'floor';
}

// Neighbour mask bits: an edge/corner bit is set when that neighbour is a
// *different* autotile kind, i.e. when a border must be drawn on that side.
const L = 1;
const U = 2;
const R = 4;
const D = 8;
const UL = 16;
const UR = 32;
const LR = 64;
const LL = 128;

/** Clockwise from upper-left, each with the two edges it sits between. */
const CORNERS = [
  { bit: UL, edges: L | U },
  { bit: UR, edges: U | R },
  { bit: LR, edges: R | D },
  { bit: LL, edges: D | L },
];

/** Open-edge combinations in the order FLOOR_AUTOTILE_TABLE lists them. */
const EDGE_GROUPS = [
  0,
  L,
  U,
  R,
  D,
  L | R,
  U | D,
  L | U,
  U | R,
  R | D,
  L | D,
  L | U | R,
  L | U | D,
  L | R | D,
  U | R | D,
  L | U | R | D,
];

/** Index into CORNERS of the corner immediately clockwise past the first open edge. */
function startCorner(edges: number): number {
  const first = [L, U, R, D].findIndex((edge) => (edges & edge) !== 0);
  return first < 0 ? 0 : first;
}

const FLOOR_SHAPES = ((): Map<number, number> => {
  const table = new Map<number, number>();
  let shape = 0;
  for (const edges of EDGE_GROUPS) {
    const start = startCorner(edges);
    // A corner only has a shape of its own where both its edges connect: with
    // one of them open, the border already runs through that corner.
    const applicable: number[] = [];
    for (let i = 0; i < CORNERS.length; i++) {
      const corner = CORNERS[(start + i) % CORNERS.length];
      if ((edges & corner.edges) === 0) applicable.push(corner.bit);
    }
    for (let combo = 0; combo < 1 << applicable.length; combo++) {
      let corners = 0;
      for (let i = 0; i < applicable.length; i++) {
        if (combo & (1 << i)) corners |= applicable[i];
      }
      table.set(edges | corners, shape++);
    }
  }
  return table;
})();

/** Reads a tile, clamping out-of-bounds reads to the nearest edge tile — see shapeAt. */
export function tileAt(data: number[], width: number, height: number, layer: number, x: number, y: number): number {
  const cx = Math.min(Math.max(x, 0), width - 1);
  const cy = Math.min(Math.max(y, 0), height - 1);
  // Plan §2.1: MZ packs all six layers into one flat array in this order.
  return data[(layer * height + cy) * width + cx] ?? 0;
}

export function tileIndex(width: number, height: number, layer: number, x: number, y: number): number {
  return (layer * height + y) * width + x;
}

/**
 * The shape a tile should have given its neighbours, or null if it isn't an
 * autotile (B-E tiles and A5 have no shapes).
 *
 * Out-of-bounds neighbours are clamped, i.e. treated as continuing the edge
 * tile — so an autotile painted to the map border draws no seam there, which is
 * what the editor does when you bucket-fill a whole map. R1/R9-class assumption
 * (no spec exists); it is this one `tileAt` clamp if it ever needs correcting.
 */
export function shapeAt(
  data: number[],
  width: number,
  height: number,
  layer: number,
  x: number,
  y: number
): number | null {
  const tile = tileAt(data, width, height, layer, x, y);
  if (!isAutotile(tile)) return null;

  const kind = autotileKind(tile);
  const same = (dx: number, dy: number): boolean => {
    const neighbour = tileAt(data, width, height, layer, x + dx, y + dy);
    return isAutotile(neighbour) && autotileKind(neighbour) === kind;
  };

  let mask = 0;
  if (!same(-1, 0)) mask |= L;
  if (!same(0, -1)) mask |= U;
  if (!same(1, 0)) mask |= R;
  if (!same(0, 1)) mask |= D;

  switch (autotileFamily(tile)) {
    case 'wall':
      // WALL_AUTOTILE_TABLE is 16 entries indexed by the edge mask itself.
      return mask & 0xf;
    case 'waterfall':
      // WATERFALL_AUTOTILE_TABLE is 4 entries; a waterfall only borders sideways.
      return (mask & L ? 1 : 0) | (mask & R ? 2 : 0);
    default:
      if (!(mask & (L | U)) && !same(-1, -1)) mask |= UL;
      if (!(mask & (U | R)) && !same(1, -1)) mask |= UR;
      if (!(mask & (R | D)) && !same(1, 1)) mask |= LR;
      if (!(mask & (D | L)) && !same(-1, 1)) mask |= LL;
      return FLOOR_SHAPES.get(mask)!;
  }
}

/**
 * Rewrites the shape bits of every autotile in `[x, y, w, h]` grown by one tile
 * on each side — painting a tile changes its neighbours' shapes too, so the
 * margin is not optional. Shapes are derived from the *pre-existing* data
 * (a copy), so the pass is order-independent: a tile whose neighbour is
 * rewritten first still sees that neighbour's kind, which is all it reads.
 */
export function applyAutotiles(
  data: number[],
  width: number,
  height: number,
  layer: number,
  region: { x: number; y: number; width: number; height: number }
): void {
  const source = data.slice();
  const x0 = Math.max(0, region.x - 1);
  const y0 = Math.max(0, region.y - 1);
  const x1 = Math.min(width - 1, region.x + region.width);
  const y1 = Math.min(height - 1, region.y + region.height);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const shape = shapeAt(source, width, height, layer, x, y);
      if (shape === null) continue;
      const tile = tileAt(source, width, height, layer, x, y);
      data[tileIndex(width, height, layer, x, y)] = makeAutotileId(autotileKind(tile), shape);
    }
  }
}
