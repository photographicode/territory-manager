import { describe, expect, it } from 'vitest';
import { decodeArea, encodeArea } from '../src/geo/codec';
import { mergeAreas, refineAreas, splitByLine } from '../src/geo/core';
import type { Area, Assignment, OsmData, Territory } from '../src/types';
import { s13Rows, serviceYearOf } from '../src/card/s13';

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
  it('merges territories whose edges are a hair apart into one shape with no seam', () => {
    const left: Area = { type: 'Polygon', coordinates: [[[76.3, 9.88], [76.305, 9.88], [76.305, 9.89], [76.3, 9.89], [76.3, 9.88]]] };
    // About 1 cm to the east, with a corner part-way along the shared edge.
    const right: Area = { type: 'Polygon', coordinates: [[[76.3050001, 9.88], [76.31, 9.88], [76.31, 9.89], [76.3050001, 9.89], [76.3050001, 9.885], [76.3050001, 9.88]]] };
    const merged = mergeAreas([left, right]);
    expect(merged.type).toBe('Polygon');
    expect((merged as GeoJSON.Polygon).coordinates).toHaveLength(1);
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

  it('makes the number of territories asked for, with even house counts', async () => {
    const { autoSplit } = await import('../src/geo/core');
    // A 12×12 grid of streets with 25 houses per block: 3,600 houses into 12 territories of ~300.
    const lines: OsmData['lines'] = [];
    for (let i = 0; i <= 12; i++) {
      const v = 9.88 + i * (0.01 / 12);
      const h = 76.3 + i * (0.01 / 12);
      lines.push({ level: 2, coords: [[76.3, v], [76.31, v]] }, { level: 2, coords: [[h, 9.88], [h, 9.89]] });
    }
    const buildings: [number, number][] = [];
    for (let x = 0; x < 60; x++) for (let y = 0; y < 60; y++) buildings.push([76.3 + (x + 0.5) * (0.01 / 60), 9.88 + (y + 0.5) * (0.01 / 60)]);
    const osm: OsmData = { bbox: [76.3, 9.88, 76.31, 9.89], fetchedAt: '', lines, water: [], buildings, places: [] };
    const result = autoSplit(square, osm, { min: 210, max: 390, levels: [true, true, true, true], count: 12 });
    expect(result).toHaveLength(12);
    expect(result.reduce((a, r) => a + r.buildings, 0)).toBe(buildings.length);
    for (const r of result) expect(Math.abs(r.buildings - 300)).toBeLessThanOrEqual(300 * 0.1);
  });

  it('can make territories equal in area even when the houses are bunched up', async () => {
    const { autoSplit, areaKm2 } = await import('../src/geo/core');
    const lines: OsmData['lines'] = [];
    for (let i = 0; i <= 12; i++) {
      const v = 9.88 + i * (0.01 / 12);
      const h = 76.3 + i * (0.01 / 12);
      lines.push({ level: 2, coords: [[76.3, v], [76.31, v]] }, { level: 2, coords: [[h, 9.88], [h, 9.89]] });
    }
    // All 900 houses in the south-west quarter.
    const buildings: [number, number][] = [];
    for (let x = 0; x < 30; x++) for (let y = 0; y < 30; y++) buildings.push([76.3 + (x + 0.5) * (0.005 / 30), 9.88 + (y + 0.5) * (0.005 / 30)]);
    const osm: OsmData = { bbox: [76.3, 9.88, 76.31, 9.89], fetchedAt: '', lines, water: [], buildings, places: [] };
    const result = autoSplit(square, osm, { min: 52, max: 98, levels: [true, true, true, true], count: 12, evenBy: 'area' });
    expect(result).toHaveLength(12);
    expect(result.reduce((a, r) => a + r.buildings, 0)).toBe(buildings.length);
    const areas = result.map((r) => areaKm2(r.geometry));
    const avg = areas.reduce((a, b) => a + b, 0) / areas.length;
    for (const a of areas) expect(Math.abs(a - avg)).toBeLessThanOrEqual(avg * 0.15);
  });
});

describe('narrow strips', () => {
  it('hands a thin tail to the neighbour it runs along', async () => {
    const { trimStrips, BuildingIndex, toJsts } = await import('../src/geo/core');
    // Territory 0: a block plus a 22 m wide, 890 m long strip running along the top of territory 1.
    const t0: Area = { type: 'Polygon', coordinates: [[[0, 0.005], [0.01, 0.005], [0.01, 0.0052], [0.002, 0.0052], [0.002, 0.01], [0, 0.01], [0, 0.005]]] };
    const t1: Area = { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0.01, 0.005], [0, 0.005], [0, 0]]] };
    const index = new BuildingIndex([[0.001, 0.008], [0.005, 0.002]]);
    const before = [toJsts(t0), toJsts(t1)];
    const [a, b] = trimStrips(before.map((g) => ({ g, n: index.count(g) })), index);
    expect(a.g.getArea()).toBeLessThan(before[0].getArea() - 1.4e-6); // the strip is about 1.6e-6
    expect(b.g.getArea()).toBeGreaterThan(before[1].getArea() + 1.4e-6);
    expect(a.g.getArea() + b.g.getArea()).toBeCloseTo(before[0].getArea() + before[1].getArea(), 10);
    expect(a.g.getNumGeometries()).toBe(1);
    expect(b.g.getNumGeometries()).toBe(1);
    expect(a.n + b.n).toBe(2);
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

const bboxOf = (a: Area) => {
  const pts = (a.type === 'Polygon' ? a.coordinates : a.coordinates.flat()).flat();
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
};

describe('snap to roads', () => {
  it('moves a border drawn 22 m off a road onto the road, and keeps the outer edge', () => {
    const rect = (w: number, e: number): Area => ({ type: 'Polygon', coordinates: [[[w, 9.88], [e, 9.88], [e, 9.89], [w, 9.89], [w, 9.88]]] });
    const road = (coords: [number, number][]) => ({ level: 2, coords });
    const osm = {
      bbox: [76.29, 9.87, 76.32, 9.9],
      fetchedAt: '',
      water: [],
      buildings: [],
      places: [],
      lines: [
        road([[76.305, 9.87], [76.305, 9.9]]),
        road([[76.3, 9.87], [76.3, 9.9]]),
        road([[76.31, 9.87], [76.31, 9.9]]),
        road([[76.29, 9.88], [76.32, 9.88]]),
        road([[76.29, 9.89], [76.32, 9.89]]),
      ],
    } as OsmData;
    const [a, b] = refineAreas([rect(76.3, 76.3048), rect(76.3048, 76.31)], osm);
    expect(bboxOf(a)[2]).toBeCloseTo(76.305, 5);
    expect(bboxOf(b)[0]).toBeCloseTo(76.305, 5);
    expect(bboxOf(a)[0]).toBeCloseTo(76.3, 5);
  });
});

describe('S-13 record', () => {
  const t = (id: string, number: string) => ({ id, number, locality: '', geometry: square, buildings: 0 }) as Territory;
  const a = (territoryId: string, assignedOn: string, completedOn?: string): Assignment => ({ id: assignedOn, territoryId, publisher: 'P ' + assignedOn, assignedOn, completedOn });
  it('counts September as the start of the next service year', () => {
    expect(serviceYearOf('2025-08-31')).toBe(2025);
    expect(serviceYearOf('2025-09-01')).toBe(2026);
  });
  it('fills rows in number order, with the last completion before the year and four assignments a row', () => {
    const log = [a('x', '2025-05-01', '2025-06-01'), ...['2025-09-10', '2025-10-10', '2025-11-10', '2025-12-10', '2026-01-10'].map((d) => a('x', d, d)), a('y', '2026-09-01')];
    const rows = s13Rows([t('y', '10'), t('x', '2')], log, 2026);
    expect(rows.map((r) => r.number)).toEqual(['2', '2', '10']);
    expect(rows[0].last).toBe('2025-06-01');
    expect(rows[0].slots).toHaveLength(4);
    expect(rows[1].slots).toHaveLength(1);
    expect(rows[1].last).toBe('');
    expect(rows[2].slots).toHaveLength(0);
  });
});
