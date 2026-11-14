// Google My Maps links for card QR codes: clean up what people paste and read many at once.
import { safeUrl } from './safe';

const GOOGLE = /(^|\.)google\.[a-z.]+$/;

/** The shareable form of a pasted Google My Maps link: edit links only work for editors, so they become viewer links. */
export function previewLink(raw: string): string {
  const url = safeUrl(raw);
  if (!url) return '';
  const u = new URL(url);
  const mid = u.searchParams.get('mid');
  if (GOOGLE.test(u.hostname) && u.pathname.includes('/maps/d/') && mid) return `https://www.google.com/maps/d/viewer?mid=${encodeURIComponent(mid)}`;
  return url;
}

export const isGoogleMap = (url: string | undefined) => {
  const v = safeUrl(url);
  if (!v) return false;
  const host = new URL(v).hostname;
  return GOOGLE.test(host) || host === 'maps.app.goo.gl' || host === 'goo.gl';
};

/** "12 https://…" or "12<tab>https://…" per line → territory number and link. */
export function parseLinks(text: string): { number: string; url: string }[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(\S+?)[\s,;:.-]+(https?:\/\/\S+)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({ number: m[1], url: previewLink(m[2]) }))
    .filter((x) => x.url);
}
