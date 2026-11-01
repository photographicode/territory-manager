import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import type { PageProps } from '../App';
import { areasTouch, BuildingIndex, countBuildings, mergeAreas, splitByLine, suggestLocality, sweepOrder } from '../geo/core';
import { loadOsm } from '../store';
import { colorFor, createMap, toLatLngs } from '../map';
import { uid, type Area, type OsmData, type Territory } from '../types';

type Mode = 'select' | 'cut' | 'edit';

export default function ReviewStep({ project, update, undoLast, undoCount, go }: PageProps) {
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
  const { territories, settings } = project;
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
      poly.bindTooltip(t.number || '?', { permanent: true, direction: 'center', className: 'tlabel' });
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
    const merged: Territory = {
      ...first,
      geometry: mergeAreas(sel.map((t) => t.geometry)),
      buildings: sel.reduce((n, t) => n + t.buildings, 0),
      locality: sel.map((t) => t.locality).find(Boolean) ?? '',
    };
    update((p) => ({ ...p, territories: p.territories.filter((t) => !selected.includes(t.id) || t.id === first.id).map((t) => (t.id === first.id ? merged : t)) }), true);
    setSelected([first.id]);
  }

  function cutWith(line: [number, number][]) {
    const { selected: s, territories: ts } = live.current;
    const targets = s.length ? ts.filter((t) => s.includes(t.id)) : ts;
    let next = Math.max(0, ...ts.map((t) => parseInt(t.number) || 0)) + 1;
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
        .forEach((g, i) => result.push({ ...t, id: i ? uid() : t.id, number: i ? String(next++) : t.number, geometry: g, buildings: recount(g) }));
    }
    setMode('select');
    map.current!.pm.disableDraw();
    if (!changed) return alert('The line must cross the territory completely, from one edge to another.');
    update((p) => ({ ...p, territories: result }), true);
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
    update((p) => ({ ...p, territories: p.territories.filter((t) => !selected.includes(t.id)) }), true);
  }

  function renumber() {
    if (!confirm('Renumber all territories from north to south (1, 2, 3 …)?')) return;
    update((p) => ({ ...p, territories: sweepOrder(p.territories).map((t, i) => ({ ...t, number: String(i + 1) })) }), true);
  }

  function suggestNames(onlyEmpty: boolean) {
    if (!osm?.places?.length) return alert('No place names in the downloaded map data. Download map data again on the Split step.');
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
  const shown = territories.filter((t) => !q || t.number.toLowerCase() === q || t.locality.toLowerCase().includes(q));
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
          <button className="btn" disabled={!undoCount || mode !== 'select'} onClick={undoLast}>
            Undo
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
          <button className="btn ghost" onClick={renumber}>
            Renumber N→S
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
            const flag = !index || t.buildings === 0 ? '' : t.buildings > settings.maxBuildings ? 'over' : t.buildings < settings.minBuildings ? 'under' : '';
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
                <input
                  className={`num ${dupNumbers.has(t.number) ? 'dup' : ''}`}
                  value={t.number}
                  aria-label="Territory number"
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => patch(t.id, { number: e.target.value })}
                />
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
      </aside>
      <div className={`map-wrap mode-${mode}`}>
        <div className="map" ref={el} />
      </div>
    </div>
  );
}
