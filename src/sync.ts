// Sends the finished territories to the territory manager (territory.congregationassistant.com), so nothing has to be
// exported and imported by hand: number, locality name, the QR map link, the outline and the card image.
// The manager window is opened from the click (so pop-up blockers allow it). It keeps saying "ready" until it has the
// territories; they are sent only to the manager's own origin, and only to that window.
import type { Area, Settings, Territory } from './types';
import { qrLink, renderCard } from './card/render';

export const SYNC_READY = 'tm-manager-ready';
export const SYNC = 'tm-sync';
const SITE = 'https://territory.congregationassistant.com';
// Local development: the territory manager runs on the Congregation Assistant dev server.
const DEV = 'http://localhost:5179';
const IMAGE_MAX = 1600, THUMB_MAX = 480, IMAGE_Q = 0.82, THUMB_Q = 0.7, WAIT_MS = 10 * 60_000;

export interface SyncTerritory {
  number: string;
  name: string;
  mapUrl: string;
  boundary: Area;
  /** Card images; left out when only the outlines go out for naming. */
  image?: string;
  thumb?: string;
}

const local = () => /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
export const managerOrigin = () => (local() ? DEV : SITE);
/** Opens the manager at its import page. Call straight from a click. */
export const openManager = () => window.open(`${managerOrigin()}/?territory&from-generator`, 'tm-manager');

/** A canvas as a WebP data URL (JPEG where WebP is missing), no wider than `max`. */
function shrink(card: HTMLCanvasElement, max: number, quality: number) {
  const scale = Math.min(1, max / card.width);
  const c = document.createElement('canvas');
  c.width = Math.round(card.width * scale);
  c.height = Math.round(card.height * scale);
  c.getContext('2d')!.drawImage(card, 0, 0, c.width, c.height);
  const webp = c.toDataURL('image/webp', quality);
  return webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/jpeg', quality);
}

/** Draws every card and gathers what the manager needs. */
export async function collect(ts: Territory[], s: Settings, report: (text: string, done: number) => void, signal: AbortSignal): Promise<SyncTerritory[]> {
  const out: SyncTerritory[] = [];
  for (const [i, t] of ts.entries()) {
    signal.throwIfAborted();
    report(`Drawing card ${i + 1} of ${ts.length}: territory ${t.number}`, i / ts.length);
    const card = await renderCard(t, s);
    out.push({ number: t.number, name: t.locality || `Territory ${t.number}`, mapUrl: qrLink(t, s), boundary: t.geometry, image: shrink(card, IMAGE_MAX, IMAGE_Q), thumb: shrink(card, THUMB_MAX, THUMB_Q) });
  }
  return out;
}

/** Numbers, names, map links and outlines only (no card images): for the congregation to name the territories. */
export const outlines = (ts: Territory[], s: Settings): SyncTerritory[] =>
  ts.map((t) => ({ number: t.number, name: t.locality || `Territory ${t.number}`, mapUrl: qrLink(t, s), boundary: t.geometry }));

/** Waits for the manager window to say it is ready, then sends the territories to it. */
export function sendWhenReady(win: Window, congregation: string, territories: SyncTerritory[]): Promise<void> {
  const origin = managerOrigin();
  return new Promise((resolve, reject) => {
    const listener = (e: MessageEvent) => {
      if (e.source !== win || e.origin !== origin || (e.data as { type?: unknown } | null)?.type !== SYNC_READY) return;
      stop();
      win.postMessage({ type: SYNC, congregation, territories }, origin);
      win.focus();
      resolve();
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error('The territory manager did not open in time. Sign in there, then try again.'));
    }, WAIT_MS);
    const closed = setInterval(() => {
      if (!win.closed) return;
      stop();
      reject(new Error('The territory manager window was closed before the territories were sent.'));
    }, 1000);
    function stop() {
      clearTimeout(timer);
      clearInterval(closed);
      removeEventListener('message', listener);
    }
    addEventListener('message', listener);
  });
}
