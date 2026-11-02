import { describe, expect, it } from 'vitest';
import { decodeArea, encodeArea } from '../src/geo/codec';
import { mergeAreas, splitByLine } from '../src/geo/core';
import type { Area, OsmData } from '../src/types';

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

describe('automatic split', () => {
  it('puts every house in exactly one territory, even with roads along the edge', async () => {
    const { autoSplit } = await import('../src/geo/core');
    // A 6×6 grid of streets, including streets that run exactly along the boundary.
    const lines: OsmData['lines'] = [];
    for (let i = 0; i <= 6; i++) {
      const v = 9.88 + i * (0.01 / 6);
      const h = 76.3 + i * (0.01 / 6);
      lines.push({ level: 2, coords: [[76.3, v], [76.31, v]] }, { level: 2, coords: [[h, 9.88], [h, 9.89]] });
    }
    const buildings: [number, number][] = [];
    for (let x = 0; x < 60; x++) for (let y = 0; y < 60; y++) buildings.push([76.3 + (x + 0.5) * (0.01 / 60), 9.88 + (y + 0.5) * (0.01 / 60)]);
    const osm: OsmData = { bbox: [76.3, 9.88, 76.31, 9.89], fetchedAt: '', lines, water: [], buildings, places: [] };
    const result = autoSplit(square, osm, { min: 150, max: 250, levels: [true, true, true, true] });
    expect(result.reduce((a, r) => a + r.buildings, 0)).toBe(buildings.length);
    expect(result.every((r) => r.buildings <= 250 * 1.15)).toBe(true);
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
