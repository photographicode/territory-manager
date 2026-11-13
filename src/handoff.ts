// Receives a boundary file from the territory dashboard (territory.congregationassistant.com), which opens this
// page and waits for "ready". Only the window that opened this page, on an allowed origin, can send a file.
export const READY = 'tm-generator-ready';
export const IMPORT = 'tm-import';
const MAX_BYTES = 8 * 1024 * 1024;
const TRUSTED = ['https://territory.congregationassistant.com', 'https://congregationassistant.com'];
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

/** Tells the opener this page is ready and calls `onFile` for each accepted file. Returns a cleanup function. */
export function listenForHandoff(onFile: (i: Incoming) => void): () => void {
  const opener = window.opener as Window | null;
  if (!opener) return () => undefined;
  const listener = (e: MessageEvent) => {
    if (e.source !== opener) return;
    const got = parseImport(e);
    if (got) onFile(got);
  };
  addEventListener('message', listener);
  // The ready message carries nothing, so any opener origin may receive it; the reply is checked above.
  opener.postMessage({ type: READY }, '*');
  return () => removeEventListener('message', listener);
}
