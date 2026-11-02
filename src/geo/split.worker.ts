// Runs the split one stage at a time, so the page can save progress between stages.
import { fromResults, splitStages, toResults, type SplitOptions, type SplitResult, type SplitStage } from './core';
import type { Area, OsmData } from '../types';

export type ToWorker =
  | { type: 'init'; boundary: Area; osm: OsmData; opt: Omit<SplitOptions, 'onProgress'> }
  | { type: 'stage'; index: number; pieces: SplitResult[] };
export type FromWorker =
  | { type: 'ready'; stages: { name: string; weight: number }[] }
  | { type: 'progress'; detail: string; fraction: number }
  | { type: 'stage-done'; index: number; pieces: SplitResult[] }
  | { type: 'error'; msg: string };

const post = (m: FromWorker) => self.postMessage(m);
let stages: SplitStage[] = [];

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      post({ type: 'progress', detail: 'Preparing roads and buildings', fraction: 0 });
      stages = splitStages(m.boundary, m.osm, m.opt);
      post({ type: 'ready', stages: stages.map(({ name, weight }) => ({ name, weight })) });
    } else {
      let last = 0;
      const out = stages[m.index].run(fromResults(m.pieces), (detail, fraction) => {
        if (Date.now() - last < 200) return;
        last = Date.now();
        post({ type: 'progress', detail, fraction });
      });
      post({ type: 'progress', detail: 'Saving this stage', fraction: 1 });
      post({ type: 'stage-done', index: m.index, pieces: toResults(out) });
    }
  } catch (err) {
    post({ type: 'error', msg: err instanceof Error ? err.message : String(err) });
  }
};
