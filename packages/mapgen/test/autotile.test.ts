import { describe, expect, it } from 'vitest';
import {
  TILE_ID_A1,
  TILE_ID_A2,
  TILE_ID_A3,
  TILE_ID_A4,
  applyAutotiles,
  autotileFamily,
  autotileShape,
  makeAutotileId,
  shapeAt,
  tileIndex,
} from '../src/index.js';

/**
 * `.` is a different autotile kind, any other character is the kind under test.
 * Only layer 0 is populated; the grid is exactly as wide/tall as written.
 */
function grid(rows: string[], kindTile: number): { data: number[]; width: number; height: number } {
  const width = rows[0].length;
  const height = rows.length;
  const other = kindTile === TILE_ID_A2 ? TILE_ID_A2 + 48 : TILE_ID_A2;
  const data = new Array<number>(width * height * 6).fill(0);
  rows.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      data[tileIndex(width, height, 0, x, y)] = cell === '.' ? other : kindTile;
    });
  });
  return { data, width, height };
}

function shapeOfCenter(rows: string[], kindTile = TILE_ID_A2): number {
  const { data, width, height } = grid(rows, kindTile);
  return shapeAt(data, width, height, 0, (width - 1) / 2, (height - 1) / 2)!;
}

describe('floor autotile shapes', () => {
  it('gives an interior tile shape 0 and an isolated tile shape 46', () => {
    expect(shapeOfCenter(['###', '###', '###'])).toBe(0);
    expect(shapeOfCenter(['...', '.#.', '...'])).toBe(46);
  });

  it('numbers the four single-open-edge groups left, top, right, bottom', () => {
    expect(shapeOfCenter(['###', '.##', '###'])).toBe(16);
    expect(shapeOfCenter(['#.#', '###', '###'])).toBe(20);
    expect(shapeOfCenter(['###', '##.', '###'])).toBe(24);
    expect(shapeOfCenter(['###', '###', '#.#'])).toBe(28);
  });

  it('sets one concave-corner bit per diagonal, clockwise from upper-left', () => {
    expect(shapeOfCenter(['.##', '###', '###'])).toBe(1);
    expect(shapeOfCenter(['##.', '###', '###'])).toBe(2);
    expect(shapeOfCenter(['###', '###', '##.'])).toBe(4);
    expect(shapeOfCenter(['###', '###', '.##'])).toBe(8);
    // A diagonal is only a corner where both its edges connect: open the edge
    // next to it and the bit goes away rather than adding to the edge's shape.
    expect(shapeOfCenter(['.##', '.##', '###'])).toBe(16);
  });

  it('enumerates a single-open-edge group\'s corners cyclically past that edge', () => {
    // Right edge open, lower-left corner cut. MZ's FLOOR_AUTOTILE_TABLE orders
    // this group (lower-left, upper-left), so this is 25 and not 26 — the one
    // place a plain upper-left-first enumeration gets the wrong answer.
    expect(shapeOfCenter(['#####', '###.#', '###.#', '#.###', '#####'])).toBe(25);
    expect(shapeOfCenter(['#####', '#.#.#', '###.#', '#####', '#####'])).toBe(26);
  });

  it('produces every shape 0..46 across the 256 neighbour configurations, and no others', () => {
    const shapes = new Set<number>();
    for (let mask = 0; mask < 256; mask++) {
      const cells = [...'01234567'].map((_, bit) => (mask & (1 << bit) ? '.' : '#'));
      shapes.add(
        shapeOfCenter([
          cells.slice(0, 3).join(''),
          `${cells[3]}#${cells[4]}`,
          cells.slice(5).join(''),
        ])
      );
    }
    expect([...shapes].sort((a, b) => a - b)).toEqual(Array.from({ length: 47 }, (_, i) => i));
  });
});

describe('autotile families', () => {
  it('classifies A1 water, A2 floor, A3 wall and A4 by kind', () => {
    expect(autotileFamily(TILE_ID_A1)).toBe('floor');
    expect(autotileFamily(TILE_ID_A1 + 192 + 48)).toBe('waterfall');
    expect(autotileFamily(TILE_ID_A2)).toBe('floor');
    expect(autotileFamily(TILE_ID_A3)).toBe('wall');
    expect(autotileFamily(TILE_ID_A4)).toBe('floor');
    expect(autotileFamily(TILE_ID_A4 + 8 * 48)).toBe('wall');
  });

  it('shapes a wall with the 16-entry edge mask and ignores its corners', () => {
    const wall = TILE_ID_A3;
    expect(shapeOfCenter(['###', '###', '###'], wall)).toBe(0);
    expect(shapeOfCenter(['###', '.##', '###'], wall)).toBe(1); // left
    expect(shapeOfCenter(['#.#', '###', '###'], wall)).toBe(2); // up
    expect(shapeOfCenter(['#.#', '.##', '###'], wall)).toBe(3); // left + up
    expect(shapeOfCenter(['...', '.#.', '...'], wall)).toBe(15);
    // A cut diagonal alone changes nothing for a wall.
    expect(shapeOfCenter(['.####', '#####', '#####', '#####', '#####'], wall)).toBe(0);
  });

  it('shapes a waterfall from its left and right neighbours only', () => {
    const fall = TILE_ID_A1 + 192 + 48;
    expect(shapeOfCenter(['###', '###', '###'], fall)).toBe(0);
    expect(shapeOfCenter(['###', '.##', '###'], fall)).toBe(1);
    expect(shapeOfCenter(['###', '##.', '###'], fall)).toBe(2);
    expect(shapeOfCenter(['###', '.#.', '###'], fall)).toBe(3);
    expect(shapeOfCenter(['#.#', '###', '#.#'], fall)).toBe(0); // top/bottom never border
  });
});

describe('applyAutotiles', () => {
  it('reshapes the painted region and the one-tile margin around it', () => {
    const width = 5;
    const height = 5;
    const data = new Array<number>(width * height * 6).fill(TILE_ID_A2);
    // Whole map is one kind: every shape is 0 once derived.
    applyAutotiles(data, width, height, 0, { x: 0, y: 0, width, height });
    expect(data.slice(0, width * height).every((tile) => autotileShape(tile) === 0)).toBe(true);

    // Punch a hole; only its neighbours' shapes may move.
    data[tileIndex(width, height, 0, 2, 2)] = TILE_ID_A2 + 48;
    applyAutotiles(data, width, height, 0, { x: 2, y: 2, width: 1, height: 1 });
    expect(autotileShape(data[tileIndex(width, height, 0, 2, 1)])).toBe(28); // below-open
    expect(autotileShape(data[tileIndex(width, height, 0, 1, 2)])).toBe(24); // right-open
    expect(autotileShape(data[tileIndex(width, height, 0, 1, 1)])).toBe(4); // lower-right corner
    expect(autotileShape(data[tileIndex(width, height, 0, 0, 0)])).toBe(0); // outside the margin
  });

  it('treats out-of-bounds neighbours as a continuation of the edge tile', () => {
    const data = new Array<number>(3 * 3 * 6).fill(TILE_ID_A2);
    applyAutotiles(data, 3, 3, 0, { x: 0, y: 0, width: 3, height: 3 });
    expect(data[tileIndex(3, 3, 0, 0, 0)]).toBe(makeAutotileId(16, 0));
  });
});
