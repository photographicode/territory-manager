// Pull territory borders onto nearby lines (roads, or the neighbours' borders) without touching the rest:
// only border points within `reach` metres move, onto the nearest line, and between two moved points
// that landed on the same line the border follows that line. Everything farther away stays exactly where it was.
import type { Area } from '../types';

type XY = [number, number];
type Hit = { line: number; seg: number; t: number; p: XY };
type Line = { pts: XY[]; closed: boolean };

const KX = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);
const KY = 110574;
const rings = (g: Area): XY[][][] => (g.type === 'Polygon' ? [g.coordinates as XY[][]] : (g.coordinates as XY[][][]));
const shape = (polys: XY[][][]): Area => (polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys });

/** Grid of line segments so the nearest one is found quickly. */
class SegmentIndex {
  private cells = new Map<string, [number, number][]>();
  constructor(
    private lines: Line[],
    private cell: number,
  ) {
    lines.forEach((l, li) =>
      l.pts.slice(1).forEach((b, si) => {
        const a = l.pts[si];
        for (let x = Math.floor(Math.min(a[0], b[0]) / cell); x <= Math.floor(Math.max(a[0], b[0]) / cell); x++)
          for (let y = Math.floor(Math.min(a[1], b[1]) / cell); y <= Math.floor(Math.max(a[1], b[1]) / cell); y++) {
            const k = `${x},${y}`;
            const list = this.cells.get(k);
            if (list) list.push([li, si]);
            else this.cells.set(k, [[li, si]]);
          }
      }),
    );
  }

  nearest(p: XY, kx: number, reach: number, skip: (line: number) => boolean): Hit | null {
    let best: Hit | null = null;
    let bd = reach;
    const rx = Math.ceil(reach / kx / this.cell);
    const ry = Math.ceil(reach / KY / this.cell);
    const cx = Math.floor(p[0] / this.cell);
    const cy = Math.floor(p[1] / this.cell);
    const seen = new Set<string>();
    for (let x = cx - rx; x <= cx + rx; x++)
      for (let y = cy - ry; y <= cy + ry; y++)
        for (const [li, si] of this.cells.get(`${x},${y}`) ?? []) {
          const id = `${li}:${si}`;
          if (seen.has(id) || skip(li)) continue;
          seen.add(id);
          const a = this.lines[li].pts[si];
          const b = this.lines[li].pts[si + 1];
          const dx = (b[0] - a[0]) * kx;
          const dy = (b[1] - a[1]) * KY;
          const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * kx * dx + (p[1] - a[1]) * KY * dy) / (dx * dx + dy * dy || 1)));
          const q: XY = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const d = Math.hypot((q[0] - p[0]) * kx, (q[1] - p[1]) * KY);
          if (d < bd) [bd, best] = [d, { line: li, seg: si, t, p: q }];
        }
    return best;
  }
}

const pathLength = (pts: XY[], kx: number) => pts.reduce((acc, q, k) => (k ? acc + Math.hypot((q[0] - pts[k - 1][0]) * kx, (q[1] - pts[k - 1][1]) * KY) : 0), 0);

/** The vertices of `line` strictly between two hits on it, going the shorter way round on closed lines. */
function between(line: Line, a: Hit, b: Hit, kx: number): XY[] {
  const n = line.pts.length - 1; // segments
  // Vertex i sits at position i; a hit sits at seg + t.
  const walk = (from: number, to: number) => {
    const out: XY[] = [];
    for (let i = Math.floor(from) + 1; i < to; i++) out.push(line.pts[line.closed ? i % n : i]);
    return out;
  };
  const pa = a.seg + a.t;
  const pb = b.seg + b.t;
  if (!line.closed) return pa <= pb ? walk(pa, pb) : walk(pb, pa).reverse();
  const fwd = walk(pa, pb >= pa ? pb : pb + n);
  const back = walk(pb, pa >= pb ? pa : pa + n).reverse();
  return pathLength([a.p, ...fwd, b.p], kx) <= pathLength([a.p, ...back, b.p], kx) ? fwd : back;
}

/** One ring pulled onto the lines: points within `reach` move, stretches between points on the same line follow it. */
function snapRing(ring: XY[], index: SegmentIndex, lines: Line[], reach: number, skip: (line: number) => boolean): XY[] {
  const kx = KX(ring[0][1]);
  const pts = ring.slice(0, -1);
  const hits = pts.map((p) => index.nearest(p, kx, reach, skip));
  const out: XY[] = [];
  const m = (a: XY, b: XY) => Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * KY);
  // Metres from q to the straight piece a–b.
  const off = (q: XY, a: XY, b: XY) => {
    const dx = (b[0] - a[0]) * kx;
    const dy = (b[1] - a[1]) * KY;
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * kx * dx + (q[1] - a[1]) * KY * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot((q[0] - a[0]) * kx - t * dx, (q[1] - a[1]) * KY - t * dy);
  };
  pts.forEach((p, i) => {
    const h = hits[i];
    out.push(h ? h.p : p);
    const j = (i + 1) % pts.length;
    const h2 = hits[j];
    if (h && h2 && h.line === h2.line && m(h.p, h2.p) > 0.05) {
      // Only the line's corners that the straight piece does not already pass through: running twice adds nothing.
      const via = between(lines[h.line], h, h2, kx).filter((q) => off(q, h.p, h2.p) > 0.05);
      const direct = m(pts[j], p);
      // Follow the line only where the border really runs along it, not round a bend far away.
      if (via.length && pathLength([h.p, ...via, h2.p], kx) <= direct * 1.6 + reach) out.push(...via);
    }
  });
  // Drop points closer than 5 cm to the one before, and spikes that go out and straight back.
  const tidy: XY[] = [];
  for (const q of out) {
    if (tidy.length && m(q, tidy[tidy.length - 1]) < 0.05) continue;
    if (tidy.length > 1 && m(q, tidy[tidy.length - 2]) < 0.05) {
      tidy.pop();
      continue;
    }
    tidy.push(q);
  }
  while (tidy.length > 2 && m(tidy[0], tidy[tidy.length - 1]) < 0.05) tidy.pop();
  // Safety: a border never ends up with many times its points; if it would, keep it as it was.
  if (tidy.length < 3 || tidy.length > pts.length * 4 + 200) return ring;
  return [...tidy, tidy[0]];
}

const cellFor = (reach: number) => (reach / 111000) * 4;

/** Borders that run along a road (within `reach` m) are put exactly on it; the rest of each border stays. */
export function snapToLines(areas: Area[], roads: XY[][], reach = 15): Area[] {
  const lines: Line[] = roads.filter((r) => r.length > 1).map((pts) => ({ pts, closed: false }));
  const index = new SegmentIndex(lines, cellFor(reach));
  return areas.map((a) => shape(rings(a).map((poly) => poly.map((r) => snapRing(r, index, lines, reach, () => false)))));
}

/**
 * Neighbouring borders (and the congregation outline) that almost meet, within `reach` m, are made to meet exactly, so no gap or sliver
 * is left between territories. One territory at a time, each onto its neighbours as they already are,
 * so a pair settles on one shared line instead of both moving to where the other was.
 */
export function snapToNeighbours(areas: Area[], reach = 10, outline?: Area): Area[] {
  const out = [...areas];
  // The congregation outline counts as a neighbour too, so gaps along the edge of the whole area close as well.
  const edge: Line[] = outline ? rings(outline).flatMap((poly) => poly.map((r) => ({ pts: r, closed: true }))) : [];
  for (let k = 0; k < out.length; k++) {
    const owner: number[] = edge.map(() => -1);
    const lines: Line[] = [...edge];
    out.forEach((a, i) => rings(a).forEach((poly) => poly.forEach((r) => (lines.push({ pts: r, closed: true }), owner.push(i)))));
    const index = new SegmentIndex(lines, cellFor(reach));
    out[k] = shape(rings(out[k]).map((poly) => poly.map((r) => snapRing(r, index, lines, reach, (li) => owner[li] === k))));
  }
  return out;
}
