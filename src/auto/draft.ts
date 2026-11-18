// Automatic first draft of a congregation's territories from its boundary: split, number, suggest
// locality names, and point out territories worth merging. Runs without a browser (GitHub Actions)
// and gives a normal generator project, so the owner opens it and carries on by hand.
import { autoSplit, BuildingIndex, clean, sweepOrder, suggestLocality, toJsts, union, toArea } from '../geo/core';
import { styleOf, type Style } from '../geo/style';
import { defaultSettings, newProject, uid, type Area, type OsmData, type Project, type Territory } from '../types';

/**
 * House counts learned from the owner's hand-drawn My Maps (Aroor 124 and Peechi 39 territories,
 * 2026-11-18): median 140–240 houses, few under 60 or over 400; inner borders follow local roads
 * (67–95%), seldom main roads or rail, and are rarely drawn freehand (0–11%).
 */
export const LEARNED = {
  min: 150,
  max: 250,
  /** Below this a territory is too small to stand alone. */
  tooFew: 60,
  /** A merge may make a territory this big (the largest hand-drawn ones). */
  mergeUpTo: 400,
  /** Hand-drawn medians, to compare a draft against. */
  compact: 0.58,
  freeDrawn: 0.11,
};

export interface MergeIdea {
  numbers: [string, string];
  houses: number;
  why: string;
}
export interface DraftSummary {
  territories: number;
  houses: number;
  names: { number: string; locality: string; localityMl: string; houses: number }[];
  /** Localities given to more than one territory; the admin may want them told apart. */
  sharedNames: { locality: string; numbers: string[] }[];
  merges: MergeIdea[];
  /** Territories with a straight cut where no road was found. */
  check: string[];
  style: Style;
  /** Plain-language notes where the draft looks unlike the hand-drawn maps. */
  warnings: string[];
}

/** Length (degrees) of border two areas share. */
function shared(a: Area, b: Area): number {
  try {
    const ga = clean(toJsts(a));
    const gb = clean(toJsts(b));
    if (!ga.getEnvelopeInternal().intersects(gb.getEnvelopeInternal())) return 0;
    return ga.getBoundary().intersection(gb.buffer(2e-5)).getLength();
  } catch {
    return 0; // shapes JSTS cannot overlay are treated as not touching
  }
}

/**
 * Merge ideas: every territory under `tooFew` houses goes with the neighbour it shares the longest
 * border with, and two touching territories both under `min` go together, as long as the result
 * stays within `mergeUpTo`. Each territory appears in at most one idea.
 */
export function mergeIdeas(ts: Pick<Territory, 'number' | 'buildings' | 'geometry'>[], opt = LEARNED): MergeIdea[] {
  const used = new Set<string>();
  const out: MergeIdea[] = [];
  const small = ts.filter((t) => t.buildings < opt.min).sort((a, b) => a.buildings - b.buildings);
  for (const t of small) {
    if (used.has(t.number)) continue;
    const best = ts
      .filter((o) => o !== t && !used.has(o.number) && t.buildings + o.buildings <= opt.mergeUpTo)
      .filter((o) => t.buildings < opt.tooFew || o.buildings < opt.min)
      .map((o) => ({ o, len: shared(t.geometry, o.geometry) }))
      .filter((x) => x.len > 0)
      .sort((a, b) => b.len - a.len)[0];
    if (!best) continue;
    used.add(t.number).add(best.o.number);
    out.push({
      numbers: [t.number, best.o.number],
      houses: t.buildings + best.o.buildings,
      why: t.buildings < opt.tooFew ? `${t.number} has only ${t.buildings} houses` : `both are small (${t.buildings} and ${best.o.buildings} houses)`,
    });
  }
  return out;
}

export function draftProject(boundary: Area, osm: OsmData, congregation = '', opt = LEARNED): { project: Project; summary: DraftSummary } {
  const index = new BuildingIndex(osm.buildings);
  const pieces = autoSplit(boundary, osm, { min: opt.min, max: opt.max, levels: [true, true, true, true] });
  const territories: Territory[] = sweepOrder(pieces).map((r, i) => ({
    id: uid(),
    number: String(i + 1),
    locality: suggestLocality(r.geometry, osm.places, 'en'),
    geometry: r.geometry,
    buildings: r.buildings,
    ...(r.straightCut ? { needsCheck: true } : {}),
  }));
  const merges = mergeIdeas(territories, opt);
  for (const m of merges)
    for (const [a, b] of [m.numbers, [m.numbers[1], m.numbers[0]]]) {
      const t = territories.find((x) => x.number === a)!;
      t.notes = `Suggested: merge with ${b} (${m.why}; ${m.houses} houses together).`;
    }

  const byName = new Map<string, string[]>();
  for (const t of territories) if (t.locality) byName.set(t.locality, [...(byName.get(t.locality) ?? []), t.number]);
  const style = styleOf(territories.map((t) => t.geometry), osm, index);
  const warnings: string[] = [];
  if (style.compact.median < opt.compact * 0.8)
    warnings.push(`Shapes are less compact than your hand-drawn maps (${style.compact.median.toFixed(2)} vs ${opt.compact}).`);
  if (style.border.none > opt.freeDrawn * 1.5)
    warnings.push(`${Math.round(style.border.none * 100)}% of borders follow no road (yours: about ${Math.round(opt.freeDrawn * 100)}%).`);
  const unnamed = territories.filter((t) => !t.locality).length;
  if (unnamed) warnings.push(`${unnamed} territories have no locality name on OpenStreetMap.`);

  const project: Project = {
    ...newProject(),
    boundary: { type: 'Feature', properties: { name: congregation }, geometry: boundary },
    territories,
    settings: { ...defaultSettings(), congregation, minBuildings: opt.min, maxBuildings: opt.max },
  };
  return {
    project,
    summary: {
      territories: territories.length,
      houses: territories.reduce((n, t) => n + t.buildings, 0),
      names: territories.map((t) => ({ number: t.number, locality: t.locality, localityMl: suggestLocality(t.geometry, osm.places, 'ml'), houses: t.buildings })),
      sharedNames: [...byName].filter(([, ns]) => ns.length > 1).map(([locality, numbers]) => ({ locality, numbers })),
      merges,
      check: territories.filter((t) => t.needsCheck).map((t) => t.number),
      style,
      warnings,
    },
  };
}

/** The owner's email: names to check, merges to consider, and what looks unusual. */
export function summaryText(congregation: string, s: DraftSummary): string {
  const lines = [
    `Automatic draft for ${congregation}: ${s.territories} territories, about ${s.houses.toLocaleString('en-IN')} houses.`,
    '',
    'LOCALITY NAMES (from OpenStreetMap; please check):',
    ...s.names.map((n) => `  ${n.number}. ${n.locality || '(no name found)'}${n.localityMl && n.localityMl !== n.locality ? ` / ${n.localityMl}` : ''} (${n.houses} houses)`),
  ];
  if (s.sharedNames.length) lines.push('', 'SAME NAME ON SEVERAL TERRITORIES:', ...s.sharedNames.map((x) => `  ${x.locality}: ${x.numbers.join(', ')}`));
  lines.push('', 'COULD BE MERGED:', ...(s.merges.length ? s.merges.map((m) => `  ${m.numbers.join(' + ')}: ${m.why}, ${m.houses} together`) : ['  none']));
  if (s.check.length) lines.push('', `STRAIGHT CUTS TO CHECK (no road found): ${s.check.join(', ')}`);
  if (s.warnings.length) lines.push('', 'NOTES:', ...s.warnings.map((w) => `  ${w}`));
  return lines.join('\n');
}

/** One boundary from the shapes of a KML: their union (a congregation map may come in parts). */
export const boundaryOf = (shapes: { geometry: Area }[]): Area => toArea(clean(union(shapes.map((s) => clean(toJsts(s.geometry))))));
