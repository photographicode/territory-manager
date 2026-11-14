// Draws territory cards on a canvas. Text is rendered by the browser, so Malayalam and other
// complex scripts are shaped correctly before the card is placed into the PDF as an image.
import QRCode from 'qrcode';
import { PDFDocument } from 'pdf-lib';
import * as maplibregl from './maplibre';
import { CARD_STYLE_URL } from './tiles';
import { encodeArea } from '../geo/codec';
import { shareOutline } from '../geo/core';
import type { Area, FooterFont, Landmark, Settings, Territory } from '../types';
import { safeUrl } from '../safe';

export const CARD = { widthIn: 6, heightIn: 4, dpi: 300 };
const W = CARD.widthIn * CARD.dpi;
const H = CARD.heightIn * CARD.dpi;
// Noto covers every Indian script; the browser downloads only the scripts the text uses.
const INDIC = ['Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam'];
const families = (kind: 'Sans' | 'Serif') => [`Noto ${kind}`, ...INDIC.map((x) => `Noto ${kind} ${x}`)];
const stack = (kind: 'Sans' | 'Serif') => `${families(kind).map((f) => `"${f}"`).join(', ')}, ${kind === 'Sans' ? 'sans-serif' : 'serif'}`;
const TEXT_FONT = stack('Sans');
const TITLE_FONT = `"Noto Serif", ${stack('Sans')}`;
const footerFont = (f: FooterFont) => ({ kind: f.startsWith('serif') ? ('Serif' as const) : ('Sans' as const), weight: f.endsWith('bold') ? 700 : 400 });
// Keeps the QR at a size phones scan reliably when printed ~37 mm wide (about 90 outline points).
const MAX_QR_CODE = 450;

// Phones cannot open this computer's address, so cards made from the local copy point at the published one.
const PUBLIC_VIEWER = 'https://photographicode.github.io/territory-manager/view.html';
const isLocal = () => /^(localhost|127\.|\[::1\])/.test(location.hostname);
export const viewerUrl = (s: Settings) => safeUrl(s.viewerUrl) || (isLocal() ? PUBLIC_VIEWER : new URL('view.html', location.href).href);

/** Link encoded in the QR code: the territory's own map link, or the viewer page with the outline. */
export function qrLink(t: Territory, s: Settings): string {
  // Only web links go into a printed QR code.
  if (safeUrl(t.mapUrl)) return safeUrl(t.mapUrl);
  // Simplify only as much as needed to keep the QR code small enough to scan from a printed card.
  let tol = 0.000005;
  let code = encodeArea(shareOutline(t.geometry, tol));
  while (code.length > MAX_QR_CODE && tol < 0.005) {
    tol *= 1.4;
    code = encodeArea(shareOutline(t.geometry, tol));
  }
  const params = new URLSearchParams({ t: t.number, n: t.locality });
  return `${viewerUrl(s).split('#')[0]}#${params.toString()}&g=${code}`;
}

// --- map ------------------------------------------------------------------

const MAP_SCALE = 2.5; // device pixels per CSS pixel; keeps map labels ~7 pt when printed
let mapPromise: Promise<maplibregl.Map> | null = null;

/** One off-screen vector map, reused for every card. */
function offscreenMap(cssW: number, cssH: number): Promise<maplibregl.Map> {
  if (!mapPromise) {
    mapPromise = new Promise((resolve, reject) => {
      const el = document.createElement('div');
      el.style.cssText = `position:fixed;left:-10000px;top:0;width:${cssW}px;height:${cssH}px`;
      document.body.appendChild(el);
      const map = new maplibregl.Map({
        container: el,
        style: CARD_STYLE_URL,
        interactive: false,
        attributionControl: false,
        pixelRatio: MAP_SCALE,
        canvasContextAttributes: { preserveDrawingBuffer: true },
        fadeDuration: 0,
        center: [76.3, 10],
        zoom: 12,
      });
      // Give up after 30 s, so a map that never loads (offline, or the tab was in the background)
      // fails with a message instead of leaving the card waiting; the next card tries afresh.
      const fail = (err: Error) => {
        clearTimeout(timer);
        map.remove();
        el.remove();
        reject(err);
      };
      const timer = setTimeout(
        () => fail(new Error('The card map did not load. Check the internet connection, and keep this tab in front while cards are made.')),
        30000,
      );
      map.once('load', () => {
        clearTimeout(timer);
        resolve(map);
      });
      map.once('error', (e) => fail(new Error(e.error?.message || 'The card map could not load')));
    });
    mapPromise.catch(() => (mapPromise = null));
  }
  return mapPromise;
}

function rings(a: Area): number[][][] {
  return a.type === 'Polygon' ? a.coordinates : a.coordinates.flat();
}

type Project = (lonLat: [number, number]) => [number, number];

/** Share of the card map kept clear around the territory; wider with landmarks so their boxes fit beside the outline. */
export const mapMargin = (t: Territory) => (t.landmarks?.some((l) => l.text.trim()) ? 0.15 : 0.08);
/** Landmark label size on the 300 dpi card: 26 px is about 8.5 pt once the card is printed at half A4. */
const LANDMARK_FONT = 26;
const LANDMARK_BOX_H = 52;

/** Render an OpenStreetMap background with the territory outline into a w×h region; returns lon/lat → canvas pixels. */
export async function drawMap(ctx: CanvasRenderingContext2D, area: Area, x0: number, y0: number, w: number, h: number, margin = 0.08): Promise<Project> {
  const cssW = Math.round(w / MAP_SCALE);
  const cssH = Math.round(h / MAP_SCALE);
  const map = await offscreenMap(cssW, cssH);
  const pts = rings(area).flat();
  const lons = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  map.fitBounds(
    [
      [Math.min(...lons), Math.min(...lats)],
      [Math.max(...lons), Math.max(...lats)],
    ],
    { padding: { top: cssH * margin, bottom: cssH * margin, left: cssW * margin, right: cssW * margin }, maxZoom: 18, animate: false },
  );
  // Wait until every tile and label is drawn (or give up after 25 s and use what is there).
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 25000);
    map.once('idle', () => {
      clearTimeout(timer);
      resolve();
    });
    map.triggerRepaint();
  });

  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.clip();
  ctx.drawImage(map.getCanvas(), x0, y0, w, h);

  const project: Project = (ll) => {
    const p = map.project(ll);
    return [x0 + (p.x * w) / cssW, y0 + (p.y * h) / cssH];
  };
  ctx.beginPath();
  for (const ring of rings(area)) {
    ring.forEach(([lon, lat], i) => {
      const [px, py] = project([lon, lat]);
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    ctx.closePath();
  }
  ctx.fillStyle = 'rgba(192, 57, 43, 0.28)';
  ctx.fill('evenodd');
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(3, w / 300);
  ctx.strokeStyle = '#a5281b';
  ctx.stroke();

  ctx.restore();
  return project;
}

/** Small white label boxes with a dot on each spot, kept inside the map region. Sized for a 6×4 in card printed up to half A4. */
function drawLandmarks(ctx: CanvasRenderingContext2D, list: Landmark[], project: Project, r: { x: number; y: number; w: number; h: number }) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  const boxes = list
    .filter((l) => l.text.trim())
    .map((l) => {
      const [px, py] = project(l.at);
      const [cx, cy] = project(l.box);
      fitText(ctx, l.text.trim(), (n) => `600 ${n}px ${TEXT_FONT}`, LANDMARK_FONT, r.w * 0.36);
      const font = ctx.font;
      const bw = ctx.measureText(l.text.trim()).width + 32;
      const bh = LANDMARK_BOX_H;
      const bx = Math.min(Math.max(cx - bw / 2, r.x + 6), r.x + r.w - bw - 6);
      const by = Math.min(Math.max(cy - bh / 2, r.y + 6), r.y + r.h - bh - 6);
      return { text: l.text.trim(), font, px, py, bx, by, bw, bh };
    });
  // Leader lines first, so boxes and dots sit on top of them.
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 2;
  for (const b of boxes) {
    ctx.beginPath();
    ctx.moveTo(b.px, b.py);
    ctx.lineTo(b.bx + b.bw / 2, b.by + b.bh / 2);
    ctx.stroke();
  }
  for (const b of boxes) {
    ctx.beginPath();
    ctx.roundRect(b.bx, b.by, b.bw, b.bh, 8);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
    ctx.fill();
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.font = b.font;
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.text, b.bx + b.bw / 2, b.by + b.bh / 2 + 1);
  }
  for (const b of boxes) {
    ctx.beginPath();
    ctx.arc(b.px, b.py, 8, 0, 2 * Math.PI);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#a5281b';
    ctx.stroke();
  }
  ctx.restore();
}

// --- card ------------------------------------------------------------------

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > maxW && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

function dotted(ctx: CanvasRenderingContext2D, x1: number, x2: number, y: number) {
  ctx.save();
  ctx.setLineDash([2, 5]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#333';
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.restore();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, font: (size: number) => string, size: number, maxW: number) {
  let s = size;
  ctx.font = font(s);
  while (s > 14 && ctx.measureText(text).width > maxW) ctx.font = font(--s);
}

export async function ensureFonts(sample: string) {
  const faces = [`700 40px "Noto Serif"`, ...[400, 600, 700].flatMap((w) => families('Sans').map((f) => `${w} 40px "${f}"`)), ...[400, 700].flatMap((w) => families('Serif').map((f) => `${w} 40px "${f}"`))];
  await Promise.all(faces.map((f) => document.fonts.load(f, sample).catch(() => undefined)));
}

export async function renderCard(t: Territory, s: Settings): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  await ensureFonts(`${t.locality}${t.landmarks?.map((l) => l.text).join('') ?? ''}${s.footerText}${s.cardTitle}${s.localityLabel}${s.numberLabel}`);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 4;
  ctx.strokeRect(12, 12, W - 24, H - 24);
  ctx.lineWidth = 2;
  ctx.strokeRect(24, 24, W - 48, H - 48);

  ctx.fillStyle = '#111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  fitText(ctx, s.cardTitle, (n) => `700 ${n}px ${TITLE_FONT}`, 66, W - 200);
  ctx.fillText(s.cardTitle, W / 2, 112);

  // Locality and number row
  const rowY = 205;
  ctx.textAlign = 'left';
  ctx.font = `700 46px ${TITLE_FONT}`;
  ctx.fillText(s.localityLabel, 50, rowY);
  const locStart = 50 + ctx.measureText(s.localityLabel).width + 12;
  const numLabelW = ctx.measureText(s.numberLabel).width;
  const numLabelX = W - 50 - 340 - numLabelW;
  ctx.fillText(s.numberLabel, numLabelX, rowY);
  dotted(ctx, locStart, numLabelX - 30, rowY);
  dotted(ctx, numLabelX + numLabelW + 12, W - 50, rowY);
  ctx.textAlign = 'center';
  fitText(ctx, t.locality, (n) => `400 ${n}px ${TEXT_FONT}`, 44, numLabelX - 30 - locStart - 20);
  ctx.fillText(t.locality, (locStart + numLabelX - 30) / 2, rowY - 12);
  ctx.font = `400 46px ${TEXT_FONT}`;
  ctx.fillText(t.number, (numLabelX + numLabelW + 12 + W - 50) / 2, rowY - 12);

  // Map and QR
  const map = { x: 60, y: 255, w: 1190, h: 690 };
  const project = await drawMap(ctx, t.geometry, map.x, map.y, map.w, map.h, mapMargin(t));
  if (t.landmarks?.length) drawLandmarks(ctx, t.landmarks, project, map);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#555';
  ctx.strokeRect(map.x, map.y, map.w, map.h);

  const qr = { x: 1300, y: 355, size: 440 };
  ctx.strokeStyle = '#999';
  ctx.strokeRect(qr.x, qr.y, qr.size, qr.size);
  const qrCanvas = document.createElement('canvas');
  await QRCode.toCanvas(qrCanvas, qrLink(t, s), { errorCorrectionLevel: 'L', margin: 1, width: qr.size - 30 });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(qrCanvas, qr.x + 15, qr.y + 15, qr.size - 30, qr.size - 30);
  ctx.imageSmoothingEnabled = true;
  ctx.font = `400 26px ${TEXT_FONT}`;
  ctx.fillStyle = '#444';
  ctx.fillText('Scan to open the map', qr.x + qr.size / 2, qr.y + qr.size + 42);

  // Footer instructions
  ctx.fillStyle = '#111';
  const ff = footerFont(s.footerFont ?? 'sans-bold');
  // A chosen size (points on the card, 300 dpi) is kept unless the text would not fit; then it shrinks.
  let size = s.footerSize > 0 ? Math.round((s.footerSize * CARD.dpi) / 72) : 38;
  let lines: string[];
  do {
    ctx.font = `${ff.weight} ${size}px ${stack(ff.kind)}`;
    lines = wrap(ctx, s.footerText, W - 160);
  } while (lines.length * size * 1.4 > H - 990 && --size > 16);
  const lh = size * 1.4;
  const top = 975 + (H - 50 - 975 - lines.length * lh) / 2 + size;
  lines.forEach((l, i) => ctx.fillText(l, W / 2, top + i * lh));
  return canvas;
}

const toJpeg = (c: HTMLCanvasElement) =>
  new Promise<ArrayBuffer>((resolve, reject) =>
    c.toBlob((b) => (b ? b.arrayBuffer().then(resolve) : reject(new Error('Could not render card'))), 'image/jpeg', 0.9),
  );

/** `onProgress` gets how many cards are finished, before each card and once at the end. */
export async function cardsPdf(ts: Territory[], s: Settings, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Territory cards${s.congregation ? ` – ${s.congregation}` : ''}`);
  pdf.setCreator('Territory Manager');
  for (const [i, t] of ts.entries()) {
    signal?.throwIfAborted();
    onProgress?.(i, ts.length);
    const img = await pdf.embedJpg(await toJpeg(await renderCard(t, s)));
    const page = pdf.addPage([CARD.widthIn * 72, CARD.heightIn * 72]);
    page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }
  onProgress?.(ts.length, ts.length);
  return pdf.save();
}
