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

describe('ponds', () => {
  it('makes a small pond part of the territory but keeps a large lake out', async () => {
    const { fillPondsInAreas } = await import('../src/geo/core');
    const pond = [[76.304, 9.884], [76.3045, 9.884], [76.3045, 9.8845], [76.304, 9.8845], [76.304, 9.884]]; // ~55 m square
    const lake = [[76.301, 9.881], [76.309, 9.881], [76.309, 9.889], [76.301, 9.889], [76.301, 9.881]]; // ~870 m square
    const withPond: Area = { type: 'Polygon', coordinates: [square.coordinates[0], pond] };
    const withLake: Area = { type: 'Polygon', coordinates: [square.coordinates[0], lake] };
    const [a, b] = fillPondsInAreas([withPond, withLake]);
    expect((a as GeoJSON.Polygon).coordinates).toHaveLength(1);
    expect((b as GeoJSON.Polygon).coordinates).toHaveLength(2);
  });
});
