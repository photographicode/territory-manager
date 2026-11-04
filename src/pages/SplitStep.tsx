import { useEffect, useState } from 'react';
import type { PageProps } from '../App';
import { fetchOsm } from '../geo/osm';
import { areaKm2, BuildingIndex, countBuildings, formatArea, sweepOrder } from '../geo/core';
import { runSplit, splitKey } from '../geo/runSplit';
import { clearCheckpoint, loadCheckpoint, loadOsm, saveCheckpoint, saveOsm } from '../store';
import { bboxOf } from '../map';
import { MAX_TERRITORIES, uid, type OsmData, type Settings } from '../types';
import { useTask } from '../task';
import KmlExport from './KmlExport';

const EVEN_BY: [Settings['evenBy'], string, string][] = [
  ['both', 'Both (recommended)', 'A balance of ground and houses: built-up territories are smaller and open-country ones larger, without either extreme.'],
  ['area', 'Area', 'Every territory covers about the same ground. Built-up areas will have many more houses than open country.'],
  ['houses', 'Houses', 'Every territory has about the same number of houses. Open country makes for very large territories.'],
];

const WATER: [Settings['water'], string, string][] = [
  ['exclude', 'Leave out', 'Lakes, reservoirs and ponds over 10 ha are cut out of the territories, and their shores become borders.'],
  ['include', 'Include', 'Lakes and big ponds stay inside the territories, so the map has no gaps. Water is not counted as ground when evening out areas.'],
];

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

  const [osmChecked, setOsmChecked] = useState(false);
  useEffect(() => {
    loadOsm().then((d) => {
      if (d) setOsm(d);
      setOsmChecked(true);
    });
  }, []);

  // Houses inside the boundary, counted after the page has drawn (it takes a moment on big areas).
  const [total, setTotal] = useState<number | null>(null);
  const boundaryGeo = project.boundary?.geometry;
  useEffect(() => {
    setTotal(null);
    if (!osm || !boundaryGeo) return;
    const t = setTimeout(() => setTotal(countBuildings(new BuildingIndex(osm.buildings), boundaryGeo)), 50);
    return () => clearTimeout(t);
  }, [osm, boundaryGeo]);
  const suggested = total ? Math.min(MAX_TERRITORIES, Math.max(1, Math.round(total / 200))) : 0;

  // Every split needs map data, so fetch it as soon as there is a boundary it does not cover yet.
  useEffect(() => {
    if (!osmChecked || !boundaryGeo || busy) return;
    const [w, so, e, n] = bboxOf(boundaryGeo);
    if (!osm || osm.bbox[0] > w || osm.bbox[1] > so || osm.bbox[2] < e || osm.bbox[3] < n) void download();
  }, [osmChecked, boundaryGeo]);

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
  const landKm2 = areaKm2(boundary);
  const covers = !!osm && osm.bbox[0] <= bbox[0] && osm.bbox[1] <= bbox[1] && osm.bbox[2] >= bbox[2] && osm.bbox[3] >= bbox[3];
  // Houses per territory follow from the count: aim for the average, allow about 30% either way.
  const count = s.territoryCount || suggested;
  const estimate = total ? Math.max(1, Math.round(total / ((s.minBuildings + s.maxBuildings) / 2))) : 0;
  const tooMany = s.sizeMode === 'count' ? count > MAX_TERRITORIES : estimate > MAX_TERRITORIES;
  const sizing = () => {
    if (s.sizeMode === 'houses' || !total) return { min: s.minBuildings, max: s.maxBuildings, levels: s.levels, water: s.water };
    const avg = total / count;
    return { min: Math.max(1, Math.round(avg * 0.7)), max: Math.max(2, Math.round(avg * 1.3)), levels: s.levels, count, evenBy: s.evenBy, water: s.water };
  };

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
    const opt = sizing();
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
        // Review flags sizes against the range this split aimed for (worked out from the count, in count mode).
        settings: { ...p.settings, minBuildings: opt.min, maxBuildings: opt.max },
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
          <p>{busy ? 'Downloading map data for this boundary…' : 'No map data downloaded for this boundary yet.'}</p>
        )}
        <button className="btn" disabled={busy} onClick={download}>
          {covers ? 'Download again' : 'Download map data'}
        </button>
      </section>

      <section className="card-box">
        <h3>2. Territory size</h3>
        <div className="seg" role="radiogroup" aria-label="How to size territories">
          <button role="radio" aria-checked={s.sizeMode === 'count'} className={s.sizeMode === 'count' ? 'on' : ''} onClick={() => set({ sizeMode: 'count' })}>
            Number of territories
          </button>
          <button role="radio" aria-checked={s.sizeMode === 'houses'} className={s.sizeMode === 'houses' ? 'on' : ''} onClick={() => set({ sizeMode: 'houses' })}>
            Houses per territory
          </button>
        </div>
        {s.sizeMode === 'count' ? (
          <>
            <label className="field">
              <span>How many territories (up to {MAX_TERRITORIES})</span>
              <input
                type="number"
                min={1}
                max={MAX_TERRITORIES}
                value={count || ''}
                placeholder={suggested ? String(suggested) : ''}
                onChange={(e) => set({ territoryCount: Math.max(0, Math.round(+e.target.value)) })}
              />
            </label>
            <div className="field">
              <span>Make them equal in</span>
              <div className="seg" role="radiogroup" aria-label="Make territories equal in">
                {EVEN_BY.map(([id, label]) => (
                  <button key={id} role="radio" aria-checked={s.evenBy === id} className={s.evenBy === id ? 'on' : ''} onClick={() => set({ evenBy: id, evenByPicked: true })}>
                    {label}
                  </button>
                ))}
              </div>
              <span className="muted tiny">{EVEN_BY.find(([id]) => id === s.evenBy)?.[2]}</span>
            </div>
            {s.evenBy === 'area' && count > 0 && count <= MAX_TERRITORIES && (
              <p className="muted">
                {formatArea(landKm2)} ÷ {count} = about <b>{formatArea(landKm2 / count)}</b> per territory
                {total ? `, with about ${Math.round(total / count).toLocaleString('en-IN')} houses each on average` : ''}.
              </p>
            )}
            {total !== null && count > 0 && count <= MAX_TERRITORIES && s.evenBy === 'both' && (
              <p className="muted">
                On average about <b>{Math.round(total / count).toLocaleString('en-IN')} houses</b> and <b>{formatArea(landKm2 / count)}</b> per
                territory: fewer houses where it is open country, less ground where it is built up.
              </p>
            )}
            {total !== null && count > 0 && count <= MAX_TERRITORIES && s.evenBy === 'houses' && (
              <p className="muted">
                {total.toLocaleString()} houses ÷ {count} = about <b>{Math.round(total / count).toLocaleString()} houses</b> per territory.
              </p>
            )}
          </>
        ) : (
          <>
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
            {total !== null && <p className="muted">That makes about <b>{estimate}</b> territories from {total.toLocaleString()} houses.</p>}
          </>
        )}
        {tooMany && (
          <p className="error">
            {s.sizeMode === 'count' ? `${count} territories` : `About ${estimate} territories`} is too many to manage; the most is {MAX_TERRITORIES}.{' '}
            {s.sizeMode === 'count' ? 'Choose a smaller number.' : 'Allow more houses per territory, or choose a number of territories instead.'}
          </p>
        )}
        {total === null && covers && <p className="muted">Counting houses…</p>}
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
        <div className="field">
          <span>Lakes and big ponds</span>
          <div className="seg" role="radiogroup" aria-label="Lakes and big ponds">
            {WATER.map(([id, label]) => (
              <button key={id} role="radio" aria-checked={s.water === id} className={s.water === id ? 'on' : ''} onClick={() => set({ water: id })}>
                {label}
              </button>
            ))}
          </div>
          <span className="muted tiny">{WATER.find(([id]) => id === s.water)?.[2]}</span>
        </div>
      </section>

      <button className="btn primary big" disabled={busy || !covers || tooMany || total === null} onClick={split}>
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
