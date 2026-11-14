import { useCallback, useEffect, useRef, useState } from 'react';
import { del, get, set } from 'idb-keyval';
import { defaultSettings, newProject, type OsmData, type Project } from './types';
import type { SplitCheckpoint } from './geo/runSplit';

const KEY = 'territory-manager:project';
const OSM_KEY = 'territory-manager:osm';
// Enough to undo every change of a long review session; snapshots share unchanged territories, so they are small.
const UNDO_LIMIT = 2000;

const CHECKPOINT_KEY = 'territory-manager:split-checkpoint';
// Which tab saved last, so an older tab of the app reloads instead of saving its stale copy over newer work.
const REV_KEY = 'territory-manager:rev';
const TAB = Math.random().toString(36).slice(2);
type Rev = { tab: string; at: number };

export const loadOsm = () => get<OsmData>(OSM_KEY);
export const saveOsm = (data: OsmData) => set(OSM_KEY, data);

/** Progress of an unfinished split, saved after every stage. */
export const loadCheckpoint = () => get<SplitCheckpoint>(CHECKPOINT_KEY);
export const saveCheckpoint = (cp: SplitCheckpoint) => set(CHECKPOINT_KEY, cp);
export const clearCheckpoint = () => del(CHECKPOINT_KEY);

/** Project state persisted to IndexedDB, with an undo stack for geometry edits. */
export function useProject() {
  const [project, setProject] = useState<Project | null>(null);
  const undo = useRef<Project[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  // The state just read from storage: it is shown, never written back (writing it would undo another tab's work).
  const loaded = useRef<Project | null>(null);
  const seen = useRef(0);

  const load = useCallback(async () => {
    const [p, rev] = await Promise.all([get<Project>(KEY), get<Rev>(REV_KEY)]);
    seen.current = rev?.at ?? 0;
    if (p && /\/\/(localhost|127\.)/.test(p.settings?.viewerUrl ?? '')) p.settings.viewerUrl = ''; // from early test builds
    if (p?.settings?.evenBy === 'area' && !p.settings.evenByPicked) p.settings.evenBy = 'both'; // Area was briefly the default
    const next = p ? { ...newProject(), ...p, settings: { ...defaultSettings(), ...p.settings } } : newProject();
    loaded.current = next;
    setProject(next);
  }, []);

  useEffect(() => {
    load();
    // Another tab saved: take its version. Checked when it tells us, and whenever this tab comes back to the front.
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel('territory-manager') : null;
    const refresh = async () => {
      const rev = await get<Rev>(REV_KEY);
      if (rev && rev.tab !== TAB && rev.at > seen.current) {
        undo.current = [];
        setUndoCount(0);
        await load();
      }
    };
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    if (channel) channel.onmessage = refresh;
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);
    return () => {
      channel?.close();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
    };
  }, [load]);

  useEffect(() => {
    if (!project || project === loaded.current) return;
    const t = setTimeout(async () => {
      try {
        const rev = { tab: TAB, at: Date.now() };
        await set(KEY, project);
        await set(REV_KEY, rev);
        seen.current = rev.at;
        if ('BroadcastChannel' in window) {
          const bc = new BroadcastChannel('territory-manager');
          bc.postMessage('saved');
          bc.close();
        }
      } catch (e) {
        throw new Error(`Saving on this device failed, so recent changes may be lost. Download a backup now. (${e instanceof Error ? e.message : e})`);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [project]);

  /** Apply a change. `undoable` changes can be reverted with undoLast. */
  const update = useCallback((fn: (p: Project) => Project, undoable = false) => {
    setProject((p) => {
      if (!p) return p;
      if (undoable) {
        undo.current = [...undo.current.slice(-UNDO_LIMIT + 1), p];
        setUndoCount(undo.current.length);
      }
      return fn(p);
    });
  }, []);

  const undoLast = useCallback(() => {
    const prev = undo.current.pop();
    setUndoCount(undo.current.length);
    if (prev) setProject(prev);
  }, []);

  /** Go back to how things were before the first change that can still be undone. */
  const undoAll = useCallback(() => {
    const first = undo.current[0];
    undo.current = [];
    setUndoCount(0);
    if (first) setProject(first);
  }, []);

  const replace = useCallback((p: Project) => {
    undo.current = [];
    setUndoCount(0);
    setProject(p);
  }, []);

  return { project, update, undoLast, undoAll, undoCount, replace };
}

export type ProjectApi = ReturnType<typeof useProject> & { project: Project };
