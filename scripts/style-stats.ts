// Measures how a set of hand-drawn territories (KML from My Maps) is drawn: houses, size,
// shape, and which kind of line (rail/main road/local road/lane/none) the borders follow.
// Usage: npx tsx scripts/style-stats.ts <map.kml> [osm-cache.json]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { kml } from '@tmcw/togeojson';
import { fetchOsm } from '../src/geo/osm';
import { BuildingIndex, toJsts, clean, union, toArea, areaKm2 } from '../src/geo/core';
import type { Area, OsmData } from '../src/types';
import { styleOf } from '../src/geo/style';

const [file, cache = file.replace(/\.kml$/, '.osm.json')] = process.argv.slice(2);
const fc = kml(new DOMParser().parseFromString(readFileSync(file, 'utf8'), 'text/xml') as unknown as Document);
const shapes = fc.features
  .filter((f) => f.geometry && /Polygon/.test(f.geometry.type))
  .map((f) => ({ name: String(f.properties?.name ?? ''), geometry: toArea(clean(toJsts(f.geometry as Area))) }));

let osm: OsmData;
if (existsSync(cache)) osm = JSON.parse(readFileSync(cache, 'utf8'));
else {
  const all = union(shapes.map((s) => toJsts(s.geometry)));
  const e = all.getEnvelopeInternal();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, init) => realFetch(u, { ...init, headers: { 'User-Agent': 'TerritoryManager/0.1 (style study)', Accept: 'application/json' } });
  osm = await fetchOsm([e.getMinX() - 0.002, e.getMinY() - 0.002, e.getMaxX() + 0.002, e.getMaxY() + 0.002], () => {});
  writeFileSync(cache, JSON.stringify(osm));
}
const index = new BuildingIndex(osm.buildings);
const s = styleOf(shapes.map((x) => x.geometry), osm, index);
console.log(JSON.stringify({ file, territories: shapes.length, km2: shapes.reduce((a, x) => a + areaKm2(x.geometry), 0).toFixed(1), ...s }, null, 1));
