import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import type { PageProps } from '../App';
import { areasTouch, BuildingIndex, countBuildings, fillPondsInAreas, mergeAreas, splitByLine, suggestLocality, sweepOrder } from '../geo/core';
import { loadOsm, saveOsm } from '../store';
import { fetchOsm } from '../geo/osm';
import type { RefineOut } from '../geo/refine.worker';
import { bboxOf, colorFor, createMap, toLatLngs } from '../map';
import { uid, type Area, type OsmData, type Territory } from '../types';
import { useTask } from '../task';
import KmlExport from './KmlExport';
import { byNumber } from './TerritoriesPage';

/** Number territories 1, 2, 3 … from the top of the map to the bottom, so neighbours get nearby numbers. */
const numbered = (ts: Territory[]) => sweepOrder(ts).map((t, i) => ({ ...t, number: String(i + 1) }));

type Mode = 'select' | 'cut' | 'edit';

export default function ReviewStep({ project, update, undoLast, undoAll, undoCount, go }: PageProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map>();
  const group = useRef<L.LayerGroup>();
  const layers = useRef(new Map<string, L.Polygon>());
  const fitted = useRef(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>('select');
  const [osm, setOsm] = useState<OsmData | null>(null);
  const [filter, setFilter] = useState('');
  const [lang, setLang] = useState('en');
  // Problems are shown in the panel, not in blocking pop-ups.
  const [notice, setNotice] = useState('');
  const { territories, settings } = project;
  const task = useTask();
  const index = useMemo(() => (osm ? new BuildingIndex(osm.buildings) : null), [osm]);
  const recount = (a: Area) => (index ? countBuildings(index, a) : 0);

  // Keep latest values for Leaflet event handlers.
  const live = useRef({ selected, mode, territories });
  live.current = { selected, mode, territories };

  useEffect(() => {
    loadOsm().then((d) => d && setOsm(d));
    const m = createMap(el.current!);
    map.current = m;
    fitted.current = false;
    group.current = L.layerGroup().addTo(m);
    m.on('pm:create', (e: { layer: L.Layer }) => {
      const line = (e.layer as L.Polyline).getLatLngs() as L.LatLng[];
      m.removeLayer(e.layer);
      cutWith(line.map((p) => [p.lng, p.lat]));
    });
    return () => void m.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Draw territories.
  useEffect(() => {
    const g = group.current!;
    g.clearLayers();
    layers.current.clear();
    territories.forEach((t, i) => {
      const poly = L.polygon(toLatLngs(t.geometry) as L.LatLngExpression[][], { color: colorFor(i), weight: 2, fillOpacity: 0.18 });
      // A text node, so a number from an imported file is never read as HTML.
      poly.bindTooltip(document.createTextNode(t.number || '?') as unknown as HTMLElement, { permanent: true, direction: 'center', className: 'tlabel' });
      poly.on('click', (e: L.LeafletMouseEvent) => {
        if (live.current.mode !== 'select') return;
        const multi = e.originalEvent.shiftKey || e.originalEvent.ctrlKey || e.originalEvent.metaKey;
        setSelected((s) => (multi ? (s.includes(t.id) ? s.filter((x) => x !== t.id) : [...s, t.id]) : [t.id]));
      });
      poly.addTo(g);
      layers.current.set(t.id, poly);
    });
    if (!fitted.current && territories.length) {
      map.current!.fitBounds(L.featureGroup([...layers.current.values()]).getBounds(), { padding: [20, 20] });
      fitted.current = true;
    }
    setSelected((s) => s.filter((id) => territories.some((t) => t.id === id)));
  }, [territories]);

  // Selection style.
  useEffect(() => {
    territories.forEach((t, i) => {
      const on = selected.includes(t.id);
      layers.current.get(t.id)?.setStyle({ weight: on ? 4 : 2, fillOpacity: on ? 0.32 : 0.18, color: on ? '#111' : colorFor(i) });
      if (on) layers.current.get(t.id)?.bringToFront();
    });
    if (selected.length === 1) document.getElementById(`row-${selected[0]}`)?.scrollIntoView({ block: 'nearest' });
  }, [selected, territories]);

  const sel = territories.filter((t) => selected.includes(t.id));
  const patch = (id: string, p: Partial<Territory>) =>
    update((pr) => ({ ...pr, territories: pr.territories.map((t) => (t.id === id ? { ...t, ...p } : t)) }));

  function merge() {
    if (sel.length < 2) return;
    if (sel.some((a, i) => i > 0 && !sel.slice(0, i).some((b) => areasTouch(a.geometry, b.geometry))))
      if (!confirm('Some selected territories do not touch each other. Merge anyway?')) return;
    const first = sel[0];
    const geometry = mergeAreas(sel.map((t) => t.geometry));
    const merged: Territory = {
      ...first,
      geometry,
      buildings: index ? recount(geometry) : sel.reduce((n, t) => n + t.buildings, 0),
      // Both names when they differ ("Kottayam & Nagampadam"), so neither place is lost.
      locality: [...new Set(sel.map((t) => t.locality.trim()).filter(Boolean))].join(' & '),
      needsCheck: sel.some((t) => t.needsCheck) || undefined,
    };
    // The merged territory takes one place in the numbering; the rest close up, top to bottom.
    update(
      (p) => ({ ...p, territories: numbered(p.territories.filter((t) => !selected.includes(t.id) || t.id === first.id).map((t) => (t.id === first.id ? merged : t))) }),
      true,
    );
    setSelected([first.id]);
  }

  function cutWith(line: [number, number][]) {
    const { selected: s, territories: ts } = live.current;
    const targets = s.length ? ts.filter((t) => s.includes(t.id)) : ts;
    const result: Territory[] = [];
    let changed = 0;
    for (const t of ts) {
      if (!targets.includes(t)) {
        result.push(t);
        continue;
      }
      const pieces = splitByLine(t.geometry, line);
      if (pieces.length < 2) {
        result.push(t);
        continue;
      }
      changed++;
      pieces
        .sort((a, b) => recount(b) - recount(a))
        .forEach((g, i) => result.push({ ...t, id: i ? uid() : t.id, geometry: g, buildings: recount(g) }));
    }
    setMode('select');
    map.current!.pm.disableDraw();
    if (!changed) return setNotice('The cut line must cross the territory completely, from one edge to the other. Draw it again a little longer.');
    setNotice('');
    update((p) => ({ ...p, territories: numbered(result) }), true);
  }

  function startCut() {
    setMode('cut');
    map.current!.pm.enableDraw('Line', { templineStyle: { color: '#111' }, pathOptions: { color: '#111', dashArray: '6 6' } } as never);
  }

  function startEdit() {
    if (sel.length !== 1) return;
    setMode('edit');
    layers.current.get(sel[0].id)!.pm.enable({ allowSelfIntersection: false, snappable: true });
  }

  function finishEdit(save: boolean) {
    const t = sel[0];
    const layer = layers.current.get(t.id)!;
    layer.pm.disable();
    setMode('select');
    if (!save) return update((p) => ({ ...p, territories: [...p.territories] }));
    const geometry = (layer.toGeoJSON() as GeoJSON.Feature<Area>).geometry;
    update((p) => ({ ...p, territories: p.territories.map((x) => (x.id === t.id ? { ...x, geometry, buildings: recount(geometry), needsCheck: false } : x)) }), true);
  }

  function remove() {
    if (!sel.length || !confirm(`Delete ${sel.length} territor${sel.length > 1 ? 'ies' : 'y'}? The area will not be covered by any card.`)) return;
    update((p) => ({ ...p, territories: numbered(p.territories.filter((t) => !selected.includes(t.id))) }), true);
  }

  /** Move every outline onto the nearest roads (for territories drawn by hand or imported from KML). */
  async function snapToRoads() {
    const areas = territories.map((t) => t.geometry);
    const boxes = areas.map(bboxOf);
    const box: [number, number, number, number] = [
      Math.min(...boxes.map((b) => b[0])) - 0.002,
      Math.min(...boxes.map((b) => b[1])) - 0.002,
      Math.max(...boxes.map((b) => b[2])) + 0.002,
      Math.max(...boxes.map((b) => b[3])) + 0.002,
    ];
    const done = await task.run(
      'Snapping borders to the roads',
      async (report, signal) => {
        let data = osm;
        if (!data || data.bbox[0] > box[0] || data.bbox[1] > box[1] || data.bbox[2] < box[2] || data.bbox[3] < box[3]) {
          data = await fetchOsm(box, (d, f) => report(`Downloading roads: ${d}`, (f ?? 0) * 0.4), signal);
          await saveOsm(data);
          setOsm(data);
        }
        const roads = data;
        const out = await new Promise<Area[]>((ok, bad) => {
          const w = new Worker(new URL('../geo/refine.worker.ts', import.meta.url), { type: 'module' });
          signal.addEventListener('abort', () => (w.terminate(), bad(new DOMException('Cancelled', 'AbortError'))), { once: true });
          w.onmessage = (e: MessageEvent<RefineOut>) => {
            const m = e.data;
            if (m.type === 'progress') report(m.detail, 0.4 + 0.6 * m.fraction);
            else (w.terminate(), m.type === 'done' ? ok(m.areas) : bad(new Error(m.msg)));
          };
          w.onerror = (e) => (w.terminate(), bad(new Error(e.message || 'The road snapping stopped')));
          w.postMessage({ areas, osm: roads });
        });
        const index = new BuildingIndex(roads.buildings);
        return out.map((g) => ({ g, n: countBuildings(index, g) }));
      },
      { cancellable: true },
    );
    if (done)
      update((p) => ({ ...p, territories: p.territories.map((t, i) => (done[i] ? { ...t, geometry: done[i].g, buildings: done[i].n } : t)) }), true);
  }

  function renumber() {
    if (!confirm('Renumber all territories from top to bottom (1, 2, 3 …)? Numbers you changed by hand are replaced.')) return;
    update((p) => ({ ...p, territories: numbered(p.territories) }), true);
  }

  /** Give a territory a new number; the territory that had that number takes the old one. */
  function setNumber(id: string, value: string) {
    const number = value.trim();
    const t = territories.find((x) => x.id === id);
    if (!t || !number || number === t.number) return;
    update((p) => ({ ...p, territories: p.territories.map((x) => (x.id === id ? { ...x, number } : x.number === number ? { ...x, number: t.number } : x)) }), true);
  }

  function suggestNames(onlyEmpty: boolean) {
    if (!osm?.places?.length) return setNotice('No place names in the downloaded map data. Download the map data again on the Split step, then come back.');
    setNotice('');
    update(
      (p) => ({
        ...p,
        territories: p.territories.map((t) => (onlyEmpty && t.locality ? t : { ...t, locality: suggestLocality(t.geometry, osm.places, lang) || t.locality })),
      }),
      true,
    );
  }

  const zoomTo = (id: string) => {
    setSelected([id]);
    const l = layers.current.get(id);
    if (l) map.current!.fitBounds(l.getBounds(), { padding: [60, 60], maxZoom: 17 });
  };

  const q = filter.trim().toLowerCase();
  const shown = territories.filter((t) => !q || t.number.toLowerCase() === q || t.locality.toLowerCase().includes(q)).sort(byNumber);
  const unnamed = territories.filter((t) => !t.locality.trim()).length;
  const toCheck = territories.filter((t) => t.needsCheck).length;
  const dupNumbers = new Set(territories.map((t) => t.number).filter((n, i, a) => a.indexOf(n) !== i));

  if (!territories.length)
    return (
      <div className="page">
        <p>
          No territories yet.{' '}
          <button className="btn" onClick={() => go('split')}>
            Split the boundary
          </button>
        </p>
      </div>
    );

  return (
    <div className="split-layout review">
      <aside className="panel">
        {notice && (
          <p className="hint" role="status">
            {notice}
          </p>
        )}
        <div className="toolbar">
          <button className="btn" disabled={mode !== 'select' || sel.length < 2} onClick={merge} title="Join the selected territories into one">
            Merge ({sel.length})
          </button>
          <button className="btn" disabled={mode !== 'select'} onClick={startCut} title="Draw a line across a territory to cut it">
            Cut with line
          </button>
          <button className="btn" disabled={mode !== 'select' || sel.length !== 1} onClick={startEdit} title="Drag the corners of the outline">
            Edit outline
          </button>
          <button className="btn danger" disabled={mode !== 'select' || !sel.length} onClick={remove}>
            Delete
          </button>
          <button className="btn" disabled={!undoCount || mode !== 'select'} onClick={undoLast} title="Undo the last change">
            Undo{undoCount ? ` (${undoCount})` : ''}
          </button>
          <button
            className="btn"
            disabled={!undoCount || mode !== 'select'}
            onClick={() => confirm(`Undo all ${undoCount} changes made since the app was opened? This can go back to before the last split.`) && undoAll()}
            title="Undo every change back to the start"
          >
            Undo all
          </button>
        </div>
        {mode === 'cut' && (
          <p className="hint">
            Click along the road where you want to cut, crossing the territory edge on both sides. Click the last point again to finish.{' '}
            {sel.length ? `Cutting ${sel.length} selected.` : 'Nothing selected: every territory the line crosses is cut.'}{' '}
            <button
              className="btn ghost"
              onClick={() => {
                map.current!.pm.disableDraw();
                setMode('select');
              }}
            >
              Cancel
            </button>
          </p>
        )}
        {mode === 'edit' && (
          <p className="hint">
            Drag the white corner points; click a midpoint to add a corner, right-click a corner to remove it.{' '}
            <button className="btn primary" onClick={() => finishEdit(true)}>
              Save outline
            </button>{' '}
            <button className="btn ghost" onClick={() => finishEdit(false)}>
              Cancel
            </button>
          </p>
        )}
        <div className="summary">
          <b>{territories.length}</b> territories · <b>{unnamed}</b> without locality
          {toCheck > 0 && <span className="warn"> · {toCheck} with straight cuts to check</span>}
          {dupNumbers.size > 0 && <span className="warn"> · duplicate numbers: {[...dupNumbers].join(', ')}</span>}
        </div>
        <div className="toolbar small">
          <button className="btn ghost" disabled={task.busy} onClick={snapToRoads} title="Move hand-drawn or imported borders onto the nearest roads; Undo puts them back">
            Snap borders to roads
          </button>
          <button className="btn ghost" onClick={renumber} title="Number the territories 1, 2, 3 … from the top of the map to the bottom">
            Renumber top to bottom
          </button>
          <button
            className="btn ghost"
            title="Make small ponds inside a territory part of it instead of a hole"
            disabled={task.busy}
            onClick={async () => {
              const filled = await task.run('Including small ponds', (report) => {
                report(`Checking ${territories.length} territories for ponds…`);
                return fillPondsInAreas(territories.map((t) => t.geometry));
              });
              if (filled) update((p) => ({ ...p, territories: p.territories.map((t, i) => ({ ...t, geometry: filled[i] })) }), true);
            }}
          >
            Include ponds
          </button>
          <button className="btn ghost" onClick={() => suggestNames(true)} title="Fill empty localities from OpenStreetMap place names">
            Suggest localities
          </button>
          <select value={lang} onChange={(e) => setLang(e.target.value)} title="Language for suggested names">
            <option value="en">English</option>
            <option value="ml">Malayalam</option>
            <option value="default">Local name</option>
          </select>
          <input className="search" placeholder="Find number or locality" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <p className="muted tiny">Click a territory on the map or in the list to select it; Shift/Ctrl-click to select several.</p>
        <div className="tlist">
          {shown.map((t) => {
            // House-count warnings only make sense when the split aimed for equal houses.
            const bySize = settings.sizeMode === 'houses' || settings.evenBy === 'houses';
            const flag =
              !bySize || !index || t.buildings === 0 ? '' : t.buildings > settings.maxBuildings ? 'over' : t.buildings < settings.minBuildings ? 'under' : '';
            return (
              <div
                key={t.id}
                id={`row-${t.id}`}
                className={`trow ${selected.includes(t.id) ? 'on' : ''}`}
                onClick={(e) =>
                  e.shiftKey || e.ctrlKey || e.metaKey
                    ? setSelected((s) => (s.includes(t.id) ? s.filter((x) => x !== t.id) : [...s, t.id]))
                    : zoomTo(t.id)
                }
              >
                <NumberField className={`num ${dupNumbers.has(t.number) ? 'dup' : ''}`} value={t.number} onCommit={(v) => setNumber(t.id, v)} />
                <input
                  className="loc"
                  value={t.locality}
                  placeholder="Unnamed locality"
                  aria-label="Locality"
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => patch(t.id, { locality: e.target.value })}
                />
                <span className={`count ${flag}`} title={t.needsCheck ? 'Part of this outline is a straight cut (no road there). Please check it.' : 'Buildings counted from OpenStreetMap'}>
                  {t.needsCheck && <span className="chk">check </span>}
                  {t.buildings}
                </span>
              </div>
            );
          })}
        </div>
        <button
          className="btn primary big"
          disabled={mode !== 'select'}
          onClick={() => {
            if (unnamed && !confirm(`${unnamed} territories have no locality yet. Continue anyway?`)) return;
            update((p) => ({ ...p, finalized: true }));
            go('cards');
          }}
        >
          Finish review → cards
        </button>
        <button className="btn ghost" onClick={() => setSelected([])} hidden={!selected.length}>
          Clear selection
        </button>
        <h3>Save a copy (KML)</h3>
        <p className="muted tiny">Check the split in Google Earth, My Maps or any map app, or keep a copy outside this app.</p>
        <KmlExport territories={territories} congregation={settings.congregation} />
      </aside>
      <div className={`map-wrap mode-${mode}`}>
        <div className="map" ref={el} />
      </div>
    </div>
  );
}

/**
 * A territory number that is only applied when you press Enter or leave the box, so typing "12"
 * doesn't swap with territory 1 on the way. Escape puts the old number back.
 */
function NumberField({ value, onCommit, className }: { value: string; onCommit: (v: string) => void; className: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className={className}
      value={draft}
      aria-label="Territory number"
      title="Type a new number and press Enter. The territory that had that number gets this one's old number."
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => (draft.trim() ? onCommit(draft) : setDraft(value))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(value);
          setTimeout(() => (e.target as HTMLInputElement).blur());
        }
      }}
    />
  );
}
