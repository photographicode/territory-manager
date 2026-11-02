import { kml } from '@tmcw/togeojson';
import { unzipSync, strFromU8, strToU8, zipSync } from 'fflate';
import type { Feature } from 'geojson';
import type { Area, Territory } from '../types';

export interface ImportedShape {
  name: string;
  geometry: Area;
}

/** Read polygons from a .kml or .kmz file (e.g. exported from Google My Maps). */
export async function readKml(file: File): Promise<ImportedShape[]> {
  let text: string;
  if (file.name.toLowerCase().endsWith('.kmz')) {
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const name = Object.keys(files).find((n) => n.toLowerCase().endsWith('.kml'));
    if (!name) throw new Error('No KML found inside the KMZ file');
    text = strFromU8(files[name]);
  } else text = await file.text();
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const fc = kml(doc);
  const out: ImportedShape[] = [];
  for (const f of fc.features as Feature[]) {
    const name = String(f.properties?.name ?? '');
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') out.push({ name, geometry: strip(g) });
    else if (g.type === 'GeometryCollection') {
      for (const sub of g.geometries)
        if (sub.type === 'Polygon' || sub.type === 'MultiPolygon') out.push({ name, geometry: strip(sub) });
    } else if (g.type === 'LineString' && closed(g.coordinates))
      out.push({ name, geometry: { type: 'Polygon', coordinates: [g.coordinates.map((c) => [c[0], c[1]])] } });
  }
  if (!out.length) throw new Error('The file has no polygon (boundary) shapes');
  return out;
}

const closed = (c: number[][]) => c.length > 3 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1];

/** Drop altitude values so geometry stays 2D. */
function strip(g: Area): Area {
  const ring = (r: number[][]) => r.map((c) => [c[0], c[1]]);
  return g.type === 'Polygon'
    ? { type: 'Polygon', coordinates: g.coordinates.map(ring) }
    : { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => p.map(ring)) };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function polygonKml(rings: number[][][]) {
  const coords = (r: number[][]) => r.map((c) => `${c[0]},${c[1]},0`).join(' ');
  return `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords(rings[0])}</coordinates></LinearRing></outerBoundaryIs>${rings
    .slice(1)
    .map((r) => `<innerBoundaryIs><LinearRing><coordinates>${coords(r)}</coordinates></LinearRing></innerBoundaryIs>`)
    .join('')}</Polygon>`;
}

export function placemark(name: string, g: Area, description = '') {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const geom = polys.length === 1 ? polygonKml(polys[0]) : `<MultiGeometry>${polys.map(polygonKml).join('')}</MultiGeometry>`;
  return `<Placemark><name>${esc(name)}</name><description>${esc(description)}</description><styleUrl>#t</styleUrl>${geom}</Placemark>`;
}

export function kmlDocument(name: string, placemarks: string[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(name)}</name>
<Style id="t"><LineStyle><color>ff2b39c0</color><width>3</width></LineStyle><PolyStyle><color>4d2b39c0</color></PolyStyle></Style>
${placemarks.join('\n')}
</Document></kml>`;
}

export const territoryLabel = (t: Pick<Territory, 'number' | 'locality'>) =>
  [t.number && `No. ${t.number}`, t.locality].filter(Boolean).join(' – ') || 'Territory';

export function territoriesKml(title: string, ts: Territory[]) {
  return kmlDocument(title, ts.map((t) => placemark(territoryLabel(t), t.geometry, `${t.buildings} buildings (OpenStreetMap)`)));
}

export function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** One territory as its own KML, ready for a new Google My Maps map. */
export function territoryKml(t: Territory, congregation = '') {
  const name = [congregation, territoryLabel(t)].filter(Boolean).join(' · ');
  return kmlDocument(name, [placemark(territoryLabel(t), t.geometry)]);
}

export const fileName = (t: Pick<Territory, 'number' | 'locality'>) =>
  `Territory ${t.number}${t.locality ? ` - ${t.locality}` : ''}`.replace(/[\/\\:*?"<>|]/g, '');

const exportBase = (congregation: string) => `Territories${congregation ? ` - ${congregation}` : ''}`;

/** Every territory in one KML file. */
export function downloadAllKml(ts: Territory[], congregation: string) {
  const base = exportBase(congregation);
  download(`${base}.kml`, territoriesKml(base, ts), 'application/vnd.google-earth.kml+xml');
}

/** A ZIP with one KML per territory. */
export function downloadEachKml(ts: Territory[], congregation: string) {
  const used = new Set<string>();
  const files: Record<string, Uint8Array> = {};
  for (const t of ts) {
    let name = fileName(t);
    for (let i = 2; used.has(name); i++) name = `${fileName(t)} (${i})`;
    used.add(name);
    files[`${name}.kml`] = strToU8(territoryKml(t, congregation));
  }
  download(`${exportBase(congregation)} (one KML each).zip`, zipSync(files), 'application/zip');
}

/** GPX with the outline as a closed track, for apps such as OsmAnd and Organic Maps. */
export function gpxDocument(name: string, g: Area) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const segs = polys
    .map((rings) => `<trkseg>${rings[0].map((c) => `<trkpt lat="${c[1]}" lon="${c[0]}"/>`).join('')}</trkseg>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Territory Manager" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${esc(name)}</name>${segs}</trk></gpx>`;
}
