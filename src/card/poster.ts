// Full congregation map for wall printing. The map is drawn in square tiles straight into the PDF,
// so even 2A0 at 300 dpi never needs one giant canvas in memory.
import QRCode from 'qrcode';
import { PDFDocument } from 'pdf-lib';
import * as maplibregl from './maplibre';
import { CARD_STYLE_URL } from './tiles';
import { ensureFonts, qrLink } from './render';
import { safeUrl } from '../safe';
import { areasTouch, interiorPoint, mergeAreas } from '../geo/core';
import type { Area, Settings, Territory } from '../types';

/** Paper sizes in mm, short side first. */
export const PAPERS = { '2A0': [1189, 1682], A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420] } as const;
export type Paper = keyof typeof PAPERS;

export interface PosterOptions {
  paper: Paper;
  colorful: boolean;
  /** Fill colour when not colourful. */
  color: string;
  /** Size of the territory numbers; 1 = default. */
  numberScale: number;
  /** Print each territory's locality name under its number. */
  names: boolean;
  /** Double frame around the page. */
  frame: boolean;
  qr: boolean;
  compass: boolean;
  scaleBar: boolean;
  /** Link the QR opens, e.g. a Google My Maps map of all territories; empty = outline of the congregation. */
  link: string;
  /** Colour by group (with a group outline and a legend) instead of per territory. */
  byGroup: boolean;
  groups: TerritoryGroup[];
  /** Zoom (1 = all territories fit) and pan (share of the page width/height) chosen by the user. */
  view?: PosterView;
}

export interface PosterView {
  zoom: number;
  x: number;
  y: number;
}

/** A named set of territories, e.g. a field service group. `numbers` is what was typed: "1-12, 15, 20a". */
export interface TerritoryGroup {
  name: string;
  color: string;
  numbers: string;
}

export const GROUP_COLOURS = ['#e76f51', '#2a9d8f', '#457b9d', '#e9c46a', '#9b5de5', '#f15bb5', '#43aa8b', '#f8961e', '#577590', '#90be6d'];
const UNGROUPED = '#bdbdbd';
const lead = (n: string) => Number.parseInt(n, 10);

/** Territory numbers matched by `text` ("1-12, 15, 20a"), and the parts that matched none. */
export function parseNumbers(text: string, numbers: string[]): { matched: string[]; unknown: string[] } {
  const matched = new Set<string>();
  const unknown: string[] = [];
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part);
    const hits = range
      ? numbers.filter((n) => {
          const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y);
          return lead(n) >= a && lead(n) <= b;
        })
      : numbers.filter((n) => n.toLowerCase() === part.toLowerCase());
    if (hits.length) hits.forEach((n) => matched.add(n));
    else unknown.push(part);
  }
  return { matched: [...matched], unknown };
}

/** Group index of each territory (-1 = none). A territory listed in two groups stays in the first; both are reported. */
export function assignGroups(numbers: string[], groups: TerritoryGroup[]) {
  const of = numbers.map(() => -1);
  const problems: string[] = [];
  groups.forEach((g, gi) => {
    const { matched, unknown } = parseNumbers(g.numbers, numbers);
    if (unknown.length) problems.push(`${g.name || `Group ${gi + 1}`}: no territory ${unknown.join(', ')}`);
    for (const n of matched) {
      const i = numbers.indexOf(n);
      if (of[i] === -1) of[i] = gi;
      else if (of[i] !== gi) problems.push(`Territory ${n} is in ${groups[of[i]].name || `group ${of[i] + 1}`} and ${g.name || `group ${gi + 1}`}`);
    }
  });
  return { of, problems };
}

/** "1, 2, 3, 5, 7a" → "1–3, 5, 7a". */
export function compactNumbers(nums: string[]): string {
  const sorted = [...nums].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && /^\d+$/.test(sorted[j + 1]) && /^\d+$/.test(sorted[j]) && Number(sorted[j + 1]) === Number(sorted[j]) + 1) j++;
    out.push(j - i >= 2 ? `${sorted[i]}–${sorted[j]}` : sorted.slice(i, j + 1).join(', '));
    i = j;
  }
  return out.join(', ');
}

export const defaultPoster = (): PosterOptions => ({
  paper: '2A0',
  colorful: true,
  color: '#e8a33d',
  numberScale: 1,
  names: true,
  frame: true,
  qr: true,
  compass: true,
  scaleBar: true,
  link: '',
  byGroup: false,
  groups: [],
});

export const DPI = 300;
const MAP_SCALE = 2.5; // device pixels per CSS pixel at 300 dpi; map labels about 7 pt on paper
const TILE_CSS = 1024; // tile size in CSS pixels
const OVERLAP_CSS = 96; // drawn around each tile and cut off, so labels at tile edges are not clipped
const EARTH_M = 40075016.686;
const TEXT_FONT = '"Noto Sans", "Noto Sans Malayalam", sans-serif';
const TITLE_FONT = '"Noto Serif", "Noto Sans Malayalam", serif';
const RIBBON = '#2563ae';
// Soft colours like a printed street map; neighbours never share one.
const PALETTE = ['#f4a261', '#9b7fd1', '#5fb3b3', '#f2d16b', '#e07a9f', '#6c8fd6', '#8cc084', '#b5838d', '#e9c46a', '#78b7d0', '#c9a0dc', '#a3a380'];

type XY = [number, number];
type Box = { x: number; y: number; w: number; h: number };
const QR_BOX = [150, 180];
const LEGEND_ROW = 40; // legend row height in page units // width, height in page units (1/1000 of the short side)
const merc = (ll: number[]): XY => {
  const m = maplibregl.MercatorCoordinate.fromLngLat(ll as [number, number]);
  return [m.x, m.y];
};
/** A rich, deep tone of `hex` (same hue, more saturated, darker) that white text reads well on. */
export const deepTone = (hex: string) => {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(max + min - 1));
  return `hsl(${Math.round((h * 60 + 360) % 360)} ${Math.round(Math.min(0.75, sat * 1.15 + 0.1) * 100)}% 34%)`;
};
const rings = (a: Area) => (a.type === 'Polygon' ? a.coordinates : a.coordinates.flat());

/** Greedy colouring: each territory takes the first palette colour none of its neighbours has. */
export function neighbourColours(areas: Area[], n = PALETTE.length): number[] {
  const boxes = areas.map((a) => {
    const pts = rings(a).flat();
    return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  });
  const pad = 1e-4;
  const out: number[] = [];
  areas.forEach((a, i) => {
    const used = new Set<number>();
    for (let j = 0; j < i; j++) {
      const [b, c] = [boxes[i], boxes[j]];
      if (b[0] > c[2] + pad || c[0] > b[2] + pad || b[1] > c[3] + pad || c[1] > b[3] + pad) continue;
      if (areasTouch(a, areas[j])) used.add(out[j]);
    }
    let k = 0;
    while (used.has(k) && k < n - 1) k++;
    out.push(used.has(k) ? i % n : k);
  });
  return out;
}

export interface Layout {
  W: number;
  H: number;
  /** Pixels per Web Mercator unit and the Mercator point at pixel (0, 0). */
  scale: number;
  origin: XY;
  zoom: number;
  /** Device pixels per CSS pixel of the background map. */
  ratio: number;
  /** `fill` is the territory's colour on the map; its badge uses a deep tone of it. */
  shapes: { path: XY[][]; label: XY; number: string; name: string; fill: string }[];
  /** Groups shown on this map, with their joined outline and legend text. */
  groups: { name: string; color: string; path: XY[][]; numbers: string }[];
  outline: XY[][];
  title: Box;
  u: number;
  place: { qr?: Box; scale?: Box; compass?: Box; legend?: Box };
}

/**
 * Page size and map position. The page turns to fit the shape of the congregation; `dpi` below 300 is used
 * for the on-screen preview and gives the same layout, only with fewer pixels.
 */
export function layout(ts: Territory[], boundary: Area | undefined, opt: PosterOptions, dpi = DPI): Layout {
  const all = ts.flatMap((t) => rings(t.geometry).flat().map(merc));
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const [a, b] = PAPERS[opt.paper].map((mm) => Math.round((mm / 25.4) * dpi));
  const portrait = y1 - y0 >= x1 - x0;
  const [W, H] = portrait ? [a, b] : [b, a];
  const u = Math.min(W, H) / 1000;
  const m = 40 * u;
  const title = { w: Math.min(W - 2 * m, 620 * u), h: 150 * u, x: 0, y: m };
  title.x = W - m - title.w;
  // The territories fill the whole page when the title box then covers none of them; otherwise the page below it.
  const fit = (box: Box) => {
    const k = Math.min(box.w / (x1 - x0), box.h / (y1 - y0));
    return { k, o: [(x0 + x1) / 2 - (box.x + box.w / 2) / k, (y0 + y1) / 2 - (box.y + box.h / 2) / k] as XY };
  };
  const mercRings = ts.flatMap((t) => rings(t.geometry).map((r) => r.map(merc)));
  const inMerc = (x: number, y: number) =>
    mercRings.reduce((odd, r) => {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) if (r[i][1] > y !== r[j][1] > y && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) odd = !odd;
      return odd;
    }, false);
  const full = fit({ x: m, y: m, w: W - 2 * m, h: H - 2 * m });
  let titleCovers = false;
  for (let i = 0; i <= 12 && !titleCovers; i++)
    for (let j = 0; j <= 6 && !titleCovers; j++) titleCovers = inMerc((title.x + (title.w * i) / 12) / full.k + full.o[0], (title.y + (title.h * j) / 6) / full.k + full.o[1]);
  const base = titleCovers ? fit({ x: m, y: title.y + title.h + m, w: W - 2 * m, h: H - title.y - title.h - 2 * m }) : full;
  // The user's zoom is around the middle of the page; the pan moves the map by a share of the page.
  const view = opt.view ?? { zoom: 1, x: 0, y: 0 };
  const scale = base.k * view.zoom;
  const centre: XY = [base.o[0] + W / 2 / base.k, base.o[1] + H / 2 / base.k];
  const origin: XY = [centre[0] - (W / 2 + view.x * W) / scale, centre[1] - (H / 2 + view.y * H) / scale];
  const ratio = (MAP_SCALE * dpi) / DPI;
  const zoom = Math.log2(scale / (512 * ratio));
  const px = (ll: number[]): XY => {
    const [mx, my] = merc(ll);
    return [(mx - origin[0]) * scale, (my - origin[1]) * scale];
  };
  const grouped = opt.byGroup && opt.groups.length > 0;
  const { of } = assignGroups(ts.map((t) => t.number), grouped ? opt.groups : []);
  const colours = grouped ? [] : neighbourColours(ts.map((t) => t.geometry));
  const fillOf = (i: number) => (grouped ? (of[i] >= 0 ? opt.groups[of[i]].color : UNGROUPED) : opt.colorful ? PALETTE[colours[i]] : opt.color);
  const shapes = ts.map((t, i) => ({ path: rings(t.geometry).map((r) => r.map(px)), label: px(interiorPoint(t.geometry)), number: t.number, name: t.locality.trim(), fill: fillOf(i) }));
  const groups = grouped
    ? opt.groups.flatMap((g, gi) => {
        const members = ts.filter((_, i) => of[i] === gi);
        if (!members.length) return [];
        const joined = mergeAreas(members.map((t) => t.geometry));
        return [{ name: g.name.trim() || `Group ${gi + 1}`, color: g.color, path: rings(joined).map((r) => r.map(px)), numbers: compactNumbers(members.map((t) => t.number)) }];
      })
    : [];
  const outline = boundary ? rings(boundary).map((r) => r.map(px)) : [];
  // QR, scale bar and north arrow each take the free corner that covers the least of the territories.
  const inside = (x: number, y: number) =>
    shapes.some((sh) =>
      sh.path.reduce((odd, ring) => {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
          if (ring[i][1] > y !== ring[j][1] > y && x < ((ring[j][0] - ring[i][0]) * (y - ring[i][1])) / (ring[j][1] - ring[i][1]) + ring[i][0]) odd = !odd;
        return odd;
      }, false),
    );
  const cover = (r: Box) => {
    let n = 0;
    for (let i = 0.5; i < 6; i++) for (let j = 0.5; j < 6; j++) if (inside(r.x + (r.w * i) / 6, r.y + (r.h * j) / 6)) n++;
    return n;
  };
  const items: [keyof Layout['place'], number, number][] = [];
  if (opt.qr) items.push(['qr', QR_BOX[0] * u, QR_BOX[1] * u]);
  if (opt.scaleBar) items.push(['scale', 300 * u, 70 * u]);
  if (opt.compass) items.push(['compass', 100 * u, 100 * u]);
  if (groups.length) items.splice(0, 0, ['legend', 340 * u, (56 + groups.length * LEGEND_ROW) * u]);
  // Corners free of the title, plus the spot under the title box.
  const free = ['tl', 'bl', 'br', 'tr'];
  const place: Layout['place'] = {};
  for (const [key, w, h] of items) {
    if (!free.length) break;
    const at = (c: string): Box => ({ x: c === 'br' || c === 'tr' ? W - m - w : m, y: c === 'tl' ? m : c === 'tr' ? title.y + title.h + m : H - m - h, w, h });
    const best = free.map((c) => ({ c, n: cover(at(c)) })).reduce((a, b) => (b.n < a.n ? b : a));
    free.splice(free.indexOf(best.c), 1);
    place[key] = at(best.c);
  }
  return { W, H, scale, origin, zoom, ratio, shapes, groups, outline, title, u, place };
}

const tracePath = (ctx: CanvasRenderingContext2D, path: XY[][]) => {
  ctx.beginPath();
  for (const ring of path) {
    ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }
};

/** Everything drawn over the background map, in page pixels. */
function drawOverlay(ctx: CanvasRenderingContext2D, L: Layout, opt: PosterOptions, s: Settings, qr: HTMLCanvasElement | null) {
  const { u } = L;
  ctx.lineJoin = 'round';
  for (const sh of L.shapes) {
    tracePath(ctx, sh.path);
    ctx.globalAlpha = opt.colorful || L.groups.length ? 0.42 : 0.32;
    ctx.fillStyle = sh.fill;
    ctx.fill('evenodd');
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = 'rgba(30,30,30,0.85)';
  ctx.lineWidth = 1.6 * u;
  for (const sh of L.shapes) {
    tracePath(ctx, sh.path);
    ctx.stroke();
  }
  // Each group gets a bold outline in its own deep colour, on a white halo so it reads over any fill.
  for (const g of L.groups) {
    tracePath(ctx, g.path);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 9 * u;
    ctx.stroke();
    ctx.strokeStyle = deepTone(g.color);
    ctx.lineWidth = 5 * u;
    ctx.stroke();
  }
  if (L.outline.length) {
    tracePath(ctx, L.outline);
    ctx.strokeStyle = '#1b1b1b';
    ctx.lineWidth = 4 * u;
    ctx.stroke();
  }

  // Each number sits in a badge: a deep shade of its territory's colour, a white ring and a soft shadow.
  // The locality name hangs from it in a white tab edged in the same colour.
  const size = 22 * u * opt.numberScale;
  const nameSize = size * 0.42;
  const edge = Math.max(1.2 * u, size * 0.09);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const sh of L.shapes) {
    const [x, y] = sh.label;
    const deep = deepTone(sh.fill);
    ctx.font = `800 ${size}px ${TEXT_FONT}`;
    const r = Math.max(size * 0.78, ctx.measureText(sh.number).width / 2 + size * 0.3);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = size * 0.3;
    ctx.shadowOffsetY = size * 0.07;
    if (opt.names && sh.name) {
      ctx.font = `700 ${nameSize}px ${TEXT_FONT}`;
      const w = ctx.measureText(sh.name).width + nameSize * 1.3;
      const h = nameSize * 1.7;
      const top = y + r - edge;
      ctx.beginPath();
      ctx.roundRect(x - w / 2, top, w, h, h / 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = edge * 0.9;
      ctx.strokeStyle = deep;
      ctx.stroke();
      ctx.fillStyle = deep;
      ctx.fillText(sh.name, x, top + h / 2 + nameSize * 0.05);
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = deep;
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, r - edge * 1.6, 0, 2 * Math.PI);
    ctx.lineWidth = edge * 0.8;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
    ctx.font = `800 ${size}px ${TEXT_FONT}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(sh.number, x, y + size * 0.04);
  }

  if (opt.frame) {
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 6 * u;
    ctx.strokeRect(12 * u, 12 * u, L.W - 24 * u, L.H - 24 * u);
    ctx.lineWidth = 1.5 * u;
    ctx.strokeRect(22 * u, 22 * u, L.W - 44 * u, L.H - 44 * u);
  }

  // Title box with a blue ribbon on the left, as on the hand-made map.
  const t = L.title;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(t.x + 4 * u, t.y + 4 * u, t.w, t.h);
  ctx.fillStyle = '#fff';
  ctx.fillRect(t.x, t.y, t.w, t.h);
  ctx.fillStyle = RIBBON;
  ctx.fillRect(t.x, t.y, 30 * u, t.h);
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 2 * u;
  ctx.strokeRect(t.x, t.y, t.w, t.h);
  const name = s.congregation.trim().toUpperCase();
  const line2 = !name ? 'CONGREGATION' : /CONGREGATION/.test(name) ? name : `${name} CONGREGATION`;
  const textX = t.x + t.w - 20 * u;
  const maxW = t.w - 30 * u - 40 * u;
  ctx.fillStyle = '#111';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  const fit = (text: string, start: number) => {
    let n = start;
    ctx.font = `700 ${n}px ${TITLE_FONT}`;
    while (n > 8 * u && ctx.measureText(text).width > maxW) ctx.font = `700 ${--n}px ${TITLE_FONT}`;
    return n;
  };
  // First line: "TERRITORY MAP" with a smaller "OF", like the original.
  const big = fit('TERRITORY MAP OF', 52 * u);
  ctx.font = `700 ${big * 0.7}px ${TITLE_FONT}`;
  const ofW = ctx.measureText(' OF').width;
  ctx.fillText(' OF', textX, t.y + t.h * 0.44);
  ctx.font = `700 ${big}px ${TITLE_FONT}`;
  ctx.fillText('TERRITORY MAP', textX - ofW, t.y + t.h * 0.44);
  fit(line2, 52 * u);
  ctx.fillText(line2, textX, t.y + t.h * 0.86);

  const { qr: qb, compass: cb, scale: sb, legend: lb } = L.place;
  if (lb) {
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillRect(lb.x, lb.y, lb.w, lb.h);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1.5 * u;
    ctx.strokeRect(lb.x, lb.y, lb.w, lb.h);
    ctx.fillStyle = RIBBON;
    ctx.fillRect(lb.x, lb.y, lb.w, 40 * u);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${18 * u}px ${TEXT_FONT}`;
    ctx.fillText('GROUPS', lb.x + 16 * u, lb.y + 21 * u);
    L.groups.forEach((g, i) => {
      const cy = lb.y + (48 + LEGEND_ROW * i + LEGEND_ROW / 2) * u;
      const deep = deepTone(g.color);
      ctx.beginPath();
      ctx.arc(lb.x + 30 * u, cy, 12 * u, 0, 2 * Math.PI);
      ctx.fillStyle = g.color;
      ctx.fill();
      ctx.lineWidth = 3 * u;
      ctx.strokeStyle = deep;
      ctx.stroke();
      const textX = lb.x + 54 * u;
      const maxW = lb.x + lb.w - 14 * u - textX;
      ctx.fillStyle = deep;
      ctx.font = `800 ${15 * u}px ${TEXT_FONT}`;
      ctx.fillText(g.name, textX, cy - 8 * u, maxW);
      ctx.fillStyle = '#333';
      ctx.font = `600 ${11.5 * u}px ${TEXT_FONT}`;
      ctx.fillText(`Territories ${g.numbers}`, textX, cy + 9 * u, maxW);
    });
  }
  if (qr && qb) {
    const pad = 10 * u;
    const q = qb.w - 2 * pad;
    ctx.fillStyle = '#fff';
    ctx.fillRect(qb.x, qb.y, qb.w, qb.h);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1.5 * u;
    ctx.strokeRect(qb.x, qb.y, qb.w, qb.h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(qr, qb.x + pad, qb.y + pad, q, q);
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${11 * u}px ${TEXT_FONT}`;
    ctx.fillText('Scan to see map online', qb.x + qb.w / 2, (qb.y + pad + q + qb.y + qb.h) / 2);
  }

  if (cb) {
    const cx = cb.x + cb.w / 2;
    const cy = cb.y + cb.h / 2;
    const r = cb.w * 0.45;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1.5 * u;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.8);
    ctx.lineTo(cx + r * 0.28, cy + r * 0.15);
    ctx.lineTo(cx, cy);
    ctx.closePath();
    ctx.fillStyle = '#111';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.8);
    ctx.lineTo(cx - r * 0.28, cy + r * 0.15);
    ctx.lineTo(cx, cy);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.stroke();
    ctx.font = `800 ${20 * u}px ${TEXT_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#111';
    ctx.fillText('N', cx, cy + r * 0.5);
  }

  if (sb) {
    // Ground metres per page pixel at the middle of the page; the bar is the longest round length that fits.
    const midY = L.origin[1] + L.H / 2 / L.scale;
    const lat = 2 * Math.atan(Math.exp(Math.PI * (1 - 2 * midY))) - Math.PI / 2;
    const mPerPx = (EARTH_M * Math.cos(lat)) / L.scale;
    const nice = [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000].filter((v) => v / mPerPx <= sb.w - 30 * u).pop() ?? 10;
    const w = nice / mPerPx;
    const x = sb.x + (sb.w - w) / 2;
    const h = 8 * u;
    const y = sb.y + sb.h - 18 * u - h;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(sb.x, sb.y, sb.w, sb.h);
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 ? '#fff' : '#111';
      ctx.fillRect(x + (w / 4) * i, y, w / 4, h);
    }
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1.2 * u;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#111';
    ctx.font = `600 ${14 * u}px ${TEXT_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, x + w / 2, y - 10 * u);
  }
}

/** Link opened by the poster's QR code. */
export function posterLink(s: Settings, opt: PosterOptions, boundary: Area): string {
  if (safeUrl(opt.link)) return safeUrl(opt.link);
  return qrLink({ id: 'all', number: '', locality: s.congregation ? `${s.congregation} congregation` : 'All territories', geometry: boundary, buildings: 0 }, s);
}

async function qrCanvas(link: string) {
  const c = document.createElement('canvas');
  await QRCode.toCanvas(c, link, { errorCorrectionLevel: 'L', margin: 0, width: 1200 });
  return c;
}

/** One reusable off-screen map, `cssSize` square, drawn at `ratio` device pixels per CSS pixel. */
function backgroundMap(cssSize: number, ratio: number): Promise<{ map: maplibregl.Map; done: () => void }> {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;left:-20000px;top:0;width:${cssSize}px;height:${cssSize}px`;
  document.body.appendChild(el);
  const map = new maplibregl.Map({
    container: el,
    style: CARD_STYLE_URL,
    interactive: false,
    attributionControl: false,
    pixelRatio: ratio,
    canvasContextAttributes: { preserveDrawingBuffer: true },
    fadeDuration: 0,
    maxCanvasSize: [8192, 8192],
    center: [76.3, 10],
    zoom: 12,
  });
  const done = () => {
    map.remove();
    el.remove();
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      done();
      reject(new Error('The map did not load. Check the internet connection, and keep this tab in front while the map is made.'));
    }, 30000);
    map.once('load', () => {
      clearTimeout(timer);
      resolve({ map, done });
    });
  });
}

const idle = (map: maplibregl.Map) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 30000);
    map.once('idle', () => {
      clearTimeout(timer);
      resolve();
    });
    map.triggerRepaint();
  });

/**
 * Draws the page region [x, y, w, h] (page pixels) into `ctx` at (0, 0): background map, then the overlay.
 * The map canvas is `mapPx` plus the overlap on every side; its inner top-left corner is page point (x, y).
 */
async function drawRegion(ctx: CanvasRenderingContext2D, map: maplibregl.Map, L: Layout, x: number, y: number, w: number, h: number, mapPx: number, draw: (c: CanvasRenderingContext2D) => void) {
  const cx = L.origin[0] + (x + mapPx / 2) / L.scale;
  const cy = L.origin[1] + (y + mapPx / 2) / L.scale;
  map.jumpTo({ center: new maplibregl.MercatorCoordinate(cx, cy).toLngLat(), zoom: L.zoom });
  await idle(map);
  const c = map.getCanvas();
  const off = (c.width - mapPx) / 2;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(c, off, off, w, h, 0, 0, w, h);
  ctx.save();
  ctx.translate(-x, -y);
  draw(ctx);
  ctx.restore();
}

/** Small whole-page picture for the screen. Same layout as the print, with a less detailed background. */
export async function renderPosterPreview(ts: Territory[], boundary: Area, s: Settings, opt: PosterOptions, heightPx = 1400): Promise<HTMLCanvasElement> {
  const dpi = (heightPx / PAPERS[opt.paper][1]) * 25.4;
  const L = layout(ts, boundary, opt, dpi);
  await ensureFonts(s.congregation);
  const qr = opt.qr ? await qrCanvas(posterLink(s, opt, boundary)) : null;
  const canvas = document.createElement('canvas');
  canvas.width = L.W;
  canvas.height = L.H;
  const side = Math.max(L.W, L.H);
  const P: Layout = { ...L, ratio: 1, zoom: Math.log2(L.scale / 512) };
  const { map, done } = await backgroundMap(side + 2 * OVERLAP_CSS, 1);
  try {
    await drawRegion(canvas.getContext('2d')!, map, P, 0, 0, L.W, L.H, side, (c) => drawOverlay(c, L, opt, s, qr));
  } finally {
    done();
  }
  return canvas;
}

const toJpeg = (c: HTMLCanvasElement) =>
  new Promise<ArrayBuffer>((resolve, reject) => c.toBlob((b) => (b ? b.arrayBuffer().then(resolve) : reject(new Error('Could not draw the map'))), 'image/jpeg', 0.9));

/** Print-quality PDF of the whole map at 300 dpi, one page. */
export async function posterPdf(ts: Territory[], boundary: Area, s: Settings, opt: PosterOptions, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  const L = layout(ts, boundary, opt);
  await ensureFonts(s.congregation);
  const qr = opt.qr ? await qrCanvas(posterLink(s, opt, boundary)) : null;
  const tile = Math.round(TILE_CSS * L.ratio);
  const cols = Math.ceil(L.W / tile);
  const rows = Math.ceil(L.H / tile);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Territory map${s.congregation ? ` - ${s.congregation}` : ''}`);
  pdf.setCreator('Territory Manager');
  const pt = 72 / DPI;
  const page = pdf.addPage([L.W * pt, L.H * pt]);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const { map, done } = await backgroundMap(TILE_CSS + 2 * OVERLAP_CSS, L.ratio);
  try {
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        signal?.throwIfAborted();
        onProgress?.(r * cols + c, rows * cols);
        const x = c * tile;
        const y = r * tile;
        const w = Math.min(tile, L.W - x);
        const h = Math.min(tile, L.H - y);
        canvas.width = w;
        canvas.height = h;
        await drawRegion(ctx, map, L, x, y, w, h, tile, (cx) => drawOverlay(cx, L, opt, s, qr));
        const img = await pdf.embedJpg(await toJpeg(canvas));
        page.drawImage(img, { x: x * pt, y: (L.H - y - h) * pt, width: w * pt, height: h * pt });
      }
  } finally {
    done();
  }
  onProgress?.(rows * cols, rows * cols);
  return pdf.save();
}
