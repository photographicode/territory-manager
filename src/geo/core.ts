// Geometry engine: splitting along roads/water/rail, merging, manual cuts and house counts.
// Coordinates are lon/lat degrees; topology is computed with JSTS on a 1e-6° (~0.1 m) grid.
import 'jsts/org/locationtech/jts/monkey.js';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory.js';
import PrecisionModel from 'jsts/org/locationtech/jts/geom/PrecisionModel.js';
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope.js';
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
function neighbourLengths(pieces: Piece[], beat: Beat = noBeat, only?: (x: number, y: number) => boolean): Map<number, number>[] {
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
      if (only && !only(mx, my)) continue;
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

/** Test for points lying on (within ~0.5 m of) any of the lines, using a grid of their segments. */
function nearLines(lines: G[]): (x: number, y: number) => boolean {
  const CELL = 0.0005;
  const TOL = 5e-6;
  const grid = new Map<string, number[][]>();
  for (const l of lines) {
    const c = l.getCoordinates();
    for (let i = 1; i < c.length; i++) {
      const s = [c[i - 1].x, c[i - 1].y, c[i].x, c[i].y];
      for (let x = Math.floor((Math.min(s[0], s[2]) - TOL) / CELL); x <= Math.floor((Math.max(s[0], s[2]) + TOL) / CELL); x++)
        for (let y = Math.floor((Math.min(s[1], s[3]) - TOL) / CELL); y <= Math.floor((Math.max(s[1], s[3]) + TOL) / CELL); y++) {
          const k = `${x}:${y}`;
          const cell = grid.get(k);
          if (cell) cell.push(s);
          else grid.set(k, [s]);
        }
    }
  }
  return (x, y) => (grid.get(`${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`) ?? []).some((s) => segDist2(x, y, s) < TOL * TOL);
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
  const inside = (x: number, y: number) => loc.locate(new Coordinate(x, y)) === Location.INTERIOR && !onEdge(x, y);
  // Check points along each segment, not just the corners: a straight road can cross with both ends outside.
  return near.filter((l) => {
    const c = l.getCoordinates();
    if (inside(c[0].x, c[0].y)) return true;
    for (let i = 1; i < c.length; i++) {
      const a = c[i - 1];
      const b = c[i];
      if (!env.intersects(new Envelope(a.x, b.x, a.y, b.y))) continue;
      for (let s = 1; s <= 8; s++) if (inside(a.x + ((b.x - a.x) * s) / 8, a.y + ((b.y - a.y) * s) / 8)) return true;
    }
    return false;
  });
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
  /** What to share out evenly between the territories: ground area, houses (default), or both equally. */
  evenBy?: 'area' | 'houses' | 'both';
  /** Lakes and big ponds: cut out of the territories (default), or kept inside them. */
  water?: 'exclude' | 'include';
  /** Hand narrow strips (land between a road and a lake or railway, say) to the neighbour they run along. Default on. */
  trimStrips?: boolean;
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
  const parts = faces.map((g) => ({ g, n: index.count(g), straight: true }));
  // Keep it to the two halves: fold any extra scrap into the half beside it.
  return parts.length > 2 ? mergeSmall(parts, Infinity, Infinity, noBeat, true, 2) : parts;
}

/**
 * Take lakes and rivers out of the area. Water up to POND_MAX_M2 is left in, since those ponds
 * become part of their territory anyway; the rest is joined first, then cut out once.
 */
function removeWater(area: G, water: Area[], beat: Beat): G {
  const hits = bigWater(area, water, part(beat, 0, 0.4));
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

/** Lakes and rivers bigger than POND_MAX_M2 that reach into the area. */
function bigWater(area: G, water: Area[], beat: Beat = noBeat): G[] {
  const env = area.getEnvelopeInternal();
  const hits: G[] = [];
  for (const [i, w] of water.entries()) {
    beat(`Checking water area ${i + 1} of ${water.length}`, i / water.length);
    try {
      const wg = clean(toJsts(w));
      if (env.intersects(wg.getEnvelopeInternal()) && areaM2(wg) > POND_MAX_M2 && area.intersects(wg)) hits.push(wg);
    } catch {
      /* skip broken water polygons */
    }
  }
  return hits;
}

/** Leave out empty specks (under 0.5% of the area, no houses) that joining outlines can leave behind. */
function dropCrumbs(g: G, index: BuildingIndex): G {
  const polys = polygonsOf(g);
  if (polys.length < 2) return g;
  const whole = g.getArea();
  const kept = polys.filter((p) => p.getArea() >= whole * 0.005 || index.count(p) > 0);
  if (kept.length === polys.length || !kept.length) return g;
  return kept.length === 1 ? kept[0] : factory.createMultiPolygon(kept);
}

/**
 * Order blocks for a sweep: start from the lowest position and grow through neighbours, taking the
 * block with the smallest key next, where a block's key is its position, but at least its neighbour's
 * key, plus `penalty` when the step crosses a railway, river or main road. Unreached blocks follow.
 */
function growOrder(sorted: number[], pos: (i: number) => number, nbs: Map<number, number>[], majorNbs: Map<number, number>[], penalty: number): number[] {
  if (penalty <= 0) return sorted;
  const inSet = new Set(sorted);
  const key = new Map<number, number>();
  const done = new Set<number>();
  const heap = new MinHeap<{ k: number; i: number }>((a, b) => a.k < b.k);
  const out: number[] = [];
  let next = 0; // next unreached block in position order, to restart from after an island
  heap.push({ k: pos(sorted[0]), i: sorted[0] });
  key.set(sorted[0], pos(sorted[0]));
  while (out.length < sorted.length) {
    let top = heap.pop();
    while (top && (done.has(top.i) || key.get(top.i)! < top.k)) top = heap.pop();
    if (!top) {
      while (done.has(sorted[next])) next++;
      const i = sorted[next];
      top = { k: Math.max(pos(i), key.get(i) ?? -Infinity), i };
    }
    done.add(top.i);
    out.push(top.i);
    for (const [j, len] of nbs[top.i]) {
      if (!inSet.has(j) || done.has(j)) continue;
      const major = (majorNbs[top.i].get(j) ?? 0) >= len * 0.5;
      const k = Math.max(pos(j), top.k) + (major ? penalty : 0);
      if (k < (key.get(j) ?? Infinity)) {
        key.set(j, k);
        heap.push({ k, i: j });
      }
    }
  }
  return out;
}

/**
 * Share the houses out evenly. Every territory is broken into its street blocks; the blocks are then
 * divided again from the top: split the whole area in two where a whole number of territories' worth
 * (of ground, or of houses with `byArea` off) lies on each side, along the cheapest border (railways,
 * rivers and main roads are cheap),
 * then split each side, until there are `ps.length` territories. Finally, border blocks are handed
 * from bigger to smaller neighbours to smooth the rest. Borders follow streets, water and railways
 * because the blocks are bounded by them.
 */
function evenOut(
  ps: Piece[],
  roads: G[],
  index: BuildingIndex,
  beat: Beat = noBeat,
  major: G[] = [],
  secondary: G[] = [],
  evenBy: 'area' | 'houses' | 'both' = 'houses',
  wet: G[] = [],
): Piece[] {
  const byArea = evenBy !== 'houses';
  const k = ps.length;
  if (k < 2) return ps;
  // Ground means land: lakes kept inside the territories don't count towards their area.
  const land = (g: G) => {
    let a = g.getArea();
    const env = g.getEnvelopeInternal();
    for (const w of wet)
      if (env.intersects(w.getEnvelopeInternal()))
        try {
          a -= g.intersection(w).getArea();
        } catch {
          /* count it as land */
        }
    return Math.max(0, a);
  };
  // `w` is what gets shared out evenly: the block's ground area, its houses, or (both) an equal mix of
  // its share of all the ground and its share of all the houses.
  const blocks: { g: G; n: number; w: number; owner: number; x: number; y: number; straight: boolean }[] = [];
  const lonScale = Math.cos((ps[0].g.getInteriorPoint().getCoordinate().y * Math.PI) / 180);
  // By area, a street block bigger than a quarter of a territory (fields with no road through them)
  // is divided into a grid of smaller cells, so the area can still be shared out evenly.
  const areaShare = ps.reduce((a, p) => a + p.g.getArea(), 0) / k;
  const cell = Math.sqrt(areaShare / 12);
  const totalArea = (byArea ? ps.reduce((a, p) => a + land(p.g), 0) : 0) || 1;
  const totalHouses = ps.reduce((a, p) => a + p.n, 0) || 1;
  const addBlock = (g: G, t: number, straight: boolean) => {
    const c = g.getInteriorPoint().getCoordinate();
    const n = index.count(g);
    const w = evenBy === 'houses' ? n : evenBy === 'area' ? land(g) / totalArea : (land(g) / totalArea + n / totalHouses) / 2;
    blocks.push({ g, n, w, owner: t, x: c.x * lonScale, y: c.y, straight });
  };
  ps.forEach((p, t) => {
    beat(`Finding the street blocks in territory ${t + 1} of ${k}`, (0.25 * t) / k);
    for (const g of polygonize(p.g, linesInto(p.g, roads))) {
      if (!byArea || g.getArea() <= areaShare / 4) {
        addBlock(g, t, !!p.straight);
        continue;
      }
      for (const c of polygonize(g, gridLines(g.getEnvelopeInternal(), cell))) addBlock(c, t, true);
    }
  });
  if (blocks.length < k * 2) return ps; // too few blocks to rearrange
  // Border length between blocks along railways, rivers and main roads, and along secondary roads.
  const piecesOnly = blocks.map(({ g, n }) => ({ g, n }));
  const avgW = blocks.reduce((a, b) => a + b.w, 0) / k;
  const majorNbs = major.length ? neighbourLengths(piecesOnly, noBeat, nearLines(major)) : blocks.map(() => new Map<number, number>());
  const secondaryNbs = secondary.length
    ? neighbourLengths(piecesOnly, noBeat, nearLines(secondary))
    : blocks.map(() => new Map<number, number>());
  // Cutting along a major border costs a fifth of cutting between two ordinary blocks; secondary roads 60%.
  const cutCost = (i: number, j: number, len: number) => {
    const onMajorLen = Math.min(len, majorNbs[i].get(j) ?? 0);
    const onSecondaryLen = Math.min(len - onMajorLen, secondaryNbs[i].get(j) ?? 0);
    return len - 0.8 * onMajorLen - 0.4 * onSecondaryLen;
  };
  const nbs = neighbourLengths(piecesOnly, part(beat, 0.25, 0.4));

  // Divide `ids` into `parts` territories, numbering them from `first`.
  let made = 0;
  const divide = (ids: number[], parts: number, first: number) => {
    if (parts === 1 || ids.length === 1) {
      for (const i of ids) blocks[i].owner = first;
      beat(`Dividing evenly: ${++made} of ${k} territories`, 0.4 + (0.3 * made) / k);
      return;
    }
    const total = ids.reduce((a, i) => a + blocks[i].w, 0);
    const share = total / parts;
    // A cut can leave any whole number of territories' worth of houses on one side (30–70% of them),
    // so it can slide over to run along a railway, river or main road. Among cuts within 5% of a whole
    // number, take the cheapest border; if none qualifies, the one nearest the middle.
    const lo = Math.max(1, Math.round(parts * 0.3));
    const hi = Math.min(parts - 1, Math.round(parts * 0.7));
    let best: { order: number[]; at: number; left: number; cost: number } | undefined;
    let nearest: { order: number[]; at: number; left: number; miss: number } | undefined;
    // Try cutting north–south, east–west and along both diagonals, each as a straight sweep and as a
    // sweep that grows through neighbouring blocks and treats crossing a railway, river or main road
    // as a long way round, so the side fills up to the main road before going past it.
    for (const [ax, ay] of [
      [1, 0],
      [0, 1],
      [1, 1],
      [1, -1],
    ]) {
      const pos = (i: number) => blocks[i].x * ax + blocks[i].y * ay;
      const sorted = [...ids].sort((a, b) => pos(a) - pos(b));
      const extent = pos(sorted[sorted.length - 1]) - pos(sorted[0]);
      for (const order of [sorted, growOrder(sorted, pos, nbs, majorNbs, extent * 0.6)]) {
        // Walk along the order, tracking the houses taken and the border cost between the two sides.
        const inLeft = new Set<number>();
        const inIds = new Set(ids);
        let houses = 0;
        let border = 0;
        for (let at = 0; at < order.length - 1; at++) {
          const i = order[at];
          inLeft.add(i);
          houses += blocks[i].w;
          for (const [j, len] of nbs[i]) if (inIds.has(j)) border += (inLeft.has(j) ? -1 : 1) * cutCost(i, j, len);
          const f = houses / share;
          if (f > hi + 0.5) break;
          const left = Math.min(hi, Math.max(lo, Math.round(f)));
          const miss = Math.abs(f - left);
          const middle = Math.abs(houses - (total * Math.floor(parts / 2)) / parts) / share;
          if (!nearest || middle < nearest.miss) nearest = { order, at, left: Math.floor(parts / 2), miss: middle };
          if (miss > 0.05) continue;
          // Slightly prefer even halves, which keep the pieces compact.
          const cost = border * (1 + 4 * miss) * (1 + 0.5 * Math.abs(left / parts - 0.5));
          if (!best || cost < best.cost) best = { order, at, left, cost };
        }
      }
    }
    const cut = best ?? nearest!;
    divide(cut.order.slice(0, cut.at + 1), cut.left, first);
    divide(cut.order.slice(cut.at + 1), parts - cut.left, first + cut.left);
  };
  divide(
    blocks.map((_, i) => i),
    k,
    0,
  );

  const members = ps.map(() => new Set<number>());
  blocks.forEach((b, i) => members[b.owner].add(i));
  const size = members.map((m) => [...m].reduce((a, i) => a + blocks[i].w, 0));

  // Blocks without houses (strips between carriageways, verges) go to whichever territory they border
  // most along streets, so they don't leave thin tails running along roads; never if that would cut a
  // territory in two.
  const settleEmpty = () => {
    for (let round = 0; round < 5; round++) {
      let moved = 0;
      blocks.forEach((b, i) => {
        // By area, only small empty bits (verges, strips) move; bigger empty ground counts towards the area.
        if (b.n || (byArea && b.w > avgW * 0.02)) return;
        const by = new Map<number, number>();
        // Border along streets only: a strip beside a main road belongs with its own side of the road.
        for (const [j, len] of nbs[i]) by.set(blocks[j].owner, (by.get(blocks[j].owner) ?? 0) + len - (majorNbs[i].get(j) ?? 0));
        let to = b.owner;
        for (const [t, len] of by) if (len > (by.get(to) ?? 0)) to = t;
        if (to === b.owner || members[b.owner].size <= 1 || !staysWhole(blocks, nbs, b.owner, i)) return;
        members[b.owner].delete(i);
        members[to].add(i);
        b.owner = to;
        moved++;
      });
      if (!moved) break;
    }
  };

  // A side can come out in more than one piece (across a lake, say); give the smaller pieces to a neighbour.
  const reconnect = () => {
    for (let t = 0; t < k; t++) {
      const left = new Set(members[t]);
      const comps: number[][] = [];
      while (left.size) {
        const start = left.values().next().value as number;
        const comp = [start];
        left.delete(start);
        for (let q = 0; q < comp.length; q++)
          for (const j of nbs[comp[q]].keys())
            if (left.has(j)) {
              left.delete(j);
              comp.push(j);
            }
        comps.push(comp);
      }
      if (comps.length < 2) continue;
      const houses = (c: number[]) => c.reduce((a, i) => a + blocks[i].w, 0);
      comps.sort((a, b) => houses(b) - houses(a) || b.length - a.length);
      for (const comp of comps.slice(1)) {
        // Prefer a neighbour joined along ordinary streets, not across a railway, river or main road.
        const along = new Map<number, number>();
        for (const i of comp)
          for (const [j, len] of nbs[i]) {
            const o = blocks[j].owner;
            if (o !== t) along.set(o, (along.get(o) ?? 0) + len - (majorNbs[i].get(j) ?? 0));
          }
        let to: number;
        if (along.size) to = [...along.keys()].reduce((a, b) => ((along.get(b) ?? 0) > (along.get(a) ?? 0) ? b : a));
        else {
          // Touches no other territory along a border (an island, or joined only at a corner): nearest one.
          const piece = comp.length === 1 ? blocks[comp[0]].g : union(comp.map((i) => blocks[i].g));
          const env = piece.getEnvelopeInternal();
          let dist = Infinity;
          to = t;
          blocks.forEach((b) => {
            if (b.owner === t || env.distance(b.g.getEnvelopeInternal()) >= dist) return;
            const d = piece.distance(b.g);
            if (d < dist) [dist, to] = [d, b.owner];
          });
          if (to === t) continue;
        }
        for (const i of comp) {
          members[t].delete(i);
          members[to].add(i);
          blocks[i].owner = to;
          size[t] -= blocks[i].w;
          size[to] += blocks[i].w;
        }
      }
    }
  };

  settleEmpty();
  reconnect();
  smooth(blocks, nbs, members, size, part(beat, 0.7, 0.85), majorNbs);
  settleEmpty();

  return ps.map((p, t) => {
    beat(`Drawing territory ${t + 1} of ${k}`, 0.85 + (0.15 * t) / k);
    const ids = [...members[t]];
    if (!ids.length) return p;
    const g = dropCrumbs(clean(ids.length === 1 ? blocks[ids[0]].g : union(ids.map((i) => blocks[i].g))), index);
    // Still marked for checking if a straight-cut edge from before is now on this territory's border.
    const straight = ids.some((i) => blocks[i].straight && [...nbs[i].keys()].some((j) => blocks[j].owner !== t));
    return { g, n: index.count(g), ...(straight ? { straight: true } : {}) };
  });
}

/** Straight lines `step` degrees apart across an envelope, both ways, for dividing large fields. */
function gridLines(e: G, step: number): G[] {
  const out: G[] = [];
  for (let x = e.getMinX() + step; x < e.getMaxX(); x += step)
    out.push(factory.createLineString([new Coordinate(x, e.getMinY() - step), new Coordinate(x, e.getMaxY() + step)]));
  for (let y = e.getMinY() + step; y < e.getMaxY(); y += step)
    out.push(factory.createLineString([new Coordinate(e.getMinX() - step, y), new Coordinate(e.getMaxX() + step, y)]));
  return out;
}

/** True when territory t stays in one piece without block b (its neighbours in t still reach each other). */
function staysWhole(blocks: { owner: number }[], nbs: Map<number, number>[], t: number, b: number): boolean {
  const ends = [...nbs[b].keys()].filter((j) => blocks[j].owner === t);
  if (ends.length <= 1) return true;
  const seen = new Set([b, ends[0]]);
  const stack = [ends[0]];
  while (stack.length) {
    const x = stack.pop()!;
    for (const y of nbs[x].keys())
      if (!seen.has(y) && blocks[y].owner === t) {
        seen.add(y);
        stack.push(y);
      }
  }
  return ends.every((e) => seen.has(e));
}

/**
 * Hand border blocks from bigger territories to smaller neighbours while that narrows the gap,
 * the shapes stay compact, and the giving territory stays in one piece. Blocks only move across
 * ordinary streets, and blocks cut off from their territory by a main road are moved to their side.
 */
function smooth(
  blocks: { g: G; w: number; owner: number }[],
  nbs: Map<number, number>[],
  members: Set<number>[],
  size: number[],
  beat: Beat,
  majorNbs: Map<number, number>[] = blocks.map(() => new Map()),
) {
  const avg = size.reduce((a, b) => a + b, 0) / size.length || 1;
  const perim = blocks.map((b) => b.g.getLength());
  const barea = blocks.map((b) => b.g.getArea());
  // Area and outline length per territory, kept up to date so shape changes can be scored without geometry.
  const area = members.map((m) => [...m].reduce((a, i) => a + barea[i], 0));
  const outline = members.map((m) => {
    let l = 0;
    for (const i of m) {
      l += perim[i];
      for (const [j, len] of nbs[i]) if (m.has(j)) l -= len;
    }
    return l;
  });
  const compact = (a: number, l: number) => (l > 0 ? (4 * Math.PI * a) / (l * l) : 0);

  const PASSES = 40;
  for (let pass = 0; pass < PASSES; pass++) {
    let moved = 0;
    const order = blocks.map((_, i) => i).sort((a, b) => size[blocks[b].owner] - size[blocks[a].owner]);
    for (const i of order) {
      const b = blocks[i];
      const from = b.owner;
      if (!b.w || members[from].size <= 1) continue;
      const shared = new Map<number, number>();
      const sharedMajor = new Map<number, number>();
      let own = 0;
      let ownMajor = 0;
      for (const [j, len] of nbs[i]) {
        const o = blocks[j].owner;
        if (o === from) {
          own += len;
          ownMajor += majorNbs[i].get(j) ?? 0;
        } else {
          shared.set(o, (shared.get(o) ?? 0) + len);
          sharedMajor.set(o, (sharedMajor.get(o) ?? 0) + (majorNbs[i].get(j) ?? 0));
        }
      }
      let to = -1;
      let best = 0;
      let next = { la: 0, lt: 0 };
      for (const [t, len] of shared) {
        const gain = size[from] - size[t] - b.w; // > 0: the two end up closer in size
        // Only join across ordinary streets, never across a railway, river or main road.
        if ((len - (sharedMajor.get(t) ?? 0)) / perim[i] < 0.25) continue;
        // Moves that don't even out sizes are only for tidier shapes, and only while both stay near average.
        const inBand = size[from] - b.w >= avg * 0.92 && size[t] + b.w <= avg * 1.08;
        if (gain <= 0 && !inBand) continue;
        // How the two outlines change if the block moves, and what that does to their shapes.
        const la = outline[from] + perim[i] - 2 * own;
        const lt = outline[t] + perim[i] - 2 * len;
        const shape =
          compact(area[from] - barea[i], la) + compact(area[t] + barea[i], lt) - compact(area[from], outline[from]) - compact(area[t], outline[t]);
        // Reward moving a block that is across a railway, river or main road from the rest of its territory.
        const sides = (ownMajor - (sharedMajor.get(t) ?? 0)) / perim[i];
        const score = gain > 0 ? gain / avg + 1.5 * shape + 0.5 * sides : shape + 0.5 * sides - 0.002;
        if (score > best) [to, best, next] = [t, score, { la, lt }];
      }
      if (to < 0 || !staysWhole(blocks, nbs, from, i)) continue;
      members[from].delete(i);
      members[to].add(i);
      size[from] -= b.w;
      size[to] += b.w;
      area[from] -= barea[i];
      area[to] += barea[i];
      outline[from] = next.la;
      outline[to] = next.lt;
      b.owner = to;
      moved++;
    }
    beat(`Smoothing sizes: round ${pass + 1}, ${moved} blocks moved`, (pass + 1) / PASSES);
    if (!moved) break;
  }
}

/**
 * Join tiny pieces that touch no other territory (islands, cut-off corners) to the nearest territory,
 * since they can't grow by taking blocks from a neighbour. `count` is the number of territories wanted.
 */
function absorbStrays(ps: Piece[], count: number, beat: Beat = noBeat): Piece[] {
  const avg = ps.reduce((a, p) => a + p.n, 0) / Math.max(1, count);
  const nbs = neighbourLengths(ps);
  const strays = ps.map((p, i) => i).filter((i) => ps[i].n < avg * 0.3 && !nbs[i].size);
  if (!strays.length) return ps;
  const out = [...ps];
  const gone = new Set<number>();
  for (const [k, i] of strays.entries()) {
    beat(`Joining stray piece ${k + 1} of ${strays.length} to its nearest territory`, k / strays.length);
    let near = -1;
    let dist = Infinity;
    for (const [j, q] of out.entries()) {
      if (j === i || gone.has(j) || strays.includes(j)) continue;
      const d = out[i].g.getEnvelopeInternal().distance(q.g.getEnvelopeInternal());
      if (d > dist) continue;
      const exact = out[i].g.distance(q.g);
      if (exact < dist) [near, dist] = [j, exact];
    }
    if (near < 0) continue;
    out[near] = { g: union([out[near].g, out[i].g]), n: out[near].n + out[i].n, ...(out[near].straight ? { straight: true } : {}) };
    gone.add(i);
  }
  return out.filter((_, i) => !gone.has(i));
}

/** Metres to degrees. Near enough everywhere people live; east–west distances shrink towards the poles. */
const M = 1 / 111320;

/** Narrow parts of a territory: what is left when its outline is shrunk by `r` and grown back. Long ones only. */
function narrowParts(g: G, r: number): G[] {
  try {
    const opened = g.buffer(-r, 4).buffer(r * 1.05, 4);
    return polygonsOf(g.difference(opened)).filter((s) => s.getArea() >= 4 * r * r && s.getLength() / 2 >= 6 * r);
  } catch {
    return [];
  }
}

/**
 * Hand narrow strips to the neighbour they run along. Borders that follow roads, water and railways
 * can leave a territory with a long thin tail, such as the land between a road and a lake or between
 * a road and a railway, joined to the rest only at one end. Each strip (under `width` metres across)
 * goes to the neighbour that shares the most border with it, if that is at least 40% of the strip's
 * length, so it is not a tail there too. Parts of the territory the strip was the only link to go
 * with it to their own best neighbour; strips that are most of their territory are left alone.
 */
export function trimStrips(ps: Piece[], index: BuildingIndex, beat: Beat = noBeat, width = 50): Piece[] {
  const r = (width / 2) * M;
  const gs = ps.map((p) => p.g);
  const changed = new Set<number>();
  // The territory sharing the longest border with `x` (not `t`), and the length shared.
  const neighbour = (x: G, t: number) => {
    const env = x.getEnvelopeInternal();
    const edge = x.getBoundary();
    let to = -1;
    let len = 0;
    gs.forEach((g, j) => {
      if (j === t || !env.intersects(g.getEnvelopeInternal())) return;
      try {
        const l = edge.intersection(g).getLength();
        if (l > len) [to, len] = [j, l];
      } catch {
        /* not this one */
      }
    });
    return { to, len };
  };
  const ROUNDS = 2;
  for (let round = 0; round < ROUNDS; round++) {
    let moved = 0;
    for (let t = 0; t < gs.length; t++) {
      beat(`Round ${round + 1}: checking territory ${t + 1} of ${gs.length} for narrow strips`, (round + t / gs.length) / ROUNDS);
      const whole = gs[t].getArea();
      for (const raw of narrowParts(gs[t], r)) {
        try {
          const strip = clean(GeometryPrecisionReducer.reduce(raw, PM));
          if (strip.isEmpty() || strip.getArea() > whole * 0.5) continue;
          const parts = polygonsOf(gs[t].difference(strip)).sort((a, b) => b.getArea() - a.getArea());
          if (!parts.length) continue;
          const cutOff = parts.slice(1);
          if (cutOff.reduce((a, p) => a + p.getArea(), 0) + strip.getArea() > whole * 0.5) continue;
          const to = neighbour(strip, t);
          let gifts: [G, number][] = [];
          if (to.to >= 0 && to.len >= 0.4 * (strip.getLength() / 2)) gifts = [[strip, to.to]];
          else {
            // A long strip beside several territories: cut it into short lengths, each to the one beside it.
            const chunks = polygonize(strip, gridLines(strip.getEnvelopeInternal(), 150 * M));
            for (const c of chunks) {
              const n = neighbour(c, t);
              if (n.to < 0 || !n.len) break;
              gifts.push([c, n.to]);
            }
            if (gifts.length < chunks.length || !gifts.length) continue;
          }
          const keep = [parts[0]];
          for (const p of cutOff) {
            const n = neighbour(p, t);
            if (n.to < 0 || !n.len) keep.push(p);
            else gifts.push([p, n.to]);
          }
          gs[t] = keep.length === 1 ? keep[0] : factory.createMultiPolygon(keep);
          for (const [g, j] of gifts) {
            gs[j] = clean(union([gs[j], g]));
            changed.add(j);
          }
          changed.add(t);
          moved++;
        } catch {
          /* leave this strip where it is */
        }
      }
    }
    if (!moved) break;
  }
  return ps.map((p, i) => {
    if (!changed.has(i)) return p;
    const g = dropCrumbs(gs[i], index);
    return { ...p, g, n: index.count(g) };
  });
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
  const keepWater = opt.water === 'include';
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
    keepWater
      ? { name: 'Preparing the boundary', weight: 1, run: (_, beat) => count(polygonsOf(area), beat) }
      : {
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
        const target = Math.min(opt.count || Infinity, MAX_TERRITORIES);
        // Fold tiny pieces into a neighbour (or, if they touch none, the nearest territory) first.
        const kept = all.filter(notSliver);
        const tiny = (kept.reduce((a, p) => a + p.n, 0) / Math.min(target, kept.length)) * 0.3;
        const ps = absorbStrays(mergeSmall(kept, tiny, Infinity, part(beat, 0, 0.05)), Math.min(target, kept.length), part(beat, 0.05, 0.1));
        // Joining down to the count aims each join at the average size, so sizes come out even.
        const even = Math.round(ps.reduce((a, p) => a + p.n, 0) / Math.min(target, ps.length));
        if (ps.length > target) return mergeSmall(ps, opt.min, even, beat, true, target);
        if (!opt.count || ps.length >= target) return ps;
        // Too few: cut the biggest territory along roads until there are enough.
        let out = [...ps];
        // Cut the biggest until there are enough, fold any scraps the cuts leave into a neighbour, repeat.
        for (let round = 0; round < 4 && out.length < target; round++) {
          for (let tries = 0; out.length < target && tries < target * 2; tries++) {
            beat(`${out.length} of ${target} territories; cutting the biggest one`, 0.1 + (0.8 * out.length) / target);
            const big = out.reduce((a, p) => (p.n > a.n ? p : a));
            const halves = cutAlongRoads(big, allRoads, index, Math.min(opt.min, big.n / 4)).filter(notSliver);
            if (halves.length < 2) break;
            out = [...out.filter((p) => p !== big), ...halves];
          }
          out = mergeSmall(out, tiny, Infinity).filter(notSliver);
        }
        return out.length > target ? mergeSmall(out, opt.min, even, beat, true, target) : out;
      },
    },
    {
      name: 'Evening out territory sizes',
      weight: 2,
      run: (ps, beat) => {
        // Lakes kept inside territories are found again here, so they don't count as ground.
        const wet = keepWater && opt.evenBy && opt.evenBy !== 'houses' ? bigWater(area, osm.water, part(beat, 0, 0.05)) : [];
        const sub = wet.length ? part(beat, 0.05, 1) : beat;
        return evenOut(ps, allRoads, index, sub, opt.levels[0] ? byLevel[0] : [], opt.levels[1] ? byLevel[1] : [], opt.evenBy ?? 'houses', wet);
      },
    },
    ...(opt.trimStrips === false ? [] : [{ name: 'Removing narrow strips', weight: 1, run: (ps: Piece[], beat: Beat) => trimStrips(ps, index, beat) }]),
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

/**
 * Outline for sharing as a link or QR code: holes and detached bits under 3% of the area are left
 * out, the outline is simplified by `tolerance` degrees, and points are snapped to the 1 m grid of
 * the QR code format in a way that keeps the shape valid.
 */
export function shareOutline(area: Area, tolerance: number): Area {
  const g = clean(toJsts(area));
  const whole = g.getArea();
  const polys = polygonsOf(g)
    .filter((p) => p.getArea() >= whole * 0.03)
    .map((p) => {
      const holes = [];
      for (let i = 0; i < p.getNumInteriorRing(); i++) {
        const r = p.getInteriorRingN(i);
        if (factory.createPolygon(r).getArea() >= whole * 0.03) holes.push(factory.createLinearRing(r.getCoordinates()));
      }
      return factory.createPolygon(factory.createLinearRing(p.getExteriorRing().getCoordinates()), holes);
    });
  const kept = polys.length ? (polys.length === 1 ? polys[0] : factory.createMultiPolygon(polys)) : g;
  const simple = TopologyPreservingSimplifier.simplify(kept, tolerance);
  const snapped = GeometryPrecisionReducer.reduce(simple, new PrecisionModel(1e5));
  return snapped.isEmpty() ? toArea(simple) : toArea(snapped);
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

/** Ground area of an outline in square kilometres. */
export const areaKm2 = (area: Area) => areaM2(clean(toJsts(area))) / 1e6;

/** Area for display: hectares below 1 km², else km². */
export const formatArea = (km2: number) => (km2 < 1 ? `${Math.round(km2 * 100)} ha` : `${km2.toFixed(km2 < 10 ? 1 : 0)} km²`);

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
