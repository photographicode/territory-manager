import { useCallback, useEffect, useRef, useState } from 'react';
import { del, get, set } from 'idb-keyval';
import { defaultSettings, newProject, type OsmData, type Project } from './types';
import type { SplitCheckpoint } from './geo/runSplit';

const KEY = 'territory-manager:project';
const OSM_KEY = 'territory-manager:osm';
const UNDO_LIMIT = 40;

const CHECKPOINT_KEY = 'territory-manager:split-checkpoint';

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

  useEffect(() => {
    get<Project>(KEY).then((p) => {
      if (p && /\/\/(localhost|127\.)/.test(p.settings?.viewerUrl ?? '')) p.settings.viewerUrl = ''; // from early test builds
      if (p?.settings?.evenBy === 'area' && !p.settings.evenByPicked) p.settings.evenBy = 'both'; // Area was briefly the default
      setProject(p ? { ...newProject(), ...p, settings: { ...defaultSettings(), ...p.settings } } : newProject());
    });
  }, []);

  useEffect(() => {
    if (!project) return;
    const t = setTimeout(
      () =>
        set(KEY, project).catch((e) => {
          throw new Error(`Saving on this device failed, so recent changes may be lost. Download a backup now. (${e instanceof Error ? e.message : e})`);
        }),
      300,
    );
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

  const replace = useCallback((p: Project) => {
    undo.current = [];
    setUndoCount(0);
    setProject(p);
  }, []);

  return { project, update, undoLast, undoCount, replace };
}

export type ProjectApi = ReturnType<typeof useProject> & { project: Project };
