import type { MapData, ProjectSession } from '@rmmz-kit/core';
import { mapFileName } from '@rmmz-kit/core';
import { TILE_ID_A2, TILE_ID_A4, autotileKind, isAutotile, makeAutotileId } from './autotile.js';
import { createMap, paintTiles } from './edit.js';
import { analyzeReachability, setTileFlags } from './passage.js';

/**
 * L3.5 map composition (plan §3 M7, "後半：合成").
 *
 * BSP rather than prefab stitching. The plan's other option was 20-30
 * hand-drawn prefabs, which is content authoring against a tileset this repo
 * doesn't ship (fixtures/minimal-project has no real MZ art) — a prefab drawn
 * against guessed tile ids is worth less than a rectangle drawn against the
 * caller's. BSP also gets the acceptance criterion that is actually checkable
 * for free: every room is carved inside a node of a binary tree and every
 * internal node joins its two children with a corridor, so the walkable area is
 * connected by construction, not by a repair pass. `analyzeReachability` then
 * asserts it against the real passage flags rather than trusting the argument.
 *
 * What is deliberately not here: the plan's decoration rules (furniture against
 * walls, doorways kept clear) and the "looks hand-made >= 70%" half of the
 * acceptance criterion. Both need a real tileset's B-E tiles to place, and both
 * are judgement, not algorithm.
 */

/** Seeded PRNG (mulberry32), duplicated from battlesim rather than depended on — five lines, no coupling. */
class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  int(n: number): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  }

  /** Inclusive on both ends. */
  between(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComposeSpec {
  name: string;
  width?: number;
  height?: number;
  tilesetId?: number;
  parentId?: number;
  /** Autotile kind base id for room floors. Default A2 kind 0. */
  floorTileId?: number;
  /** Autotile kind base id for the surrounding solid. Default A4 kind 0 (wall top). */
  wallTileId?: number;
  /** Smallest room side, walls excluded. Default 4. */
  minRoom?: number;
  /** Stop splitting once a partition is this small; larger = fewer, bigger rooms. Default 12. */
  minPartition?: number;
  seed?: number;
  /**
   * Write passage flags for the two tiles so the result is walkable as drawn.
   * Off if the caller's tileset already has real flags. Default true.
   */
  setFlags?: boolean;
}

export interface ComposeResult {
  mapId: number;
  /** Carved room rectangles, in the order generated — where to put events. */
  rooms: Rect[];
  /** Sizes of the walkable regions found afterwards; always length 1. */
  regionSizes: number[];
}

interface Bsp {
  /** Partitions that were never split — one room is carved in each. */
  leaves: Rect[];
  /** Every internal node's two children — one corridor is drawn between each pair. */
  pairs: Array<[Rect, Rect]>;
}

function splitPartitions(rng: Rng, root: Rect, minPartition: number): Bsp {
  const leaves: Rect[] = [];
  const pairs: Array<[Rect, Rect]> = [];
  const stack: Rect[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;
    const canSplitH = node.height >= minPartition * 2;
    const canSplitV = node.width >= minPartition * 2;
    if (!canSplitH && !canSplitV) {
      leaves.push(node);
      continue;
    }
    // Prefer splitting the long axis, so rooms stay roughly square instead of
    // degenerating into corridors.
    const horizontal = canSplitH && (!canSplitV || node.height > node.width || (node.height === node.width && rng.int(2) === 0));
    let left: Rect;
    let right: Rect;
    if (horizontal) {
      const cut = rng.between(minPartition, node.height - minPartition);
      left = { ...node, height: cut };
      right = { ...node, y: node.y + cut, height: node.height - cut };
    } else {
      const cut = rng.between(minPartition, node.width - minPartition);
      left = { ...node, width: cut };
      right = { ...node, x: node.x + cut, width: node.width - cut };
    }
    pairs.push([left, right]);
    stack.push(left, right);
  }

  return { leaves, pairs };
}

function carveRoom(rng: Rng, partition: Rect, minRoom: number): Rect {
  // Inset by 1 on every side so neighbouring rooms always have a wall between
  // them; the partition itself is wall-to-wall.
  const maxWidth = partition.width - 2;
  const maxHeight = partition.height - 2;
  const width = rng.between(Math.min(minRoom, maxWidth), maxWidth);
  const height = rng.between(Math.min(minRoom, maxHeight), maxHeight);
  return {
    x: partition.x + 1 + rng.int(maxWidth - width + 1),
    y: partition.y + 1 + rng.int(maxHeight - height + 1),
    width,
    height,
  };
}

function center(rect: Rect): [number, number] {
  return [rect.x + (rect.width >> 1), rect.y + (rect.height >> 1)];
}

function roomIn(rooms: Rect[], partition: Rect): Rect | undefined {
  return rooms.find(
    (room) =>
      room.x >= partition.x &&
      room.y >= partition.y &&
      room.x + room.width <= partition.x + partition.width &&
      room.y + room.height <= partition.y + partition.height
  );
}

/**
 * Generates a connected room-and-corridor map and creates it in the session.
 * The caller then places events with `upsert_map_event` using the returned
 * room rectangles — per the plan's own warning, the LLM picks *where things
 * go*, this picks where the walls are.
 */
export function composeMap(session: ProjectSession, spec: ComposeSpec): ComposeResult {
  const width = spec.width ?? 33;
  const height = spec.height ?? 25;
  const minRoom = spec.minRoom ?? 4;
  const minPartition = spec.minPartition ?? 12;
  const floorTileId = spec.floorTileId ?? TILE_ID_A2;
  const wallTileId = spec.wallTileId ?? TILE_ID_A4;
  const rng = new Rng(spec.seed ?? 0);

  if (!Number.isInteger(minRoom) || minRoom < 1) {
    throw new Error(`minRoom must be an integer >= 1, got ${JSON.stringify(minRoom)}`);
  }
  if (minPartition < minRoom + 2) {
    throw new Error(`minPartition (${minPartition}) must be at least minRoom + 2 (${minRoom + 2}) to leave room for walls`);
  }
  if (width < minPartition || height < minPartition) {
    throw new Error(`Map ${width}x${height} is smaller than one ${minPartition}x${minPartition} partition`);
  }

  const { leaves, pairs } = splitPartitions(rng, { x: 0, y: 0, width, height }, minPartition);
  const rooms = leaves.map((leaf) => carveRoom(rng, leaf, minRoom));

  const mapId = createMap(session, {
    name: spec.name,
    width,
    height,
    tilesetId: spec.tilesetId,
    parentId: spec.parentId,
    fillTileId: wallTileId,
  });

  const ops = rooms.map((room) => ({ ...room, tileId: floorTileId }));

  // One L-shaped corridor per internal BSP node, joining a room from each
  // child. Every leaf is under exactly one chain of these, so the union is
  // connected — this is the whole reason to use BSP rather than scattered rooms.
  for (const [left, right] of pairs) {
    const a = roomIn(rooms, left);
    const b = roomIn(rooms, right);
    if (!a || !b) continue;
    const [ax, ay] = center(a);
    const [bx, by] = center(b);
    const horizontalFirst = rng.int(2) === 0;
    const corner: [number, number] = horizontalFirst ? [bx, ay] : [ax, by];
    for (const [[x1, y1], [x2, y2]] of [
      [[ax, ay], corner],
      [corner, [bx, by]],
    ] as Array<[[number, number], [number, number]]>) {
      ops.push({
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1) + 1,
        height: Math.abs(y2 - y1) + 1,
        tileId: floorTileId,
      });
    }
  }

  paintTiles(session, { mapId, ops, layer: 0, autotile: true });

  if (spec.setFlags ?? true) {
    ensureFlags(session, session.readFile<MapData>(mapFileName(mapId)).tilesetId, floorTileId, wallTileId);
  }

  const { regionSizes } = analyzeReachability(session, mapId);
  if (regionSizes.length !== 1) {
    // The corridor pass is supposed to make this unreachable. If it ever fires,
    // the map is still in the session uncommitted — throwing leaves a caller
    // that rolls back with nothing written.
    throw new Error(
      `Composed map ${mapId} is not connected: ${regionSizes.length} walkable regions (${regionSizes.join(', ')})`
    );
  }

  return { mapId, rooms, regionSizes };
}

/** Every tile id one autotile kind can produce — flags are per shape, not per kind. */
function shapesOf(tileId: number): number[] {
  if (!isAutotile(tileId)) return [tileId];
  const base = makeAutotileId(autotileKind(tileId), 0);
  return Array.from({ length: 48 }, (_, shape) => base + shape);
}

/**
 * A generated map is only walkable if the tileset says so, and a project built
 * by this toolchain may have a tileset with all-zero flags (which reads as
 * "everything passable, walls included"). Set the tiles we drew, and only
 * those — the caller's other tiles are their business.
 */
function ensureFlags(session: ProjectSession, tilesetId: number, floorTileId: number, wallTileId: number): void {
  const blocked = { down: false, left: false, right: false, up: false };
  const open = { down: true, left: true, right: true, up: true };
  setTileFlags(session, tilesetId, [
    // The empty upper layers stack tile 0 above every tile on the map; without
    // ★ its flags outvote layer 0 and nothing is ever solid. Stock MZ tilesets
    // ship it this way — see checkPassage.
    { tileId: 0, star: true },
    ...shapesOf(floorTileId).map((tileId) => ({ tileId, passage: open })),
    ...shapesOf(wallTileId).map((tileId) => ({ tileId, passage: blocked })),
  ]);
}
