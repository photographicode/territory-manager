// Drawing style of a set of territories: house counts, size, shape, and what their inner borders
// follow (OSM line level 0..3, or nothing). Used to learn from hand-drawn maps and to check that an
// automatic split looks like them.
import { BuildingIndex, toJsts, clean, union } from './core';
import type { Area, OsmData } from '../types';

const M_LAT = 111_320;
/** Border samples further than this from any OSM line count as free-drawn. */
const NEAR_M = 20;
const STEP_M = 10;

type Pt = [number, number];
type Seg = [Pt, Pt, number];

/** Grid of segments in a local metre frame, for "nearest line" lookups. */
class SegIndex {
  private cells = new Map<string, Seg[]>();
  constructor(private cell = 50) {}
  add(a: Pt, b: Pt, tag: number) {
    const s: Seg = [a, b, tag];
    for (let x = Math.floor(Math.min(a[0], b[0]) / this.cell); x <= Math.floor(Math.max(a[0], b[0]) / this.cell); x++)
      for (let y = Math.floor(Math.min(a[1], b[1]) / this.cell); y <= Math.floor(Math.max(a[1], b[1]) / this.cell); y++) {
        const k = `${x}:${y}`;
        const c = this.cells.get(k);
        if (c) c.push(s);
        else this.cells.set(k, [s]);
      }
  }
  /** Smallest tag among segments within `r` metres of p, or -1. */
  nearTag(p: Pt, r: number): number {
    let best = -1;
    const cx = Math.floor(p[0] / this.cell);
    const cy = Math.floor(p[1] / this.cell);
    const span = Math.ceil(r / this.cell);
    for (let x = cx - span; x <= cx + span; x++)
      for (let y = cy - span; y <= cy + span; y++)
        for (const [a, b, t] of this.cells.get(`${x}:${y}`) ?? [])
          if ((best < 0 || t < best) && segDist(p, a, b) <= r) best = t;
    return best;
  }
}

function segDist(p: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

const rings = (a: Area): Pt[][] => (a.type === 'Polygon' ? a.coordinates : a.coordinates.flat()) as Pt[][];

export interface Spread {
  p10: number;
  median: number;
  p90: number;
}
export interface Style {
  houses: Spread;
  km2: Spread;
  /** Polsby-Popper compactness (1 = circle, square ≈ 0.79). */
  compact: Spread;
  /** Share of inner border length that follows each OSM level 0..3, then free-drawn. */
  border: { rail_river_main: number; secondary: number; local: number; lane_stream: number; none: number };
}

export function spread(xs: number[]): Spread {
  const s = [...xs].sort((a, b) => a - b);
  const q = (f: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : 0);
  return { p10: q(0.1), median: q(0.5), p90: q(0.9) };
}

export function styleOf(areas: Area[], osm: OsmData, index = new BuildingIndex(osm.buildings)): Style {
  const lat0 = (osm.bbox[1] + osm.bbox[3]) / 2;
  const mLon = M_LAT * Math.cos((lat0 * Math.PI) / 180);
  const m = (p: Pt): Pt => [p[0] * mLon, p[1] * M_LAT];

  const lines = new SegIndex();
  for (const l of osm.lines) for (let i = 1; i < l.coords.length; i++) lines.add(m(l.coords[i - 1]), m(l.coords[i]), l.level);
  // Water edges count like rivers.
  for (const w of osm.water) for (const r of rings(w)) for (let i = 1; i < r.length; i++) lines.add(m(r[i - 1]), m(r[i]), 0);

  const outer = new SegIndex();
  const edge = clean(union(areas.map((a) => clean(toJsts(a))))).getBoundary();
  for (let g = 0; g < edge.getNumGeometries(); g++) {
    const cs = edge.getGeometryN(g).getCoordinates();
    for (let i = 1; i < cs.length; i++) outer.add(m([cs[i - 1].x, cs[i - 1].y]), m([cs[i].x, cs[i].y]), 0);
  }

  const len = [0, 0, 0, 0, 0];
  const houses: number[] = [];
  const km2: number[] = [];
  const compact: number[] = [];
  for (const a of areas) {
    houses.push(index.count(clean(toJsts(a))));
    let perim = 0;
    let area = 0;
    for (const r of rings(a)) {
      const pts = r.map(m);
      for (let i = 1; i < pts.length; i++) {
        const [p, q] = [pts[i - 1], pts[i]];
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        perim += d;
        area += (p[0] * q[1] - q[0] * p[1]) / 2;
        for (let s = STEP_M / 2; s < d; s += STEP_M) {
          const x: Pt = [p[0] + ((q[0] - p[0]) * s) / d, p[1] + ((q[1] - p[1]) * s) / d];
          if (outer.nearTag(x, 5) >= 0) continue; // congregation edge, not a border between territories
          const t = lines.nearTag(x, NEAR_M);
          len[t < 0 ? 4 : t] += STEP_M;
        }
      }
    }
    km2.push(Math.abs(area) / 1e6);
    compact.push(perim ? (4 * Math.PI * Math.abs(area)) / (perim * perim) : 0);
  }
  const total = len.reduce((x, y) => x + y, 0) || 1;
  const share = (i: number) => Math.round((len[i] / total) * 100) / 100;
  return {
    houses: spread(houses),
    km2: spread(km2),
    compact: spread(compact),
    border: { rail_river_main: share(0), secondary: share(1), local: share(2), lane_stream: share(3), none: share(4) },
  };
}
