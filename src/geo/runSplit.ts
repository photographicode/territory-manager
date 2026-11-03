// Drives the split worker stage by stage, saving a checkpoint after each stage so a split that
// stops (crash, closed tab, out of memory) can carry on from the last finished stage.
import { overall, type SplitOptions, type SplitResult } from './core';
import type { FromWorker, ToWorker } from './split.worker';
import type { Area, OsmData } from '../types';
import type { Report } from '../task';

export interface SplitCheckpoint {
  /** Identifies the boundary, map data and settings the checkpoint belongs to. */
  key: string;
  stages: string[];
  /** Index of the next stage to run. */
  next: number;
  pieces: SplitResult[];
  savedAt: string;
}

/** Short fingerprint of the split inputs, so a checkpoint is only reused for the same split. */
export function splitKey(boundary: Area, osm: OsmData, opt: Omit<SplitOptions, 'onProgress'>) {
  const text = JSON.stringify(boundary);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return [osm.fetchedAt, opt.min, opt.max, opt.count ?? 0, opt.evenBy ?? '', opt.water ?? '', opt.trimStrips ?? '', opt.levels.join(''), (h >>> 0).toString(36)].join('|');
}

interface Run {
  boundary: Area;
  osm: OsmData;
  opt: Omit<SplitOptions, 'onProgress'>;
  resume?: SplitCheckpoint;
  report: Report;
  signal: AbortSignal;
  save: (cp: SplitCheckpoint) => Promise<void>;
}

export async function runSplit({ boundary, osm, opt, resume, report, signal, save }: Run): Promise<SplitResult[]> {
  const key = splitKey(boundary, osm, opt);
  const worker = new Worker(new URL('./split.worker.ts', import.meta.url), { type: 'module' });
  let stageName = 'Getting ready';
  let onMessage: (m: FromWorker) => void = () => {};
  let fail: (e: Error) => void = () => {};
  worker.onmessage = (e: MessageEvent<FromWorker>) => (e.data.type === 'error' ? fail(new Error(`${stageName}: ${e.data.msg}`)) : onMessage(e.data));
  worker.onerror = (e) => {
    e.preventDefault();
    fail(
      new Error(
        `The splitter stopped during "${stageName}"${e.message ? ` (${e.message})` : ''}. The browser may have run out of memory. ` +
          'Finished stages are saved: press Split again to carry on from there.',
      ),
    );
  };
  worker.onmessageerror = () => fail(new Error(`${stageName}: a result could not be passed back from the splitter.`));
  const stopped = new Promise<never>((_, reject) => {
    fail = reject;
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
  });
  const ask = <T extends FromWorker['type']>(msg: ToWorker, want: T, progress?: (m: Extract<FromWorker, { type: 'progress' }>) => void) =>
    Promise.race([
      stopped,
      new Promise<Extract<FromWorker, { type: T }>>((resolve) => {
        onMessage = (m) => (m.type === want ? resolve(m as Extract<FromWorker, { type: T }>) : m.type === 'progress' && progress?.(m));
        worker.postMessage(msg);
      }),
    ]);

  try {
    report('Sending the map data to the splitter', 0, 'Getting ready');
    const { stages } = await ask({ type: 'init', boundary, osm, opt }, 'ready', (m) => report(m.detail, 0));
    const names = stages.map((s) => s.name);
    const canResume = resume && resume.key === key && resume.stages.join() === names.join() && resume.next > 0 && resume.next < stages.length;
    let pieces = canResume ? resume.pieces : [];
    for (let i = canResume ? resume.next : 0; i < stages.length; i++) {
      stageName = names[i];
      const start = overall(stages, i, 0);
      report(i ? `${pieces.length.toLocaleString()} pieces so far` : 'Starting', start.fraction, start.stage);
      const done = await ask({ type: 'stage', index: i, pieces }, 'stage-done', (m) => {
        const o = overall(stages, i, m.fraction);
        report(m.detail, o.fraction, o.stage);
      });
      pieces = done.pieces;
      if (i + 1 < stages.length) await save({ key, stages: names, next: i + 1, pieces, savedAt: new Date().toISOString() });
    }
    return pieces;
  } finally {
    worker.terminate();
  }
}
