import { describe, expect, it } from 'vitest';
import { decodeArea, encodeArea } from '../src/geo/codec';
import { mergeAreas, splitByLine } from '../src/geo/core';
import type { Area } from '../src/types';

const square: Area = { type: 'Polygon', coordinates: [[[76.3, 9.88], [76.31, 9.88], [76.31, 9.89], [76.3, 9.89], [76.3, 9.88]]] };

describe('QR outline codec', () => {
  it('round-trips an outline to ~1 m', () => {
    const back = decodeArea(encodeArea(square));
    expect(back.type).toBe('Polygon');
    const c = (back as GeoJSON.Polygon).coordinates[0];
    expect(c).toHaveLength(5);
    expect(c[1][0]).toBeCloseTo(76.31, 5);
    expect(c[2][1]).toBeCloseTo(9.89, 5);
  });
  it('produces URL-safe text', () => {
    expect(encodeArea(square)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('cut and merge', () => {
  it('cuts a territory in two along a line and merges it back', () => {
    const halves = splitByLine(square, [[76.305, 9.87], [76.305, 9.9]]);
    expect(halves).toHaveLength(2);
    const merged = mergeAreas(halves);
    expect(merged.type).toBe('Polygon');
  });
  it('ignores a line that does not cross the territory', () => {
    expect(splitByLine(square, [[76.305, 9.87], [76.305, 9.885]])).toHaveLength(1);
  });
});
