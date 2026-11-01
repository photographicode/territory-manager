// Compact, URL-safe encoding of a territory outline for QR codes.
// Format: varints [version=1, polygons, (rings, (points, zigzag Δlat Δlon at 1e5)…)…], base64url.
import type { Area } from '../types';

const SCALE = 1e5; // ~1.1 m

function pushVarint(out: number[], v: number) {
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}
const zig = (v: number) => (v < 0 ? -2 * v - 1 : 2 * v);
const unzig = (v: number) => (v % 2 ? -(v + 1) / 2 : v / 2);

export function encodeArea(area: Area): string {
  const polys = area.type === 'Polygon' ? [area.coordinates] : area.coordinates;
  const out: number[] = [];
  pushVarint(out, 1);
  pushVarint(out, polys.length);
  let px = 0;
  let py = 0;
  for (const rings of polys) {
    pushVarint(out, rings.length);
    for (const ring of rings) {
      const pts = ring.slice(0, -1);
      pushVarint(out, pts.length);
      for (const [lon, lat] of pts) {
        const x = Math.round(lon * SCALE);
        const y = Math.round(lat * SCALE);
        pushVarint(out, zig(y - py));
        pushVarint(out, zig(x - px));
        px = x;
        py = y;
      }
    }
  }
  let s = '';
  for (const b of out) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeArea(code: string): Area {
  const bin = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
  let i = 0;
  const next = () => {
    let v = 0;
    let mul = 1;
    for (;;) {
      const b = bin.charCodeAt(i++);
      if (Number.isNaN(b)) throw new Error('Truncated territory code');
      v += (b & 0x7f) * mul;
      if (b < 0x80) return v;
      mul *= 128;
    }
  };
  if (next() !== 1) throw new Error('Unknown territory code version');
  let px = 0;
  let py = 0;
  const polys: number[][][][] = [];
  for (let p = next(); p > 0; p--) {
    const rings: number[][][] = [];
    for (let r = next(); r > 0; r--) {
      const ring: number[][] = [];
      for (let n = next(); n > 0; n--) {
        py += unzig(next());
        px += unzig(next());
        ring.push([px / SCALE, py / SCALE]);
      }
      ring.push(ring[0]);
      rings.push(ring);
    }
    polys.push(rings);
  }
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}
