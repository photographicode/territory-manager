// Receives a boundary file from the territory dashboard (territory.congregationassistant.com), which opens this
// page and waits for "ready". Only the window that opened this page, on an allowed origin, can send a file.
export const READY = 'tm-generator-ready';
export const IMPORT = 'tm-import';
export const NAMES = 'tm-names';
const MAX_BYTES = 8 * 1024 * 1024;
// Only the territory owner dashboard may send files.
const TRUSTED = ['https://territory.congregationassistant.com'];
// Local development of both apps runs on different localhost ports.
const trusted = (origin: string) => origin === globalThis.location?.origin || TRUSTED.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);

export interface Incoming {
  file: File;
  congregation: string;
}

/** Parses a message into an import, or null when it is not one we accept. */
export function parseImport(e: Pick<MessageEvent, 'origin' | 'data'>): Incoming | null {
  if (!trusted(e.origin)) return null;
  const d = e.data as { type?: unknown; name?: unknown; congregation?: unknown; bytes?: unknown } | null;
  if (!d || d.type !== IMPORT || typeof d.name !== 'string' || !(d.bytes instanceof ArrayBuffer)) return null;
  const name = d.name.replace(/^.*[\\/]/, '').slice(0, 200);
  if (!/\.(kml|kmz)$/i.test(name) || !d.bytes.byteLength || d.bytes.byteLength > MAX_BYTES) return null;
  const congregation = typeof d.congregation === 'string' ? d.congregation.trim().slice(0, 150) : '';
  return { file: new File([d.bytes], name), congregation };
}

export interface NamedTerritory {
  number: string;
  locality: string;
  points: { name: string; lng: number; lat: number }[];
}
/** Parses the names a congregation wrote (sent from the territory dashboard), or null when it is not that. */
export function parseNames(e: Pick<MessageEvent, 'origin' | 'data'>): NamedTerritory[] | null {
  if (!trusted(e.origin)) return null;
  const d = e.data as { type?: unknown; names?: unknown } | null;
  if (!d || d.type !== NAMES || !Array.isArray(d.names) || d.names.length > 1000) return null;
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return d.names.flatMap((n: { number?: unknown; locality?: unknown; points?: unknown }) => {
    const number = text(n?.number, 20);
    if (!number) return [];
    const points = (Array.isArray(n.points) ? n.points : [])
      .filter((p: { lng?: unknown; lat?: unknown }) => Number.isFinite(p?.lng) && Number.isFinite(p?.lat))
      .map((p: { name?: unknown; lng: number; lat: number }) => ({ name: text(p.name, 80), lng: p.lng, lat: p.lat }))
      .filter((p) => p.name);
    return [{ number, locality: text(n.locality, 150), points }];
  });
}

/** Tells the opener this page is ready and calls `onFile` for each accepted file. Returns a cleanup function. */
export function listenForHandoff(onFile: (i: Incoming) => void, onNames?: (n: NamedTerritory[]) => void): () => void {
  const opener = window.opener as Window | null;
  if (!opener) return () => undefined;
  const listener = (e: MessageEvent) => {
    if (e.source !== opener) return;
    const got = parseImport(e);
    if (got) onFile(got);
    const names = parseNames(e);
    if (names && onNames) onNames(names);
  };
  addEventListener('message', listener);
  // The ready message carries nothing, so any opener origin may receive it; the reply is checked above.
  opener.postMessage({ type: READY }, '*');
  return () => removeEventListener('message', listener);
}
