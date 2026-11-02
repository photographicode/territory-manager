// Download OpenStreetMap data for a bounding box into a JSON file, for reproducing splits.
// Usage: npx tsx scripts/fetch-osm.ts <west> <south> <east> <north> <out.json>
import { writeFileSync } from 'node:fs';
import { fetchOsm } from '../src/geo/osm';

const [w, s, e, n, out] = process.argv.slice(2);
// Overpass rejects Node's default user agent.
const realFetch = globalThis.fetch;
globalThis.fetch = (u, init) => realFetch(u, { ...init, headers: { 'User-Agent': 'TerritoryManager/0.1 (test script)', Accept: 'application/json' } });
let last = '';
const osm = await fetchOsm([+w, +s, +e, +n], (msg) => msg !== last && console.log((last = msg)));
writeFileSync(out, JSON.stringify(osm));
console.log('saved', out, 'lines', osm.lines.length, 'buildings', osm.buildings.length, 'water', osm.water.length);
