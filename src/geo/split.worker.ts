import { autoSplit, type SplitOptions } from './core';
import type { Area, OsmData } from '../types';

self.onmessage = (e: MessageEvent<{ boundary: Area; osm: OsmData; opt: Omit<SplitOptions, 'onProgress'> }>) => {
  try {
    const { boundary, osm, opt } = e.data;
    const result = autoSplit(boundary, osm, { ...opt, onProgress: (msg) => self.postMessage({ type: 'progress', msg }) });
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', msg: err instanceof Error ? err.message : String(err) });
  }
};
