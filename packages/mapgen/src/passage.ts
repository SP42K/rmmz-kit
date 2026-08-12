import type { MapData, ProjectSession, Tileset } from '@rmmz-kit/core';
import { mapFileName } from '@rmmz-kit/core';
import { TILE_ID_MAX, tileIndex } from './autotile.js';

/**
 * Tileset passage flags and the connectivity check they feed (plan §3 M7:
 * "通行度／地形標籤設定" and "連通性驗證").
 *
 * `Tilesets.json`'s `flags` is one 8192-entry array indexed by tile id — every
 * tile the tileset can draw, whether or not the tileset uses it. The bit layout
 * is ported from `Game_Map.checkPassage`/`isLadder`/`terrainTag`; the direction
 * bits are *blocked* flags, so 0 means passable.
 */
export const FLAGS_LENGTH = TILE_ID_MAX;

const PASSAGE_BITS = { down: 0x01, left: 0x02, right: 0x04, up: 0x08 } as const;
const BOOL_BITS = {
  /** ★ in the editor: drawn above the player and exempt from passage checks entirely. */
  star: 0x10,
  ladder: 0x20,
  bush: 0x40,
  counter: 0x80,
  damage: 0x100,
} as const;

export type Direction = keyof typeof PASSAGE_BITS;

export interface TileFlagSpec {
  tileId: number;
  /** Per-direction passability; true = passable. Omitted directions keep their current bit. */
  passage?: Partial<Record<Direction, boolean>>;
  star?: boolean;
  ladder?: boolean;
  bush?: boolean;
  counter?: boolean;
  damage?: boolean;
  /** 0-7, the editor's terrain tag. Lives in the high nibble (`flag >> 12`). */
  terrainTag?: number;
}

/** A flags array MZ can index for every tile id. Anything shorter crashes on first step (M6.5 gap #1). */
export function defaultTilesetFlags(): number[] {
  return new Array<number>(FLAGS_LENGTH).fill(0);
}

function applyFlag(current: number, spec: TileFlagSpec): number {
  let flag = current;
  for (const [direction, bit] of Object.entries(PASSAGE_BITS)) {
    const passable = spec.passage?.[direction as Direction];
    if (passable === undefined) continue;
    flag = passable ? flag & ~bit : flag | bit;
  }
  for (const [name, bit] of Object.entries(BOOL_BITS)) {
    const value = spec[name as keyof typeof BOOL_BITS];
    if (value === undefined) continue;
    flag = value ? flag | bit : flag & ~bit;
  }
  if (spec.terrainTag !== undefined) {
    if (!Number.isInteger(spec.terrainTag) || spec.terrainTag < 0 || spec.terrainTag > 7) {
      throw new Error(`Terrain tag must be an integer in 0..7, got ${JSON.stringify(spec.terrainTag)}`);
    }
    flag = (flag & 0x0fff) | (spec.terrainTag << 12);
  }
  return flag;
}

/**
 * Edits individual tiles' flags in one tileset. `upsert_database` can already
 * write `flags`, but only as a whole 8192-element array — which is not something
 * a caller can produce by hand without clobbering every other tile.
 */
export function setTileFlags(session: ProjectSession, tilesetId: number, specs: TileFlagSpec[]): void {
  session.updateFile<Array<Tileset | null>>('Tilesets.json', (data) => {
    const tileset = data[tilesetId];
    if (!tileset) throw new Error(`Tileset ${tilesetId} does not exist`);
    // Validate every spec before writing any: `data` is mutated in place, so a
    // throw halfway through would leave a partly-applied edit behind.
    for (const spec of specs) {
      if (!Number.isInteger(spec.tileId) || spec.tileId < 0 || spec.tileId >= FLAGS_LENGTH) {
        throw new Error(`Tile id must be an integer in 0..${FLAGS_LENGTH - 1}, got ${JSON.stringify(spec.tileId)}`);
      }
      applyFlag(0, spec);
    }
    if (!Array.isArray(tileset.flags) || tileset.flags.length < FLAGS_LENGTH) {
      const flags = defaultTilesetFlags();
      for (let i = 0; i < (tileset.flags?.length ?? 0); i++) flags[i] = tileset.flags[i];
      tileset.flags = flags;
    }
    for (const spec of specs) {
      tileset.flags[spec.tileId] = applyFlag(tileset.flags[spec.tileId], spec);
    }
  });
}

/**
 * `Game_Map.checkPassage` for one tile: layers 3 down to 0, first definite
 * answer wins, ★ tiles abstain, an exhausted stack is impassable.
 *
 * Note this makes tile id 0 load-bearing. It is not "no tile" to MZ — it is the
 * first B-sheet tile, and every stock tileset flags it ★ so that empty upper
 * layers abstain instead of voting "passable". A tileset that doesn't
 * (`defaultTilesetFlags`'s all-zero array, say) reads as passable everywhere,
 * walls included, which is exactly the misconfiguration composeMap's
 * connectivity assertion is there to catch.
 */
export function checkPassage(map: MapData, flags: number[], x: number, y: number, direction: Direction): boolean {
  const bit = PASSAGE_BITS[direction];
  for (let layer = 3; layer >= 0; layer--) {
    const tile = map.data[tileIndex(map.width, map.height, layer, x, y)] ?? 0;
    const flag = flags[tile] ?? 0;
    if ((flag & BOOL_BITS.star) !== 0) continue;
    return (flag & bit) === 0;
  }
  return false;
}

export interface Reachability {
  /** Sizes of each connected walkable region, largest first. A well-formed map has one. */
  regionSizes: number[];
  /** Event ids that no tile of the largest region can walk onto. */
  unreachableEvents: number[];
}

/**
 * Flood-fills walkable tiles the way a player walks them: a step from A to B
 * needs A passable *out* and B passable *in*, which is how one-way tiles (cliff
 * edges) stay one-way. Used to make compose_map's connectivity guarantee an
 * assertion rather than a claim.
 */
export function analyzeReachability(session: ProjectSession, mapId: number): Reachability {
  const map = session.readFile<MapData>(mapFileName(mapId));
  const tilesets = session.readFile<Array<Tileset | null>>('Tilesets.json');
  const flags = tilesets[map.tilesetId]?.flags ?? [];

  const steps: Array<[number, number, Direction, Direction]> = [
    [0, -1, 'up', 'down'],
    [0, 1, 'down', 'up'],
    [-1, 0, 'left', 'right'],
    [1, 0, 'right', 'left'],
  ];

  const region = new Int32Array(map.width * map.height).fill(-1);
  const regionSizes: number[] = [];

  for (let startY = 0; startY < map.height; startY++) {
    for (let startX = 0; startX < map.width; startX++) {
      const start = startY * map.width + startX;
      if (region[start] !== -1) continue;
      if (!steps.some(([, , out]) => checkPassage(map, flags, startX, startY, out))) continue;

      const id = regionSizes.length;
      const queue = [[startX, startY] as [number, number]];
      region[start] = id;
      let size = 0;
      while (queue.length > 0) {
        const [x, y] = queue.pop()!;
        size++;
        for (const [dx, dy, out, back] of steps) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
          if (region[ny * map.width + nx] !== -1) continue;
          if (!checkPassage(map, flags, x, y, out)) continue;
          if (!checkPassage(map, flags, nx, ny, back)) continue;
          region[ny * map.width + nx] = id;
          queue.push([nx, ny]);
        }
      }
      regionSizes.push(size);
    }
  }

  const largest = regionSizes.indexOf(Math.max(0, ...regionSizes));
  const unreachableEvents: number[] = [];
  for (const event of map.events) {
    if (!event) continue;
    // An event is reachable if the player can stand next to it; standing *on*
    // it isn't required (an NPC is impassable, and is talked to from beside it).
    const adjacent = steps.some(([dx, dy]) => {
      const x = event.x + dx;
      const y = event.y + dy;
      return x >= 0 && y >= 0 && x < map.width && y < map.height && region[y * map.width + x] === largest;
    });
    if (!adjacent) unreachableEvents.push(event.id);
  }

  return { regionSizes: [...regionSizes].sort((a, b) => b - a), unreachableEvents };
}
