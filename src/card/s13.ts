// Territory Assignment Record (S-13-E 1/22), filled from the work log and drawn like the printed form.
// Layout measurements are taken from the form at 918 × 1300 units and scaled to an A4 page.
import { PDFDocument } from 'pdf-lib';
import type { Assignment, Territory } from '../types';

export interface S13Slot {
  name: string;
  assigned: string;
  completed: string;
}
export interface S13Row {
  number: string;
  last: string;
  slots: S13Slot[];
}

/** Service year 2026 runs from 1 September 2025 to 31 August 2026. */
export const serviceYearOf = (isoDate: string) => +isoDate.slice(0, 4) + (+isoDate.slice(5, 7) >= 9 ? 1 : 0);

const SLOTS = 4;
const ROWS = 20;

/** One row per territory (more when it was given out over four times that year), in number order. */
export function s13Rows(territories: Territory[], assignments: Assignment[], year: number): S13Row[] {
  const start = `${year - 1}-09-01`;
  const end = `${year}-08-31`;
  const sorted = [...territories].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  return sorted.flatMap((t) => {
    const mine = assignments.filter((a) => a.territoryId === t.id);
    const last = mine.map((a) => a.completedOn ?? '').filter((d) => d && d < start).sort().pop() ?? '';
    const slots = mine
      .filter((a) => a.assignedOn >= start && a.assignedOn <= end)
      .sort((a, b) => a.assignedOn.localeCompare(b.assignedOn))
      .map((a) => ({ name: a.publisher, assigned: a.assignedOn, completed: a.completedOn ?? '' }));
    const rows: S13Row[] = [];
    for (let i = 0; i === 0 || i < slots.length; i += SLOTS) rows.push({ number: t.number, last: rows.length ? '' : last, slots: slots.slice(i, i + SLOTS) });
    return rows;
  });
}

/** dd/mm/yy, short enough for the form's date boxes. */
const short = (iso: string) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : '');

const W = 918;
const H = 1300;
const LEFT = 55;
const RIGHT = 873;
const HEAD_TOP = 168;
const HEAD_MID = 196;
const HEAD_BOTTOM = 226;
const BODY_BOTTOM = 1198;
const COLS = [LEFT, 110, 210, 376, 541, 707, RIGHT];
const FONT = 'Arial, "Noto Sans", "Noto Sans Malayalam", sans-serif';

function drawPage(rows: S13Row[], year: number, dpi = 200): HTMLCanvasElement {
  const scale = (8.27 * dpi) / W;
  const c = document.createElement('canvas');
  c.width = Math.round(W * scale);
  c.height = Math.round(H * scale);
  const g = c.getContext('2d')!;
  g.scale(scale, scale);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  const text = (s: string, x: number, y: number, size: number, o: { bold?: boolean; align?: CanvasTextAlign; maxW?: number; color?: string } = {}) => {
    g.font = `${o.bold ? 700 : 400} ${size}px ${FONT}`;
    g.fillStyle = o.color ?? '#111';
    g.textAlign = o.align ?? 'left';
    g.textBaseline = 'middle';
    let fit = s;
    while (o.maxW && fit.length > 1 && g.measureText(fit).width > o.maxW) fit = fit.slice(0, -1);
    g.fillText(fit === s ? s : `${fit.slice(0, -1)}…`, x, y);
  };
  const line = (x1: number, y1: number, x2: number, y2: number, w: number) => {
    g.lineWidth = w;
    g.strokeStyle = '#111';
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
  };

  text('TERRITORY ASSIGNMENT RECORD', W / 2, 97, 17, { bold: true, align: 'center' });
  text('Service Year:', LEFT, 145, 13.5, { bold: true });
  line(187, 152, 273, 152, 1.2);
  text(String(year), 230, 143, 13.5, { align: 'center' });

  // Grey header band over the four "Assigned to" groups.
  g.fillStyle = '#d9d9d9';
  g.fillRect(COLS[2], HEAD_TOP, RIGHT - COLS[2], HEAD_BOTTOM - HEAD_TOP);
  const grey = '#333';
  text('Terr.', (COLS[0] + COLS[1]) / 2, 189, 11, { align: 'center', color: grey });
  text('no.', (COLS[0] + COLS[1]) / 2, 204, 11, { align: 'center', color: grey });
  text('Last date', (COLS[1] + COLS[2]) / 2, 189, 11, { align: 'center', color: grey });
  text('completed*', (COLS[1] + COLS[2]) / 2, 204, 11, { align: 'center', color: grey });
  for (let k = 0; k < SLOTS; k++) {
    const a = COLS[2 + k];
    const b = COLS[3 + k];
    const mid = (a + b) / 2;
    text('Assigned to', mid, 183, 11, { align: 'center', color: grey });
    text('Date', (a + mid) / 2, 205, 9, { align: 'center', color: grey });
    text('assigned', (a + mid) / 2, 217, 9, { align: 'center', color: grey });
    text('Date', (mid + b) / 2, 205, 9, { align: 'center', color: grey });
    text('completed', (mid + b) / 2, 217, 9, { align: 'center', color: grey });
    line(a, HEAD_MID, b, HEAD_MID, 0.8);
    line(mid, HEAD_MID, mid, HEAD_BOTTOM, 0.8);
  }

  const rowH = (BODY_BOTTOM - HEAD_BOTTOM) / ROWS;
  for (let r = 0; r < ROWS; r++) {
    const top = HEAD_BOTTOM + r * rowH;
    const half = top + rowH / 2;
    for (let k = 0; k < SLOTS; k++) {
      const a = COLS[2 + k];
      const b = COLS[3 + k];
      line(a, half, b, half, 0.8);
      line((a + b) / 2, half, (a + b) / 2, top + rowH, 0.8);
    }
    if (r) line(LEFT, top, RIGHT, top, 2);
    const row = rows[r];
    if (!row) continue;
    text(row.number, (COLS[0] + COLS[1]) / 2, half, 13, { align: 'center' });
    text(short(row.last), (COLS[1] + COLS[2]) / 2, half, 12, { align: 'center' });
    row.slots.forEach((s, k) => {
      const a = COLS[2 + k];
      const b = COLS[3 + k];
      const mid = (a + b) / 2;
      text(s.name, mid, top + rowH / 4, 11.5, { align: 'center', maxW: b - a - 8 });
      text(short(s.assigned), (a + mid) / 2, top + (rowH * 3) / 4, 11, { align: 'center' });
      text(short(s.completed), (mid + b) / 2, top + (rowH * 3) / 4, 11, { align: 'center' });
    });
  }

  // Heavy rules: under the header, between the column groups, and the frame.
  line(LEFT, HEAD_BOTTOM, RIGHT, HEAD_BOTTOM, 2);
  for (const x of COLS.slice(1, -1)) line(x, HEAD_TOP, x, BODY_BOTTOM, x === COLS[1] ? 0.8 : 2.4);
  g.lineWidth = 3;
  g.strokeRect(LEFT, HEAD_TOP, RIGHT - LEFT, BODY_BOTTOM - HEAD_TOP);

  text('*When beginning a new sheet, use this column to record the date on which each territory was last completed.', LEFT, 1214, 11.5);
  text('S-13-E  1/22', LEFT, 1243, 10);
  return c;
}

/** The record for one service year as an A4 PDF, 20 rows a page. */
export async function s13Pdf(territories: Territory[], assignments: Assignment[], year: number): Promise<Uint8Array> {
  const rows = s13Rows(territories, assignments, year);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Territory Assignment Record – Service Year ${year}`);
  for (let i = 0; i < Math.max(rows.length, 1); i += ROWS) {
    const canvas = drawPage(rows.slice(i, i + ROWS), year);
    const png = await new Promise<Blob>((ok, bad) => canvas.toBlob((b) => (b ? ok(b) : bad(new Error('Could not draw the record'))), 'image/png'));
    const page = pdf.addPage([595.28, 841.89]);
    page.drawImage(await pdf.embedPng(await png.arrayBuffer()), { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }
  return pdf.save();
}
