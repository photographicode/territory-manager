// Manual check: split a sample area near Aroor using live OpenStreetMap data.
import { writeFileSync } from 'node:fs';
import { fetchOsm } from '../src/geo/osm';
import { autoSplit, suggestLocality } from '../src/geo/core';
import { decodeArea, encodeArea } from '../src/geo/codec';
import type { Area } from '../src/types';

const boundary: Area = {
  type: 'Polygon',
  coordinates: [[[76.292, 9.872], [76.312, 9.872], [76.316, 9.892], [76.296, 9.896], [76.292, 9.872]]],
};
const out = process.argv[2];
// Overpass rejects Node's default user agent.
const realFetch = globalThis.fetch;
globalThis.fetch = (u, init) => realFetch(u, { ...init, headers: { 'User-Agent': 'TerritoryManager/0.1 (test script)', Accept: 'application/json' } });
const osm = await fetchOsm([76.29, 9.87, 76.318, 9.898], console.log);
console.log('lines', osm.lines.length, 'buildings', osm.buildings.length, 'water', osm.water.length, 'places', osm.places.length);
console.time('split');
const res = autoSplit(boundary, osm, { min: 150, max: 250, levels: [true, true, true, true], onProgress: console.log });
console.timeEnd('split');
console.log('territories', res.length, res.map((r) => r.buildings + (r.straightCut ? '*' : '')).join(' '));
const names = res.map((r) => suggestLocality(r.geometry, osm.places, 'en'));
console.log('names', names.join(' | '));
const code = encodeArea(res[0].geometry);
console.log('code length', code.length, 'roundtrip pts', JSON.stringify(decodeArea(code)).length > 10);
writeFileSync(out, JSON.stringify({ boundary, osm, res }));
