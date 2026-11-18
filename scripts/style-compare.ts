// Splits the outline of a hand-drawn map automatically and compares the result with the hand-drawn
// territories: style numbers side by side, and how well each hand territory is matched (best IoU).
// Usage: npx tsx scripts/style-compare.ts <map.kml> <min> <max>   (needs the .osm.json from style-stats)
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { kml } from '@tmcw/togeojson';
import { autoSplit, BuildingIndex, toJsts, clean, union, toArea } from '../src/geo/core';
import type { Area, OsmData } from '../src/types';
import { styleOf, spread } from '../src/geo/style';

const [file, min = '150', max = '250'] = process.argv.slice(2);
const fc = kml(new DOMParser().parseFromString(readFileSync(file, 'utf8'), 'text/xml') as unknown as Document);
const hand = fc.features.filter((f) => f.geometry && /Polygon/.test(f.geometry.type)).map((f) => toArea(clean(toJsts(f.geometry as Area))));
const osm: OsmData = JSON.parse(readFileSync(file.replace(/\.kml$/, '.osm.json'), 'utf8'));
const index = new BuildingIndex(osm.buildings);
const boundary = toArea(clean(union(hand.map((a) => toJsts(a)))));
console.time('split');
const auto = autoSplit(boundary, osm, { min: +min, max: +max, levels: [true, true, true, true] }).map((r) => r.geometry);
console.timeEnd('split');
const iou = hand.map((h) => {
  const g = toJsts(h);
  let best = 0;
  for (const a of auto) {
    const o = toJsts(a);
    if (!g.getEnvelopeInternal().intersects(o.getEnvelopeInternal())) continue;
    let i = 0;
    try {
      i = g.intersection(o).getArea();
    } catch {
      // shortcut: a pair JSTS cannot overlay (non-noded hand-drawn edges) counts as no overlap; fine for a study
    }
    best = Math.max(best, i / (g.getArea() + o.getArea() - i));
  }
  return best;
});
console.log(JSON.stringify({ hand: { n: hand.length, ...styleOf(hand, osm, index) }, auto: { n: auto.length, ...styleOf(auto, osm, index) }, iou: spread(iou), iouOver60: iou.filter((x) => x > 0.6).length }, null, 1));
