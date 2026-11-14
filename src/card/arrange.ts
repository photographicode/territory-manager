// Places landmark boxes on a card map: beside the territory, never on it, apart from each other and off the dots,
// as close to their own spot as that allows. Works in card pixels, the same frame the card is drawn in.
import type { Area, Landmark } from '../types';

type XY = [number, number];
type Rect = { x: number; y: number; w: number; h: number };
const GAP = 12;

const mx = (lon: number) => (lon * Math.PI) / 180;
const my = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const rings = (g: Area) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

function inRing(x: number, y: number, r: XY[]) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) if (r[i][1] > y !== r[j][1] > y && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
}
const side = (p: XY, q: XY, r: XY) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
const crosses = (a: XY, b: XY, c: XY, d: XY) => side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);

/**
 * New `box` positions for `marks`. `size` gives each label's box in card pixels, `W`×`H` is the card map and
 * `margin` the share kept clear around the territory (as the card map is fitted). Also says which boxes still touch the territory.
 */
export function arrangeLandmarks(area: Area, marks: Landmark[], size: (text: string) => XY, W: number, H: number, margin: number): { marks: Landmark[]; touching: number } {
  const pts = rings(area).flat(2) as XY[];
  const X = pts.map((p) => mx(p[0]));
  const Y = pts.map((p) => my(p[1]));
  const [x0, x1, y0, y1] = [Math.min(...X), Math.max(...X), Math.min(...Y), Math.max(...Y)];
  const s = Math.min((W * (1 - 2 * margin)) / (x1 - x0 || 1e-9), (H * (1 - 2 * margin)) / (y1 - y0 || 1e-9));
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const toPx = ([lon, lat]: XY): XY => [W / 2 + (mx(lon) - cx) * s, H / 2 - (my(lat) - cy) * s];
  const toLonLat = ([px, py]: XY): XY => [((cx + (px - W / 2) / s) * 180) / Math.PI, ((2 * Math.atan(Math.exp(cy - (py - H / 2) / s)) - Math.PI / 2) * 180) / Math.PI];
  const polys = rings(area).map((poly) => poly.map((r) => (r as XY[]).map(toPx)));
  const inside = (x: number, y: number) => polys.some((poly) => inRing(x, y, poly[0]) && !poly.slice(1).some((h) => inRing(x, y, h)));
  const edges = polys.flat().flatMap((r) => r.slice(1).map((q, i) => [r[i], q] as [XY, XY]));
  const onTerritory = (b: Rect) => {
    let n = 0;
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 3; j++) if (inside(b.x + (b.w * i) / 8, b.y + (b.h * j) / 3)) n++;
    const c: XY[] = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
    for (const [a, d] of edges) {
      if (a[0] > b.x && a[0] < b.x + b.w && a[1] > b.y && a[1] < b.y + b.h) n++;
      else if (c.some((p, k) => crosses(a, d, p, c[(k + 1) % 4]))) n++;
    }
    return n;
  };
  const named = marks.filter((l) => l.text.trim());
  const dots = named.map((l) => toPx(l.at));
  const placed: Rect[] = [];
  let touching = 0;
  const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;
  const out = named.map((l, i) => {
    const [w, h] = size(l.text);
    const [px, py] = dots[i];
    let best: Rect | null = null;
    let score = Infinity;
    for (let x = 6; x <= W - w - 6; x += 10)
      for (let y = 6; y <= H - h - 6; y += 10) {
        const b = { x, y, w, h };
        if (placed.some((q) => overlaps(b, q))) continue;
        let pen = dots.filter(([qx, qy]) => qx > x - 10 && qx < x + w + 10 && qy > y - 10 && qy < y + h + 10).length * 1e8 + Math.hypot(x + w / 2 - px, y + h / 2 - py);
        if (pen >= score) continue;
        pen += onTerritory(b) * 1e6;
        if (pen < score) [score, best] = [pen, b];
      }
    const b = best ?? { x: Math.min(Math.max(px - w / 2, 6), W - w - 6), y: Math.min(Math.max(py - h / 2, 6), H - h - 6), w, h };
    if (!best || score >= 1e6) touching++;
    placed.push(b);
    return { ...l, box: toLonLat([b.x + w / 2, b.y + h / 2]) };
  });
  return { marks: [...out, ...marks.filter((l) => !l.text.trim())], touching };
}
