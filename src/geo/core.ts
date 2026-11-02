// Geometry engine: splitting along roads/water/rail, merging, manual cuts and house counts.
// Coordinates are lon/lat degrees; topology is computed with JSTS on a 1e-6° (~0.1 m) grid.
import 'jsts/org/locationtech/jts/monkey.js';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory.js';
import PrecisionModel from 'jsts/org/locationtech/jts/geom/PrecisionModel.js';
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import Location from 'jsts/org/locationtech/jts/geom/Location.js';
import GeometryNoder from 'jsts/org/locationtech/jts/noding/snapround/GeometryNoder.js';
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import UnaryUnionOp from 'jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js';
import IndexedPointInAreaLocator from 'jsts/org/locationtech/jts/algorithm/locate/IndexedPointInAreaLocator.js';
import TopologyPreservingSimplifier from 'jsts/org/locationtech/jts/simplify/TopologyPreservingSimplifier.js';
import ArrayList from 'jsts/java/util/ArrayList.js';
import GeometryPrecisionReducer from 'jsts/org/locationtech/jts/precision/GeometryPrecisionReducer.js';
import { MAX_TERRITORIES, type Area, type OsmData } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type G = any;

const PM = new PrecisionModel(1e6);
const factory = new GeometryFactory();
const reader = new GeoJSONReader(factory);
const writer = new GeoJSONWriter();

export const toJsts = (g: Area | GeoJSON.Geometry): G => reader.read(g);

export function toArea(g: G): Area {
  const polys = polygonsOf(g).filter((p: G) => p.getArea() > 0);
  if (polys.length === 1) return writer.write(polys[0]);
  return writer.write(factory.createMultiPolygon(polys));
}

function polygonsOf(g: G): G[] {
  const out: G[] = [];
  for (let i = 0; i < g.getNumGeometries(); i++) {
    const p = g.getGeometryN(i);
    if (p.getGeometryType() === 'Polygon') out.push(p);
    else if (p.getNumGeometries && p.getNumGeometries() > 1) out.push(...polygonsOf(p));
  }
  return out;
}

/** Repair self-intersections (e.g. from a hand-drawn KML) without changing the shape. */
export function clean(g: G): G {
  return g.isValid() ? g : g.buffer(0);
}

const list = (items: G[]) => {
  const l = new (ArrayList as any)();
  items.forEach((i) => l.add(i));
  return l;
};

/**
 * Noded lines as single segments, each once. Roads that run along the area's edge or along each
 * other give the same segment twice, and the polygonizer then drops the faces on either side.
 */
function uniqueSegments(lines: G[]): G[] {
  const seen = new Set<string>();
  const out: G[] = [];
  for (const l of lines) {
    const c = l.getCoordinates();
    for (let i = 1; i < c.length; i++) {
      const a = c[i - 1];
      const b = c[i];
      if (a.x === b.x && a.y === b.y) continue;
      const k = a.x < b.x || (a.x === b.x && a.y < b.y) ? `${a.x},${a.y},${b.x},${b.y}` : `${b.x},${b.y},${a.x},${a.y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(factory.createLineString([new Coordinate(a.x, a.y), new Coordinate(b.x, b.y)]));
    }
  }
  return out;
}

/** Split an area into faces formed by the given lines. Lines that do not cut through are ignored. */
export function polygonize(area: G, lines: G[]): G[] {
  const env = area.getEnvelopeInternal();
  const near = lines.filter((l) => env.intersects(l.getEnvelopeInternal()));
  const crossing = near.filter((l) => area.intersects(l));
  if (!crossing.length) return [area];
  const edges = [area.getBoundary(), ...crossing];
  const noded = new GeometryNoder(PM).node(list(edges));
  const pz = new Polygonizer();
  pz.add(list(uniqueSegments(noded.toArray())));
  const faces: G[] = pz.getPolygons().toArray();
  const loc = new IndexedPointInAreaLocator(area);
  const inside = faces.filter((f) => loc.locate(f.getInteriorPoint().getCoordinate()) === Location.INTERIOR);
  if (!inside.length) return [area];
  // The polygonizer can still skip an awkward face; add any part not covered back, so no ground is lost.
  const whole = area.getArea();
  if (whole - inside.reduce((a, f) => a + f.getArea(), 0) > whole * 1e-7) {
    try {
      inside.push(...polygonsOf(area.difference(union(inside))).filter((g) => g.getArea() > whole * 1e-9));
    } catch {
      // Rare geometry error: try with the faces snapped to the grid, else keep the faces found.
      try {
        const snapped = union(inside.map((f) => GeometryPrecisionReducer.reduce(f, PM)));
        inside.push(...polygonsOf(area.difference(snapped)).filter((g) => g.getArea() > whole * 1e-9));
      } catch {
        /* keep the faces found */
      }
    }
  }
  return inside;
}

/** Grid index over building positions for fast counting. */
export class BuildingIndex {
  private cells = new Map<string, [number, number][]>();
  private size = 0.002; // ~200 m
  constructor(points: [number, number][]) {
    for (const p of points) {
      const k = this.key(p[0], p[1]);
      const c = this.cells.get(k);
      if (c) c.push(p);
      else this.cells.set(k, [p]);
    }
  }
  private key(x: number, y: number) {
    return `${Math.floor(x / this.size)}:${Math.floor(y / this.size)}`;
  }
  points(g: G): [number, number][] {
    const e = g.getEnvelopeInternal();
    const loc = new IndexedPointInAreaLocator(g);
    const out: [number, number][] = [];
    for (let x = Math.floor(e.getMinX() / this.size); x <= Math.floor(e.getMaxX() / this.size); x++)
      for (let y = Math.floor(e.getMinY() / this.size); y <= Math.floor(e.getMaxY() / this.size); y++)
        for (const p of this.cells.get(`${x}:${y}`) ?? [])
          if (e.contains(p[0], p[1]) && loc.locate(new Coordinate(p[0], p[1])) !== Location.EXTERIOR) out.push(p);
    return out;
  }
  count(g: G): number {
    return this.points(g).length;
  }
}

interface Piece {
  g: G;
  n: number;
  /** Set when the piece was cut by a straight line because no road crossed it. */
  straight?: boolean;
}

export function union(geoms: G[]): G {
  try {
    return UnaryUnionOp.union(list(geoms));
  } catch {
    return UnaryUnionOp.union(list(geoms.map((g) => g.buffer(1e-7)))).buffer(-1e-7);
  }
}

/** 1 for a circle, lower for long or ragged shapes (Polsby–Popper). */
function compactness(g: G): number {
  const p = g.getLength();
  return p ? (4 * Math.PI * g.getArea()) / (p * p) : 0;
}

/** Progress inside one stage: what is happening, and how far along that stage is (0–1). */
export type Beat = (detail: string, fraction: number) => void;
const noBeat: Beat = () => {};
/** Map a beat's 0–1 onto the part [from, to] of a bigger job. */
const part = (beat: Beat, from: number, to: number): Beat => (d, f) => beat(d, from + (to - from) * Math.min(1, Math.max(0, f)));

/** Smallest-first queue for mergeSmall. */
class MinHeap<T> {
  private a: T[] = [];
  constructor(private less: (x: T, y: T) => boolean) {}
  get size() {
    return this.a.length;
  }
  push(x: T) {
    const a = this.a;
    a.push(x);
    for (let i = a.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length && last !== undefined) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

/** Outline segments of a polygon or multipolygon, ring by ring: [x1, y1, x2, y2]. */
function segmentsOf(g: G): number[][] {
  const out: number[][] = [];
  for (const poly of polygonsOf(g)) {
    const rings = [poly.getExteriorRing()];
    for (let i = 0; i < poly.getNumInteriorRing(); i++) rings.push(poly.getInteriorRingN(i));
    for (const r of rings) {
      const c = r.getCoordinates();
      for (let i = 1; i < c.length; i++) out.push([c[i - 1].x, c[i - 1].y, c[i].x, c[i].y]);
    }
  }
  return out;
}

/** Squared distance from point (px, py) to segment [x1, y1, x2, y2]. */
function segDist2(px: number, py: number, [x1, y1, x2, y2]: number[]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return (px - x1 - t * dx) ** 2 + (py - y1 - t * dy) ** 2;
}

/**
 * Length of border each piece shares with each other piece. A segment counts as shared when its
 * middle lies on another piece's outline (within ~0.3 m), so pieces cut separately still match.
 * Linear in the number of outline segments, unlike pairwise geometry intersections.
 */
function neighbourLengths(pieces: Piece[], beat: Beat = noBeat): Map<number, number>[] {
  const CELL = 0.0005; // ~55 m
  const TOL2 = 3e-6 ** 2;
  const grid = new Map<string, { s: number[]; owner: number }[]>();
  const segs = pieces.map((p) => segmentsOf(p.g));
  segs.forEach((list, owner) => {
    for (const s of list)
      for (let x = Math.floor(Math.min(s[0], s[2]) / CELL); x <= Math.floor(Math.max(s[0], s[2]) / CELL); x++)
        for (let y = Math.floor(Math.min(s[1], s[3]) / CELL); y <= Math.floor(Math.max(s[1], s[3]) / CELL); y++) {
          const k = `${x}:${y}`;
          const cell = grid.get(k);
          if (cell) cell.push({ s, owner });
          else grid.set(k, [{ s, owner }]);
        }
  });
  const seen: Map<number, number>[] = pieces.map(() => new Map());
  segs.forEach((list, i) => {
    beat(`Finding neighbours: piece ${i + 1} of ${pieces.length}`, i / pieces.length);
    for (const s of list) {
      const mx = (s[0] + s[2]) / 2;
      const my = (s[1] + s[3]) / 2;
      const hit = new Set<number>();
      for (const c of grid.get(`${Math.floor(mx / CELL)}:${Math.floor(my / CELL)}`) ?? [])
        if (c.owner !== i && !hit.has(c.owner) && segDist2(mx, my, c.s) < TOL2) hit.add(c.owner);
      const len = Math.hypot(s[2] - s[0], s[3] - s[1]);
      for (const j of hit) seen[i].set(j, (seen[i].get(j) ?? 0) + len);
    }
  });
  // Each side measured the border from its own segments; use the longer of the two, on both sides.
  const out = pieces.map(() => new Map<number, number>());
  seen.forEach((m, i) =>
    m.forEach((len, j) => {
      const v = Math.max(len, out[i].get(j) ?? 0);
      out[i].set(j, v);
      out[j].set(i, v);
    }),
  );
  return out;
}

/** Test for points lying on (within ~0.3 m of) an outline, using a grid of its segments. */
function outlineTest(g: G): (x: number, y: number) => boolean {
  const CELL = 0.0005;
  const TOL2 = 3e-6 ** 2;
  const grid = new Map<string, number[][]>();
  for (const s of segmentsOf(g))
    for (let x = Math.floor((Math.min(s[0], s[2]) - 3e-6) / CELL); x <= Math.floor((Math.max(s[0], s[2]) + 3e-6) / CELL); x++)
      for (let y = Math.floor((Math.min(s[1], s[3]) - 3e-6) / CELL); y <= Math.floor((Math.max(s[1], s[3]) + 3e-6) / CELL); y++) {
        const k = `${x}:${y}`;
        const cell = grid.get(k);
        if (cell) cell.push(s);
        else grid.set(k, [s]);
      }
  return (x, y) => (grid.get(`${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`) ?? []).some((s) => segDist2(x, y, s) < TOL2);
}

/** Lines that run into the area's interior, not just along its edge. */
function linesInto(area: G, lines: G[]): G[] {
  const env = area.getEnvelopeInternal();
  const near = lines.filter((l) => env.intersects(l.getEnvelopeInternal()));
  if (!near.length) return [];
  const loc = new IndexedPointInAreaLocator(area);
  const onEdge = outlineTest(area);
  return near.filter((l) => l.getCoordinates().some((c: G) => loc.locate(c) === Location.INTERIOR && !onEdge(c.x, c.y)));
}

/**
 * Merge pieces with fewer than `min` buildings into a neighbour. Prefers the neighbour that keeps
 * the joined territory compact and shares a long border, so leftovers don't wrap around others.
 * Neighbours and shared border lengths are worked out once; after that, joining only adds numbers
 * (area, perimeter, shared length), and the outlines are joined once at the end.
 */
function mergeSmall(pieces: Piece[], min: number, max: number, beat: Beat = noBeat, allowOver = true, until?: number): Piece[] {
  // With `until`, keep joining the smallest pieces (whatever their size) until only that many are left.
  if (until === undefined ? !pieces.some((p) => p.n < min) : pieces.length <= until) return pieces;
  const nodes = pieces.map((p) => ({
    n: p.n,
    area: p.g.getArea(),
    perim: p.g.getLength(),
    straight: !!p.straight,
    members: [p.g] as G[],
    nbs: new Map<number, number>(),
    alive: true,
  }));
  neighbourLengths(pieces, part(beat, 0, 0.4)).forEach((m, i) => (nodes[i].nbs = m));

  type Entry = { n: number; area: number; id: number };
  const heap = new MinHeap<Entry>((a, b) => a.n < b.n || (a.n === b.n && a.area < b.area));
  const wanted = (x: (typeof nodes)[number]) => until !== undefined || x.n < min;
  nodes.forEach((x, id) => wanted(x) && heap.push({ n: x.n, area: x.area, id }));
  const smallAtStart = until !== undefined ? pieces.length - until : heap.size;
  let alive = pieces.length;
  let joins = 0;
  while (heap.size && (until === undefined || alive > until)) {
    const { n, id } = heap.pop()!;
    const p = nodes[id];
    if (!p.alive || p.n !== n || !p.nbs.size) continue; // already joined, changed since queued, or isolated
    const cands = [...p.nbs].map(([j, len]) => ({ j, len, q: nodes[j] }));
    const fits = cands.filter((c) => c.q.n + p.n <= max);
    if (!fits.length && !allowOver) continue;
    let best: { j: number; perim: number; score: number } | undefined;
    for (const c of fits.length ? fits : cands) {
      const perim = p.perim + c.q.perim - 2 * c.len;
      const compact = perim > 0 ? (4 * Math.PI * (p.area + c.q.area)) / (perim * perim) : 0;
      const over = Math.max(0, c.q.n + p.n - max) / max;
      const score = 0.5 * Math.min(1, c.len / p.perim) + 0.5 * compact - over;
      if (!best || score > best.score) best = { j: c.j, perim, score };
    }
    const q = nodes[best!.j];
    q.members.push(...p.members);
    q.n += p.n;
    q.area += p.area;
    q.perim = best!.perim;
    q.straight ||= p.straight;
    q.nbs.delete(id);
    for (const [k, len] of p.nbs) {
      if (k === best!.j) continue;
      q.nbs.set(k, (q.nbs.get(k) ?? 0) + len);
      const nk = nodes[k].nbs;
      nk.delete(id);
      nk.set(best!.j, (nk.get(best!.j) ?? 0) + len);
    }
    p.alive = false;
    p.nbs.clear();
    alive--;
    if (wanted(q)) heap.push({ n: q.n, area: q.area, id: best!.j });
    if (++joins % 25 === 0) beat(`Joining small pieces: ${joins} joined`, 0.4 + 0.3 * Math.min(1, joins / smallAtStart));
  }

  const left = nodes.filter((x) => x.alive);
  return left.map((x, i) => {
    if (x.members.length > 1) beat(`Joining outlines: ${i + 1} of ${left.length}`, 0.7 + (0.3 * i) / left.length);
    return { g: x.members.length === 1 ? x.members[0] : union(x.members), n: x.n, ...(x.straight ? { straight: true } : {}) };
  });
}

export interface SplitOptions {
  min: number;
  max: number;
  levels: boolean[];
  /** Make exactly this many territories (as near as the map allows). Never more than MAX_TERRITORIES. */
  count?: number;
  /** What is happening, and how far along the whole split is (0–1). */
  onProgress?: (msg: string, fraction: number) => void;
}

export interface SplitResult {
  geometry: Area;
  buildings: number;
  straightCut?: boolean;
}

/** Lengthen both ends of a road by `ext` degrees in the direction it is heading. */
function extend(coords: G[], ext: number): G {
  const out = coords.map((c: G) => new Coordinate(c.x, c.y));
  const push = (a: G, b: G) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    return new Coordinate(b.x + (dx / d) * ext, b.y + (dy / d) * ext);
  };
  if (ext > 0 && out.length > 1) {
    out.push(push(out[out.length - 2], out[out.length - 1]));
    out.unshift(push(out[1], out[0]));
  }
  return factory.createLineString(out);
}

/** Most roads tried when looking for a cut; the longest ones are tried first. */
const MAX_CUT_TRIES = 80;

/**
 * Split a piece that no road fully crosses. Tries roads inside it, lengthening dead ends a little
 * until they reach the edge, and keeps the cut that shares the houses most evenly.
 * Falls back to a straight line through the middle house only when no road works.
 */
function cutAlongRoads(piece: Piece, roads: G[], index: BuildingIndex, min: number, beat: Beat = noBeat): Piece[] {
  // Only roads that run into the piece; roads along its edge can't cut it.
  let inside = linesInto(piece.g, roads);
  if (inside.length > MAX_CUT_TRIES) inside = inside.sort((a, b) => b.getLength() - a.getLength()).slice(0, MAX_CUT_TRIES);
  const exts = [0, 0.0006, 0.0015, 0.003]; // ~0, 65, 165 and 330 m
  let best: { faces: Piece[]; score: number } | null = null;
  for (const [ei, ext] of exts.entries()) {
    for (const [ri, r] of inside.entries()) {
      beat(`Trying road ${ri + 1} of ${inside.length} as a border${ext ? ' (lengthened)' : ''}`, (ei * inside.length + ri) / (exts.length * inside.length));
      const line = extend(r.getCoordinates(), ext);
      const faces = polygonize(piece.g, [line]);
      if (faces.length < 2) continue;
      const counted = faces.map((g) => ({ g, n: index.count(g) }));
      const parts = counted.length > 2 ? mergeSmall(counted, min, Infinity) : counted;
      if (parts.length < 2) continue;
      const ns = parts.map((f) => f.n);
      const balance = Math.min(...ns) / Math.max(...ns, 1);
      const shape = Math.min(...parts.map((f) => compactness(f.g)));
      const score = balance + 0.3 * shape - ext * 150; // prefer real roads over long extensions
      if (Math.min(...ns) >= min * 0.4 && (!best || score > best.score)) best = { faces: parts, score };
    }
    if (best && best.score > 0.55) break;
  }
  return best ? best.faces : halve(piece, index);
}

/** Cut a piece in two with a straight line through the middle house, across its longer side. */
function halve(piece: Piece, index: BuildingIndex): Piece[] {
  const e = piece.g.getEnvelopeInternal();
  const pts = index.points(piece.g);
  const wide = (e.getMaxX() - e.getMinX()) * Math.cos((e.centre().y * Math.PI) / 180) > e.getMaxY() - e.getMinY();
  const vals = pts.map((p) => (wide ? p[0] : p[1])).sort((a, b) => a - b);
  // Cut between the two middle houses, not through one, so no house lands on the border.
  const mid = Math.floor(vals.length / 2);
  const above = vals.slice(mid).find((v) => v > vals[mid - 1]) ?? vals[mid];
  const m = mid > 0 ? (vals[mid - 1] + above) / 2 : vals[mid];
  const pad = 0.001;
  const line = wide
    ? [new Coordinate(m, e.getMinY() - pad), new Coordinate(m, e.getMaxY() + pad)]
    : [new Coordinate(e.getMinX() - pad, m), new Coordinate(e.getMaxX() + pad, m)];
  const faces = polygonize(piece.g, [factory.createLineString(line)]);
  if (faces.length < 2) return [piece];
  return faces.map((g) => ({ g, n: index.count(g), straight: true }));
}

/**
 * Take lakes and rivers out of the area. Water up to POND_MAX_M2 is left in, since those ponds
 * become part of their territory anyway; the rest is joined first, then cut out once.
 */
function removeWater(area: G, water: Area[], beat: Beat): G {
  const env = area.getEnvelopeInternal();
  const hits: G[] = [];
  for (const [i, w] of water.entries()) {
    beat(`Checking water area ${i + 1} of ${water.length}`, (0.4 * i) / water.length);
    try {
      const wg = clean(toJsts(w));
      if (env.intersects(wg.getEnvelopeInternal()) && areaM2(wg) > POND_MAX_M2 && area.intersects(wg)) hits.push(wg);
    } catch {
      /* skip broken water polygons */
    }
  }
  if (!hits.length) return area;
  try {
    beat(`Combining ${hits.length} lakes, ponds and rivers`, 0.4);
    const wet = union(hits);
    beat('Cutting the water out of the boundary', 0.7);
    return area.difference(wet);
  } catch {
    // Some water shapes don't combine cleanly; cut them out one by one instead.
    let a = area;
    for (const [i, w] of hits.entries()) {
      beat(`Cutting out water area ${i + 1} of ${hits.length}`, 0.4 + (0.6 * i) / hits.length);
      try {
        a = a.difference(w);
      } catch {
        /* leave this one in */
      }
    }
    return a;
  }
}

const LEVEL_NAMES = ['main roads, rivers and railways', 'secondary roads', 'local roads and streams', 'lanes and footpaths'];

export interface SplitStage {
  name: string;
  /** Rough share of the total time, used to turn stage progress into overall progress. */
  weight: number;
  run(pieces: Piece[], beat: Beat): Piece[];
}

/**
 * The split as a list of stages that each take and return the current pieces, so progress can be
 * saved between stages and a split that stops can carry on from the last finished stage.
 * Stage 1 ignores its input and starts from the boundary.
 */
export function splitStages(boundary: Area, osm: OsmData, opt: SplitOptions): SplitStage[] {
  const index = new BuildingIndex(osm.buildings);
  const area = clean(toJsts(boundary));
  const byLevel = [0, 1, 2, 3].map((lv) =>
    opt.levels[lv]
      ? osm.lines.filter((l) => l.level === lv && l.coords.length > 1).map((l) => factory.createLineString(l.coords.map(([x, y]) => new Coordinate(x, y))))
      : [],
  );
  const levels = byLevel.map((ls, i) => ({ ls, i })).filter((l) => l.ls.length);
  const allRoads = levels.flatMap((l) => l.ls);
  const tooBig = (p: Piece) => p.n > opt.max * 1.15;
  const notSliver = (p: Piece) => p.n > 0 || p.g.getArea() > 1e-6;
  // Bigger roads already cut the pieces; only those that end inside a piece are added again.
  const levelLines = (k: number, piece: G) => [...levels[k].ls, ...linesInto(piece, levels.slice(0, k).flatMap((l) => l.ls))];

  const count = (gs: G[], beat: Beat): Piece[] =>
    gs.map((g, i) => {
      beat(`Counting houses in block ${i + 1} of ${gs.length}`, i / gs.length);
      return { g, n: index.count(g) };
    });

  // Cut along dead-end roads (or a straight line as a last resort) until every piece fits.
  const roadCut = (piece: Piece, beat: Beat, depth = 0): Piece[] => {
    if (!tooBig(piece) || depth > 6) return [piece];
    const halves = cutAlongRoads(piece, allRoads, index, opt.min, part(beat, 0, 0.5));
    if (halves.length < 2) return halves;
    const total = halves.reduce((a, h) => a + h.n, 0) || 1;
    let done = 0;
    return halves.flatMap((h) => {
      const from = 0.5 + (0.5 * done) / total;
      done += h.n;
      return roadCut(h, part(beat, from, 0.5 + (0.5 * done) / total), depth + 1);
    });
  };

  // Run `work` on every piece that `needs` it; progress is the share of those pieces' houses done.
  const eachPiece =
    (needs: (p: Piece) => boolean, work: (p: Piece, beat: Beat) => Piece[]) =>
    (ps: Piece[], beat: Beat): Piece[] => {
      const todo = ps.filter(needs);
      const total = todo.reduce((a, p) => a + p.n, 0) || 1;
      let done = 0;
      let k = 0;
      return ps.flatMap((p) => {
        if (!needs(p)) return [p];
        k++;
        const from = done / total;
        done += p.n;
        const label = `Piece ${k} of ${todo.length} (${p.n.toLocaleString()} houses)`;
        return work(p, (d, f) => beat(`${label}: ${d}`, from + (done / total - from) * f));
      });
    };

  return [
    {
      name: 'Removing lakes and rivers',
      weight: 1,
      run: (_, beat) => count(polygonsOf(removeWater(area, osm.water, part(beat, 0, 0.9))), part(beat, 0.9, 1)),
    },
    // Each level also uses the bigger roads, so a lane that ends on a residential road still closes a block.
    ...levels.map(({ i }, k) => ({
      name: `Cutting along ${LEVEL_NAMES[i]}`,
      weight: 3,
      run: eachPiece(
        (p) => p.n > opt.max,
        (p, beat) => {
          beat('Finding where the roads cross', 0);
          const faces = polygonize(p.g, levelLines(k, p.g));
          if (faces.length === 1) return [p];
          const counted = count(faces, part(beat, 0.2, 0.4));
          return mergeSmall(counted, opt.min, opt.max, part(beat, 0.4, 1));
        },
      ),
    })),
    { name: 'Cutting big pieces along dead-end roads', weight: 2, run: eachPiece(tooBig, roadCut) },
    { name: 'Joining small leftover pieces', weight: 1, run: (ps, beat) => mergeSmall(ps, opt.min, opt.max, beat) },
    { name: 'Re-cutting territories that grew too big', weight: 1, run: eachPiece(tooBig, roadCut) },
    // Re-cutting can leave small pieces again; join them only where that keeps within the maximum.
    { name: 'Tidying small pieces', weight: 1, run: (ps, beat) => mergeSmall(ps, opt.min, opt.max, beat, false) },
    {
      name: 'Matching the number of territories',
      weight: 1,
      run: (all, beat) => {
        // Empty slivers (road islands, water edges) are dropped first so they don't count as territories.
        const ps = all.filter(notSliver);
        const target = Math.min(opt.count || Infinity, MAX_TERRITORIES);
        if (ps.length > target) return mergeSmall(ps, opt.min, opt.max, beat, true, target);
        if (!opt.count || ps.length >= target) return ps;
        // Too few: cut the biggest territory along roads until there are enough.
        let out = [...ps];
        const real = () => out.filter(notSliver).length;
        for (let tries = 0; real() < target && tries < target * 2; tries++) {
          beat(`${real()} of ${target} territories; cutting the biggest one`, real() / target);
          const big = out.reduce((a, p) => (p.n > a.n ? p : a));
          const halves = cutAlongRoads(big, allRoads, index, Math.min(opt.min, big.n / 4));
          if (halves.filter(notSliver).length < 2) break;
          out = [...out.filter((p) => p !== big), ...halves];
        }
        // Fold empty slivers left by the cuts into their neighbours, then trim any overshoot.
        out = mergeSmall(out, 1, Infinity, beat).filter(notSliver);
        return out.length > target ? mergeSmall(out, opt.min, opt.max, beat, true, target) : out;
      },
    },
    {
      name: 'Including small ponds',
      weight: 1,
      run: (ps, beat) => {
        const kept = ps.filter(notSliver);
        const filled = fillPonds(
          kept.map((p) => p.g),
          area,
          beat,
        );
        return kept.map((p, i) => ({ ...p, g: filled[i] }));
      },
    },
  ];
}

export const toResults = (ps: Piece[]): SplitResult[] =>
  ps.map((p) => ({ geometry: toArea(p.g), buildings: p.n, ...(p.straight ? { straightCut: true } : {}) }));
export const fromResults = (rs: SplitResult[]): Piece[] =>
  rs.map((r) => ({ g: toJsts(r.geometry), n: r.buildings, ...(r.straightCut ? { straight: true } : {}) }));

/** Combine stage progress into one overall message and fraction. */
export function overall(stages: Pick<SplitStage, 'name' | 'weight'>[], i: number, f: number) {
  const total = stages.reduce((a, s) => a + s.weight, 0);
  const before = stages.slice(0, i).reduce((a, s) => a + s.weight, 0);
  return { stage: `Stage ${i + 1} of ${stages.length}: ${stages[i].name}`, fraction: (before + stages[i].weight * f) / total };
}

/**
 * Split a congregation boundary into territories, all stages in one go.
 * Cuts along the biggest borders first (rail, rivers, main roads), and only uses smaller roads
 * and lanes inside pieces that still hold more than `max` houses.
 */
export function autoSplit(boundary: Area, osm: OsmData, opt: SplitOptions): SplitResult[] {
  const stages = splitStages(boundary, osm, opt);
  let ps: Piece[] = [];
  let last = 0;
  for (const [i, s] of stages.entries()) {
    ps = s.run(ps, (d, f) => {
      if (Date.now() - last < 120) return;
      last = Date.now();
      const o = overall(stages, i, f);
      opt.onProgress?.(`${o.stage} — ${d}`, o.fraction);
    });
  }
  return toResults(ps);
}

/** Cut an area with a hand-drawn line. Returns the original area if the line does not cross it. */
export function splitByLine(area: Area, line: [number, number][]): Area[] {
  const g = clean(toJsts(area));
  const l = factory.createLineString(line.map(([x, y]) => new Coordinate(x, y)));
  return polygonize(g, [l]).map(toArea);
}

export function mergeAreas(areas: Area[]): Area {
  return toArea(union(areas.map((a) => clean(toJsts(a)))));
}

export function areasTouch(a: Area, b: Area): boolean {
  return clean(toJsts(a)).buffer(1e-5).intersects(clean(toJsts(b)));
}

export function simplify(area: Area, tolerance: number): Area {
  return toArea(TopologyPreservingSimplifier.simplify(toJsts(area), tolerance));
}

export function interiorPoint(area: Area): [number, number] {
  const c = clean(toJsts(area)).getInteriorPoint().getCoordinate();
  return [c.x, c.y];
}

/** Order territories in a north-to-south sweep, west-to-east within each band. */
export function sweepOrder<T extends { geometry: Area }>(items: T[]): T[] {
  const pts = items.map((t) => ({ t, p: interiorPoint(t.geometry) }));
  if (!pts.length) return [];
  const ys = pts.map((x) => x.p[1]);
  const span = Math.max(...ys) - Math.min(...ys);
  const bands = Math.max(1, Math.round(Math.sqrt(items.length)));
  const h = span / bands || 1;
  const top = Math.max(...ys);
  return pts
    .map((x) => ({ ...x, band: Math.min(bands - 1, Math.floor((top - x.p[1]) / h)) }))
    .sort((a, b) => a.band - b.band || (a.band % 2 ? b.p[0] - a.p[0] : a.p[0] - b.p[0]))
    .map((x) => x.t);
}

export function countBuildings(index: BuildingIndex, area: Area): number {
  return index.count(clean(toJsts(area)));
}

const PLACE_RANK = ['neighbourhood', 'quarter', 'suburb', 'hamlet', 'locality', 'village', 'isolated_dwelling', 'town'];

/** Name of the most specific OSM place inside the area, or the nearest one; `lang` is e.g. 'en' or 'ml'. */
export function suggestLocality(area: Area, places: OsmData['places'], lang: string): string {
  if (!places?.length) return '';
  const g = clean(toJsts(area));
  const loc = new IndexedPointInAreaLocator(g);
  const name = (p: OsmData['places'][number]) => p.names[lang] ?? p.names.default;
  const inside = places.filter((p) => loc.locate(new Coordinate(p.at[0], p.at[1])) !== Location.EXTERIOR);
  if (inside.length) return name(inside.sort((a, b) => PLACE_RANK.indexOf(a.kind) - PLACE_RANK.indexOf(b.kind))[0]);
  const c = g.getInteriorPoint().getCoordinate();
  const d = (p: OsmData['places'][number]) => (p.at[0] - c.x) ** 2 + (p.at[1] - c.y) ** 2;
  return name(places.reduce((a, b) => (d(b) < d(a) ? b : a)));
}

/** Ponds up to this size (m²) inside a territory become part of it instead of a hole. */
export const POND_MAX_M2 = 100_000; // 10 ha

function areaM2(g: G): number {
  const lat = g.getEnvelopeInternal().centre().y;
  return g.getArea() * 111_320 * 111_320 * Math.cos((lat * Math.PI) / 180);
}

/**
 * Remove small holes (ponds, tanks) from territories. A hole is kept when it is large, when it
 * holds another territory, or when it is a hole in the congregation boundary itself.
 */
function fillPonds(geoms: G[], boundary?: G, beat: Beat = noBeat): G[] {
  const inner = geoms.map((g) => g.getInteriorPoint().getCoordinate());
  return geoms.map((g, gi) => {
    beat(`Checking territory ${gi + 1} of ${geoms.length} for ponds`, gi / geoms.length);
    const polys = polygonsOf(g).map((poly) => {
      const holes = [];
      for (let i = 0; i < poly.getNumInteriorRing(); i++) {
        const ring = poly.getInteriorRingN(i);
        const hole = factory.createPolygon(ring);
        const loc = new IndexedPointInAreaLocator(hole);
        const env = hole.getEnvelopeInternal();
        const keep =
          areaM2(hole) > POND_MAX_M2 ||
          inner.some((c: G, j: number) => j !== gi && env.contains(c) && loc.locate(c) !== Location.EXTERIOR) ||
          (!!boundary && boundaryHasHole(boundary, hole));
        if (keep) holes.push(factory.createLinearRing(ring.getCoordinates()));
      }
      return factory.createPolygon(factory.createLinearRing(poly.getExteriorRing().getCoordinates()), holes);
    });
    return polys.length === 1 ? polys[0] : factory.createMultiPolygon(polys);
  });
}

/** True when `hole` lies in one of the boundary's own holes (e.g. another congregation's enclave). */
function boundaryHasHole(boundary: G, hole: G): boolean {
  const p = hole.getInteriorPoint().getCoordinate();
  for (const poly of polygonsOf(boundary))
    for (let i = 0; i < poly.getNumInteriorRing(); i++) {
      const h = factory.createPolygon(poly.getInteriorRingN(i));
      if (new IndexedPointInAreaLocator(h).locate(p) !== Location.EXTERIOR) return true;
    }
  return false;
}

/** Fill pond holes in existing territories (used from the Review step). */
export function fillPondsInAreas(areas: Area[]): Area[] {
  return fillPonds(areas.map((a) => clean(toJsts(a)))).map(toArea);
}
