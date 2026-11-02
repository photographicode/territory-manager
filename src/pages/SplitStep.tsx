import { useEffect, useState } from 'react';
import type { PageProps } from '../App';
import { fetchOsm } from '../geo/osm';
import { sweepOrder } from '../geo/core';
import { runSplit, splitKey } from '../geo/runSplit';
import { clearCheckpoint, loadCheckpoint, loadOsm, saveCheckpoint, saveOsm } from '../store';
import { bboxOf } from '../map';
import { uid, type OsmData, type Settings } from '../types';
import { useTask } from '../task';
import KmlExport from './KmlExport';

const LEVELS = [
  ['Major borders', 'Railway, rivers, canals, national/state highways and main roads'],
  ['Secondary roads', 'Secondary and tertiary roads'],
  ['Local roads', 'Residential and panchayat roads, streams and drains'],
  ['Lanes and paths', 'Service lanes, tracks, footpaths and steps'],
];

export default function SplitStep({ project, update, go }: PageProps) {
  const s = project.settings;
  const [osm, setOsm] = useState<OsmData | null>(null);
  const task = useTask();
  const busy = task.busy;

  useEffect(() => {
    loadOsm().then((d) => d && setOsm(d));
  }, []);

  const set = (patch: Partial<Settings>) => update((p) => ({ ...p, settings: { ...p.settings, ...patch } }));

  if (!project.boundary)
    return (
      <div className="page">
        <p>
          First import the congregation boundary.{' '}
          <button className="btn" onClick={() => go('boundary')}>
            Go to Boundary
          </button>
        </p>
      </div>
    );
  const boundary = project.boundary.geometry;
  const bbox = bboxOf(boundary);
  const covers = !!osm && osm.bbox[0] <= bbox[0] && osm.bbox[1] <= bbox[1] && osm.bbox[2] >= bbox[2] && osm.bbox[3] >= bbox[3];

  async function download() {
    const pad = 0.002;
    const data = await task.run(
      'Downloading map data',
      async (report, signal) => {
        const d = await fetchOsm([bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad], report, signal);
        report('Saving map data on this device…', 0.99);
        await saveOsm(d);
        return d;
      },
      { cancellable: true },
    );
    if (data) setOsm(data);
  }

  async function split() {
    if (!osm) return;
    const opt = { min: s.minBuildings, max: s.maxBuildings, levels: s.levels };
    const saved = await loadCheckpoint();
    let resume = saved && saved.key === splitKey(boundary, osm, opt) ? saved : undefined;
    if (resume) {
      const when = new Date(resume.savedAt).toLocaleString();
      resume = confirm(
        `A split of this boundary stopped before it finished (saved ${when}, after stage ${resume.next} of ${resume.stages.length}: ` +
          `${resume.stages[resume.next - 1]}).

OK: carry on from stage ${resume.next + 1}
Cancel: start again from the beginning`,
      )
        ? resume
        : undefined;
    }
    if (!resume && project.territories.length && !confirm(`Replace the ${project.territories.length} current territories with a new split?`)) return;
    const result = await task.run(
      'Splitting into territories',
      (report, signal) => runSplit({ boundary, osm, opt, resume, report, signal, save: saveCheckpoint }),
      { cancellable: true },
    );
    if (!result) return;
    await clearCheckpoint();
    const ordered = sweepOrder(result);
    update(
      (p) => ({
        ...p,
        finalized: false,
        territories: ordered.map((r, i) => ({
          id: uid(),
          number: String(i + 1),
          locality: '',
          geometry: r.geometry,
          buildings: r.buildings,
          ...(r.straightCut ? { needsCheck: true } : {}),
        })),
      }),
      true,
    );
    go('review');
  }

  return (
    <div className="page narrow">
      <h2>Split into territories</h2>
      <section className="card-box">
        <h3>1. Map data</h3>
        <p className="muted">
          Roads, railways, water and building positions come from OpenStreetMap. Houses are counted from mapped buildings, so the count can be
          lower than reality where buildings are not mapped yet.
        </p>
        {osm && covers ? (
          <p>
            <b>{osm.lines.length.toLocaleString()}</b> roads/rivers/railways, <b>{osm.buildings.length.toLocaleString()}</b> buildings,{' '}
            <b>{osm.water.length}</b> water areas · downloaded {new Date(osm.fetchedAt).toLocaleDateString()}
          </p>
        ) : (
          <p>No map data downloaded for this boundary yet.</p>
        )}
        <button className="btn" disabled={busy} onClick={download}>
          {covers ? 'Download again' : 'Download map data'}
        </button>
      </section>

      <section className="card-box">
        <h3>2. Territory size</h3>
        <div className="row">
          <label className="field">
            <span>Fewest houses</span>
            <input type="number" min={1} value={s.minBuildings} onChange={(e) => set({ minBuildings: +e.target.value })} />
          </label>
          <label className="field">
            <span>Most houses</span>
            <input type="number" min={1} value={s.maxBuildings} onChange={(e) => set({ maxBuildings: +e.target.value })} />
          </label>
        </div>
        <p className="muted">Pieces bigger than the maximum are cut along smaller roads; pieces smaller than the minimum are joined to a neighbour.</p>
      </section>

      <section className="card-box">
        <h3>3. Borders to use</h3>
        {LEVELS.map(([name, desc], i) => (
          <label key={name} className="check">
            <input
              type="checkbox"
              checked={s.levels[i]}
              onChange={(e) => {
                const levels = [...s.levels] as Settings['levels'];
                levels[i] = e.target.checked;
                set({ levels });
              }}
            />
            <span>
              <b>{name}</b> <span className="muted">— {desc}</span>
            </span>
          </label>
        ))}
      </section>

      <button className="btn primary big" disabled={busy || !covers} onClick={split}>
        Split into territories
      </button>
      {project.territories.length > 0 && (
        <section className="card-box">
          <h3>Save a copy of the current territories</h3>
          <p className="muted">Open these in Google Earth, My Maps or any map app to check the split, or keep them in case something goes wrong.</p>
          <KmlExport territories={project.territories} congregation={s.congregation} />
        </section>
      )}
    </div>
  );
}
