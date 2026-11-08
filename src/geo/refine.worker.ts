// Snaps territory outlines to the roads off the page's thread, so the page stays responsive.
import { refineAreas } from './core';
import type { Area, OsmData } from '../types';

export type RefineIn = { areas: Area[]; osm: OsmData };
export type RefineOut = { type: 'progress'; detail: string; fraction: number } | { type: 'done'; areas: Area[] } | { type: 'error'; msg: string };

const post = (m: RefineOut) => self.postMessage(m);
self.onmessage = (e: MessageEvent<RefineIn>) => {
  let last = 0;
  try {
    const areas = refineAreas(e.data.areas, e.data.osm, (detail, fraction) => {
      if (Date.now() - last < 200) return;
      last = Date.now();
      post({ type: 'progress', detail, fraction });
    });
    post({ type: 'done', areas });
  } catch (err) {
    post({ type: 'error', msg: err instanceof Error ? err.message : String(err) });
  }
};
