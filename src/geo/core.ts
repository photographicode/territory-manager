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
import type { Area, OsmData } from '../types';

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

/** Split an area into faces formed by the given lines. Lines that do not cut through are ignored. */
export function polygonize(area: G, lines: G[]): G[] {
  const env = area.getEnvelopeInternal();
  const crossing = lines.filter((l) => env.intersects(l.getEnvelopeInternal()) && area.intersects(l));
  if (!crossing.length) return [area];
  const edges = [area.getBoundary(), ...crossing];
  const noded = new GeometryNoder(PM).node(list(edges));
  const pz = new Polygonizer();
  pz.add(noded);
  const faces: G[] = pz.getPolygons().toArray();
  const loc = new IndexedPointInAreaLocator(area);
  const inside = faces.filter((f) => loc.locate(f.getInteriorPoint().getCoordinate()) === Location.INTERIOR);
  return inside.length ? inside : [area];
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

function sharedLength(a: G, b: G): number {
  if (!a.getEnvelopeInternal().intersects(b.getEnvelopeInternal())) return 0;
  try {
    return a.getBoundary().intersection(b.getBoundary()).getLength();
  } catch {
    return a.buffer(1e-6).intersects(b) ? 1e-9 : 0;
  }
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

/**
 * Merge pieces with fewer than `min` buildings into a neighbour. Prefers the neighbour that keeps
 * the joined territory compact and shares a long border, so leftovers don't wrap around others.
 */
function mergeSmall(pieces: Piece[], min: number, max: number): Piece[] {
  const ps = [...pieces];
  for (;;) {
    const small = ps
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.n < min)
      .sort((a, b) => a.p.n - b.p.n || a.p.g.getArea() - b.p.g.getArea());
    let merged = false;
    for (const { p, i } of small) {
      const perimeter = p.g.getLength();
      const nbs = ps
        .map((q, j) => ({ q, j, len: j === i ? 0 : sharedLength(p.g, q.g) }))
        .filter((x) => x.len > 0);
      if (!nbs.length) continue;
      const fits = nbs.filter((x) => x.q.n + p.n <= max);
      const pool = (fits.length ? fits : nbs).map((x) => {
        const g = union([x.q.g, p.g]);
        const over = Math.max(0, x.q.n + p.n - max) / max;
        return { ...x, g, score: 0.5 * Math.min(1, x.len / perimeter) + 0.5 * compactness(g) - over };
      });
      pool.sort((a, b) => b.score - a.score);
      const t = pool[0];
      ps[t.j] = { g: t.g, n: t.q.n + p.n, straight: t.q.straight || p.straight };
      ps.splice(i, 1);
      merged = true;
      break;
    }
    if (!merged) return ps;
  }
}

export interface SplitOptions {
  min: number;
  max: number;
  levels: boolean[];
  onProgress?: (msg: string) => void;
}

/**
 * Split a congregation boundary into territories.
 * Cuts along the biggest borders first (rail, rivers, main roads), and only uses smaller roads
 * and lanes inside pieces that still hold more than `max` houses.
 */
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

/**
 * Split a piece that no road fully crosses. Tries every road inside it, lengthening dead ends a
 * little until they reach the edge, and keeps the cut that shares the houses most evenly.
 * Falls back to a straight line through the middle house only when no road works.
 */
function cutAlongRoads(piece: Piece, roads: G[], index: BuildingIndex, min: number): Piece[] {
  const env = piece.g.getEnvelopeInternal();
  const inside = roads.filter((r) => env.intersects(r.getEnvelopeInternal()) && piece.g.intersects(r));
  let best: { faces: Piece[]; score: number } | null = null;
  for (const ext of [0, 0.0006, 0.0015]) {
    // ~0, 65 m and 165 m
    for (const r of inside) {
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
      if (Math.min(...ns) >= min * 0.6 && (!best || score > best.score)) best = { faces: parts, score };
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
  const m = vals[Math.floor(vals.length / 2)];
  const pad = 0.001;
  const line = wide
    ? [new Coordinate(m, e.getMinY() - pad), new Coordinate(m, e.getMaxY() + pad)]
    : [new Coordinate(e.getMinX() - pad, m), new Coordinate(e.getMaxX() + pad, m)];
  const faces = polygonize(piece.g, [factory.createLineString(line)]);
  if (faces.length < 2) return [piece];
  return faces.map((g) => ({ g, n: index.count(g), straight: true }));
}

export function autoSplit(boundary: Area, osm: OsmData, opt: SplitOptions): SplitResult[] {
  const index = new BuildingIndex(osm.buildings);
  let area = clean(toJsts(boundary));
  opt.onProgress?.('Removing lakes and rivers…');
  for (const w of osm.water) {
    try {
      const wg = clean(toJsts(w));
      if (area.getEnvelopeInternal().intersects(wg.getEnvelopeInternal()) && area.intersects(wg)) area = area.difference(wg);
    } catch {
      /* skip broken water polygons */
    }
  }
  const byLevel: G[][] = [0, 1, 2, 3].map((lv) =>
    opt.levels[lv]
      ? osm.lines.filter((l) => l.level === lv && l.coords.length > 1).map((l) => factory.createLineString(l.coords.map(([x, y]) => new Coordinate(x, y))))
      : [],
  );
  const levels = byLevel.map((ls, i) => ({ ls, i })).filter((l) => l.ls.length);
  const allRoads = levels.flatMap((l) => l.ls);

  let done = 0;
  const split = (piece: Piece, li: number, depth = 0): Piece[] => {
    if (piece.n <= opt.max) return [piece];
    if (li >= levels.length) {
      // No road cuts all the way through: use dead-end roads, or a straight cut as a last resort.
      if (piece.n < opt.max * 1.15 || depth > 6) return [piece];
      const halves = cutAlongRoads(piece, allRoads, index, opt.min);
      return halves.length < 2 ? halves : halves.flatMap((h) => split(h, li, depth + 1));
    }
    const faces = polygonize(piece.g, levels[li].ls).map((g) => ({ g, n: index.count(g) }));
    if (faces.length === 1) return split(piece, li + 1);
    const merged = mergeSmall(faces, opt.min, opt.max);
    done++;
    if (done % 5 === 0) opt.onProgress?.(`Splitting… ${done} cuts made`);
    return merged.flatMap((f) => split(f, li + 1));
  };

  const parts = polygonsOf(area).map((g) => ({ g, n: index.count(g) }));
  opt.onProgress?.('Splitting along roads, water and railway…');
  let result = parts.flatMap((p) => split(p, 0));
  opt.onProgress?.('Joining small leftover pieces…');
  result = mergeSmall(result, opt.min, opt.max);
  // Joining leftovers can push a territory over the limit again; cut those once more along roads.
  result = result.flatMap((p) => (p.n > opt.max * 1.15 ? split(p, levels.length) : [p]));
  // Drop empty slivers (road islands, water edges) that touch nothing.
  result = result.filter((p) => p.n > 0 || p.g.getArea() > 1e-6);
  opt.onProgress?.('Including small ponds in their territories…');
  const filled = fillPonds(result.map((p) => p.g), clean(toJsts(boundary)));
  result = result.map((p, i) => ({ ...p, g: filled[i] }));
  return result.map((p) => ({ geometry: toArea(p.g), buildings: p.n, ...(p.straight ? { straightCut: true } : {}) }));
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
function fillPonds(geoms: G[], boundary?: G): G[] {
  const inner = geoms.map((g) => g.getInteriorPoint().getCoordinate());
  return geoms.map((g, gi) => {
    const polys = polygonsOf(g).map((poly) => {
      const holes = [];
      for (let i = 0; i < poly.getNumInteriorRing(); i++) {
        const ring = poly.getInteriorRingN(i);
        const hole = factory.createPolygon(ring);
        const loc = new IndexedPointInAreaLocator(hole);
        const keep =
          areaM2(hole) > POND_MAX_M2 ||
          inner.some((c: G, j: number) => j !== gi && loc.locate(c) !== Location.EXTERIOR) ||
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
