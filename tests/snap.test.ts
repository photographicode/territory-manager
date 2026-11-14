import { describe, expect, it } from 'vitest';
import { snapToLines, snapToNeighbours } from '../src/geo/snap';
import type { Area } from '../src/types';

const sq = (x0: number, y0: number, x1: number, y1: number): Area => ({
  type: 'Polygon',
  coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
});
const ring = (a: Area) => (a as { coordinates: number[][][] }).coordinates[0];
const D = 0.00005; // about 5 m

describe('snapping', () => {
  it('moves only border points near a road onto it', () => {
    const road: [number, number][] = [[77.425, 8.17 + D], [77.445, 8.17 + D]];
    const [r] = snapToLines([sq(77.43, 8.17, 77.44, 8.18)], [road]);
    expect(ring(r)[0][1]).toBeCloseTo(8.17 + D, 7); // bottom edge now on the road
    expect(ring(r)).toContainEqual([77.44, 8.18]); // top corners untouched
    expect(ring(r)).toContainEqual([77.43, 8.18]);
  });

  it('closes a small gap between neighbours', () => {
    const [ra, rb] = snapToNeighbours([sq(77.43, 8.17, 77.44, 8.18), sq(77.44 + D, 8.17, 77.45, 8.18)]);
    const ax = Math.max(...ring(ra).map((p) => p[0]));
    const bx = Math.min(...ring(rb).map((p) => p[0]));
    expect(Math.abs(ax - bx)).toBeLessThan(1e-9);
  });

  it('closes a gap to the congregation outline', () => {
    const outline = sq(77.43 - D, 8.17, 77.45, 8.18);
    const [ra] = snapToNeighbours([sq(77.43, 8.17, 77.44, 8.18)], 10, outline);
    expect(Math.min(...ring(ra).map((p) => p[0]))).toBeCloseTo(77.43 - D, 9);
  });

  it('does not add points when run again', () => {
    const tri: Area = { type: 'Polygon', coordinates: [[[77.44 + D, 8.17], [77.45, 8.175], [77.44 + D, 8.18], [77.44 + D, 8.17]]] };
    const zig: Area = { type: 'Polygon', coordinates: [[[77.43, 8.17], [77.44, 8.17], [77.4401, 8.172], [77.44, 8.174], [77.4401, 8.176], [77.44, 8.18], [77.43, 8.18], [77.43, 8.17]]] };
    const once = snapToNeighbours([zig, tri]);
    let again = once;
    for (let i = 0; i < 4; i++) again = snapToNeighbours(again);
    expect(ring(again[0]).length).toBeLessThanOrEqual(ring(once[0]).length + 2);
    expect(ring(again[1]).length).toBeLessThanOrEqual(ring(once[1]).length + 2);
  });

  it('leaves far-apart territories alone', () => {
    const a = sq(77.43, 8.17, 77.44, 8.18);
    const [ra] = snapToNeighbours([a, sq(77.46, 8.17, 77.47, 8.18)]);
    expect(ra).toEqual(a);
  });
});
