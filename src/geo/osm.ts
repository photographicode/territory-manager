import osmtogeojson from 'osmtogeojson';
import type { Area, OsmData } from '../types';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/** Border level for an OSM way, or -1 when it is not a border. */
export function levelOf(tags: Record<string, string>): number {
  const { highway, railway, waterway } = tags;
  if (tags.area === 'yes' || tags.tunnel === 'yes') return -1;
  if (railway && /^(rail|light_rail|subway|narrow_gauge|tram)$/.test(railway)) return 0;
  if (waterway && /^(river|canal)$/.test(waterway)) return 0;
  if (waterway && /^(stream|drain|ditch)$/.test(waterway)) return 2;
  if (!highway) return -1;
  if (/^(motorway|trunk|primary)$/.test(highway)) return 0;
  if (/^(secondary|tertiary)$/.test(highway)) return 1;
  if (/^(unclassified|residential|living_street|road)$/.test(highway)) return 2;
  if (/^(service|track|pedestrian|path|footway|steps|cycleway)$/.test(highway)) return 3;
  return -1; // links, construction, proposed, etc.
}

function query(b: [number, number, number, number]) {
  const bbox = `${b[1]},${b[0]},${b[3]},${b[2]}`; // south,west,north,east
  return `[out:json][timeout:300][maxsize:536870912];
(
  way["highway"](${bbox});
  way["railway"](${bbox});
  way["waterway"~"^(river|canal|stream|drain|ditch)$"](${bbox});
);
out tags geom qt;
(
  way["natural"="water"](${bbox});
  relation["natural"="water"](${bbox});
  way["waterway"="riverbank"](${bbox});
  relation["waterway"="riverbank"](${bbox});
);
out body geom qt;
way["building"](${bbox});
out skel center qt;
node["building"](${bbox});
out skel qt;
node["place"~"^(town|village|suburb|quarter|neighbourhood|hamlet|locality|isolated_dwelling)$"]["name"](${bbox});
out body qt;`;
}

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
  geometry?: { lat: number; lon: number }[];
}

/** Download roads, railways, water and building positions for a bounding box. */
export async function fetchOsm(bbox: [number, number, number, number], onStatus: (s: string) => void): Promise<OsmData> {
  const errors: string[] = [];
  for (const url of ENDPOINTS) {
    try {
      onStatus(`Downloading map data from ${new URL(url).host}…`);
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query(bbox) }), headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      onStatus('Processing map data…');
      return parse(json, bbox);
    } catch (e) {
      errors.push(`${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`Could not download OpenStreetMap data (the free servers may be busy, try again in a few minutes). ${errors.join('; ')}`);
}

function parse(json: { elements: OsmElement[] }, bbox: OsmData['bbox']): OsmData {
  const lines: OsmData['lines'] = [];
  const buildings: [number, number][] = [];
  const waterEls: OsmElement[] = [];
  const places: OsmData['places'] = [];
  for (const el of json.elements) {
    const tags = el.tags ?? {};
    if (el.type === 'node' && tags.place && tags.name) {
      const names: Record<string, string> = { default: tags.name };
      for (const [k, v] of Object.entries(tags)) if (k.startsWith('name:')) names[k.slice(5)] = v;
      places.push({ names, kind: tags.place, at: [el.lon!, el.lat!] });
    } else if (el.type === 'way' && el.center) buildings.push([el.center.lon, el.center.lat]);
    else if (el.type === 'node' && el.lat !== undefined && !el.tags?.highway) buildings.push([el.lon!, el.lat]);
    else if (tags.natural === 'water' || tags.waterway === 'riverbank') waterEls.push(el);
    else if (el.type === 'way' && el.geometry) {
      const level = levelOf(tags);
      if (level >= 0) lines.push({ level, coords: el.geometry.map((g) => [g.lon, g.lat]) });
    }
  }
  const water: Area[] = [];
  const gj = osmtogeojson({ elements: waterEls });
  for (const f of gj.features) {
    const g = f.geometry;
    if (g && (g.type === 'Polygon' || g.type === 'MultiPolygon')) water.push(g);
  }
  return { bbox, fetchedAt: new Date().toISOString(), lines, water, buildings, places };
}
