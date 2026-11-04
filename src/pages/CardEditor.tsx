import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import type { PageProps } from '../App';
import { renderCard } from '../card/render';
import { createMap, toLatLngs } from '../map';
import { MAX_LANDMARKS, type Landmark } from '../types';
import { byNumber } from './TerritoriesPage';
import MyMapsLinks from './MyMapsLinks';

const ll = ([lon, lat]: [number, number]): L.LatLngTuple => [lat, lon];
const lonLat = (p: L.LatLng): [number, number] => [p.lng, p.lat];

export default function CardEditor({ project, update }: PageProps) {
  const ts = [...project.territories].sort(byNumber);
  const [current, setCurrent] = useState(ts[0]?.id ?? '');
  const t = ts.find((x) => x.id === current) ?? ts[0];
  const marks = t?.landmarks ?? [];
  const mapEl = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const layer = useRef<L.LayerGroup>();

  const setMarks = (fn: (l: Landmark[]) => Landmark[], undoable = false) =>
    update((p) => ({ ...p, territories: p.territories.map((x) => (x.id === t.id ? { ...x, landmarks: fn(x.landmarks ?? []) } : x)) }), undoable);
  // Map handlers are bound once per territory; they read the latest state from here.
  const latest = useRef({ marks, setMarks });
  latest.current = { marks, setMarks };

  // The map is shaped like the map on the card, so boxes land about where they print.
  useEffect(() => {
    if (!t) return;
    const m = createMap(mapEl.current!);
    const poly = L.polygon(toLatLngs(t.geometry) as L.LatLngExpression[][], { color: '#a5281b', weight: 3, fillOpacity: 0.2, interactive: false }).addTo(m);
    const size = m.getSize();
    m.fitBounds(poly.getBounds(), { padding: [size.x * 0.08, size.y * 0.08] }); // same margin as the card map
    m.on('click', (e: L.LeafletMouseEvent) => {
      if (latest.current.marks.length >= MAX_LANDMARKS) return;
      // Start the box a little outward from the middle of the territory, off the spot itself.
      const c = m.latLngToContainerPoint(poly.getBounds().getCenter());
      const p = m.latLngToContainerPoint(e.latlng);
      const box = m.containerPointToLatLng([p.x + (p.x < c.x ? -80 : 80), p.y + (p.y < c.y ? -45 : 45)]);
      latest.current.setMarks((l) => [...l, { text: '', at: lonLat(e.latlng), box: lonLat(box) }], true);
    });
    layer.current = L.layerGroup().addTo(m);
    return () => void m.remove();
  }, [t?.id, t?.geometry]);

  // Dots and boxes; both can be dragged.
  useEffect(() => {
    const g = layer.current;
    if (!g) return;
    g.clearLayers();
    marks.forEach((l, i) => {
      L.polyline([ll(l.at), ll(l.box)], { color: '#555', weight: 2, interactive: false }).addTo(g);
      const label = document.createElement('div');
      label.className = 'lm-box';
      label.textContent = l.text.trim() || `Landmark ${i + 1}`;
      const move = (key: 'at' | 'box') => (e: L.LeafletEvent) =>
        latest.current.setMarks((all) => all.map((x, j) => (j === i ? { ...x, [key]: lonLat((e.target as L.Marker).getLatLng()) } : x)), true);
      L.marker(ll(l.box), { draggable: true, icon: L.divIcon({ html: label, className: 'lm-icon', iconSize: undefined }) })
        .on('dragend', move('box'))
        .addTo(g);
      L.marker(ll(l.at), { draggable: true, icon: L.divIcon({ className: 'lm-dot', iconSize: [18, 18] }) })
        .on('dragend', move('at'))
        .addTo(g);
    });
  }, [marks, t?.id]);

  // Card preview, redrawn shortly after the last change.
  useEffect(() => {
    if (!t) return;
    let stale = false;
    const timer = setTimeout(() => {
      renderCard(t, project.settings).then((c) => {
        if (stale || !preview.current) return;
        c.className = 'card-preview';
        preview.current.replaceChildren(c);
      });
    }, 600);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [t, project.settings]);

  if (!t) return <div className="page">No territories yet.</div>;

  return (
    <div className="split-layout cards">
      <aside className="panel">
        <h2>Cards</h2>
        <label className="field lm-pick">
          <span>Territory</span>
          <select value={t.id} onChange={(e) => setCurrent(e.target.value)}>
            {ts.map((x) => (
              <option key={x.id} value={x.id}>
                {x.number} · {x.locality || 'Unnamed'}
                {x.landmarks?.length ? ` (${x.landmarks.length} landmarks)` : ''}
              </option>
            ))}
          </select>
        </label>
        <p className="muted tiny">
          Landmarks help people find their way without the map link: junctions, shops, temples, bus stops. Click the map to add one (up to{' '}
          {MAX_LANDMARKS}), then type its name. Drag the dot onto the spot, and the box to where the label should sit. Changes are saved as you go.
        </p>
        {marks.map((l, i) => (
          <div key={i} className="lm-row">
            <label className="field">
              <span>Landmark {i + 1}</span>
              <input
                value={l.text}
                placeholder="e.g. Pallithaazham Junction"
                autoFocus={!l.text && i === marks.length - 1}
                onChange={(e) => setMarks((all) => all.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
              />
            </label>
            <button className="btn ghost" aria-label={`Remove landmark ${i + 1}`} onClick={() => setMarks((all) => all.filter((_, j) => j !== i), true)}>
              Remove
            </button>
          </div>
        ))}
        {!marks.length && <p className="muted">No landmarks on this card yet.</p>}
        {marks.length >= MAX_LANDMARKS && <p className="muted tiny">This card has the most landmarks it can hold.</p>}
        {marks.some((l) => !l.text.trim()) && <p className="warn">Boxes without a name are left off the printed card.</p>}
        <MyMapsLinks project={project} update={update} />
      </aside>
      <div className="preview-pane">
        <div ref={mapEl} className="map lm-map" />
        <h3>How the card will print</h3>
        <div ref={preview} className="preview-box">
          <p className="muted">Rendering…</p>
        </div>
      </div>
    </div>
  );
}
