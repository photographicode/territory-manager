// Guards for data that leaves the app: links printed in QR codes, spreadsheet cells, and restored backups.

/** `s` if it is an http(s) URL, otherwise ''. QR codes must never carry javascript:, data: or other schemes. */
export function safeUrl(s: string | undefined | null): string {
  const v = (s ?? '').trim();
  if (!v) return '';
  try {
    return /^https?:$/.test(new URL(v).protocol) ? v : '';
  } catch {
    return '';
  }
}

/** A CSV cell that spreadsheets show as text: quoted when needed, and never read as a formula. */
export function csvCell(v: string | number): string {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
const ring = (r: unknown) => Array.isArray(r) && r.length >= 4 && r.every((p) => Array.isArray(p) && p.length >= 2 && finite(p[0]) && finite(p[1]));
/** True for a GeoJSON Polygon or MultiPolygon with numeric coordinates. */
export function validArea(g: unknown): boolean {
  const a = g as { type?: unknown; coordinates?: unknown };
  if (!a || !Array.isArray(a.coordinates)) return false;
  if (a.type === 'Polygon') return a.coordinates.length > 0 && a.coordinates.every(ring);
  if (a.type === 'MultiPolygon') return a.coordinates.length > 0 && a.coordinates.every((p) => Array.isArray(p) && p.length > 0 && p.every(ring));
  return false;
}

/** Reason a parsed backup cannot be restored, or ''. */
export function backupProblem(d: unknown): string {
  const b = d as { version?: unknown; territories?: unknown; assignments?: unknown; settings?: { viewerUrl?: unknown } } | null;
  if (!b || b.version !== 1 || !Array.isArray(b.territories)) return 'This is not a Territory Manager backup.';
  const bad = b.territories.findIndex((t: { id?: unknown; number?: unknown; locality?: unknown; geometry?: unknown }) => typeof t?.id !== 'string' || typeof t.number !== 'string' || typeof t.locality !== 'string' || !validArea(t.geometry));
  if (bad >= 0) return `Territory ${bad + 1} in this backup is damaged, so nothing was restored.`;
  if (b.assignments !== undefined && !Array.isArray(b.assignments)) return 'The assignment records in this backup are damaged.';
  const url = b.settings?.viewerUrl;
  if (url !== undefined && url !== '' && (typeof url !== 'string' || !safeUrl(url))) return 'The map page address in this backup is not a web address.';
  return '';
}
