import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import type { PageProps } from '../App';
import { readKml, type ImportedShape } from '../geo/kml';
import { mergeAreas, sweepOrder } from '../geo/core';
import { createMap, toLatLngs } from '../map';
import { uid } from '../types';
import { useTask } from '../task';

export default function BoundaryStep({ project, update, go }: PageProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map>();
  const layer = useRef<L.LayerGroup>();
  const [shapes, setShapes] = useState<ImportedShape[] | null>(null);
  const task = useTask();

  useEffect(() => {
    map.current = createMap(el.current!);
    layer.current = L.layerGroup().addTo(map.current);
    return () => void map.current?.remove();
  }, []);

  useEffect(() => {
    const g = layer.current!;
    g.clearLayers();
    const areas = shapes ? shapes.map((s) => s.geometry) : project.boundary ? [project.boundary.geometry] : [];
    const polys = areas.map((a) =>
      L.polygon(toLatLngs(a) as L.LatLngExpression[][], { color: shapes ? '#2471a3' : '#a5281b', weight: 3, fillOpacity: 0.08 }).addTo(g),
    );
    if (polys.length) map.current!.fitBounds(L.featureGroup(polys).getBounds(), { padding: [20, 20] });
  }, [shapes, project.boundary]);

  async function onFile(f: File | undefined) {
    if (!f) return;
    const read = await task.run(`Reading ${f.name}`, (report) => {
      report(`${(f.size / 1024).toFixed(0)} KB`);
      return readKml(f);
    });
    if (read) setShapes(read);
  }

  function useAsBoundary() {
    if (!shapes) return;
    if (project.territories.length && !confirm('Replace the congregation boundary? Existing territories are kept until you split again.')) return;
    const geometry = shapes.length === 1 ? shapes[0].geometry : mergeAreas(shapes.map((s) => s.geometry));
    update((p) => ({ ...p, boundary: { type: 'Feature', properties: {}, geometry } }), true);
    setShapes(null);
    go('split');
  }

  function importAsTerritories() {
    if (!shapes) return;
    if (project.territories.length && !confirm(`Replace the ${project.territories.length} current territories with ${shapes.length} imported ones?`)) return;
    const ordered = sweepOrder(shapes);
    update(
      (p) => ({
        ...p,
        boundary: p.boundary ?? { type: 'Feature', properties: {}, geometry: mergeAreas(shapes.map((s) => s.geometry)) },
        territories: ordered.map((s, i) => {
          const m = /^\s*(?:no\.?\s*)?(\d+[a-z]?)\b[\s.\-–:]*(.*)$/i.exec(s.name);
          return { id: uid(), number: m ? m[1] : String(i + 1), locality: m ? m[2] : s.name, geometry: s.geometry, buildings: 0 };
        }),
        finalized: false,
      }),
      true,
    );
    setShapes(null);
    go('review');
  }

  return (
    <div className="split-layout">
      <aside className="panel">
        <h2>Congregation boundary</h2>
        <label className="field">
          <span>Congregation name</span>
          <input
            value={project.settings.congregation}
            onChange={(e) => update((p) => ({ ...p, settings: { ...p.settings, congregation: e.target.value } }))}
            placeholder="e.g. Aroor"
          />
        </label>
        <p className="muted">
          Import the KML or KMZ outline of the whole congregation territory. In Google My Maps use <b>⋮ → Export to KML/KMZ</b>.
        </p>
        <label className="file">
          <input type="file" accept=".kml,.kmz" onChange={(e) => onFile(e.target.files?.[0])} />
          <span className="btn primary">Choose KML / KMZ file</span>
        </label>
        {shapes && (
          <div className="card-box">
            <p>
              Found <b>{shapes.length}</b> shape{shapes.length > 1 ? 's' : ''}
              {shapes.length > 1 && (
                <>
                  {' '}
                  ({shapes.slice(0, 4).map((s) => s.name || 'unnamed').join(', ')}
                  {shapes.length > 4 ? '…' : ''})
                </>
              )}
              .
            </p>
            <button className="btn primary" onClick={useAsBoundary}>
              Use as congregation boundary
            </button>
            {shapes.length > 1 && (
              <button className="btn" onClick={importAsTerritories}>
                Import as existing territories
              </button>
            )}
            <button className="btn ghost" onClick={() => setShapes(null)}>
              Cancel
            </button>
          </div>
        )}
        {project.boundary && !shapes && (
          <div className="card-box">
            <p>Boundary loaded.</p>
            <button className="btn primary" onClick={() => go('split')}>
              Next: split into territories →
            </button>
          </div>
        )}
      </aside>
      <div className="map" ref={el} />
    </div>
  );
}
