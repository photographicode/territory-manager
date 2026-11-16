// Names a congregation wrote on its naming link, applied to the project: the locality of each territory, and its
// marked junctions or landmarks as card landmarks (the first MAX_LANDMARKS; boxes start on the spot, so press
// "Arrange all cards" afterwards to move them clear of the territory).
import type { NamedTerritory } from './handoff';
import { MAX_LANDMARKS, type Project } from './types';

export function applyNames(p: Project, names: NamedTerritory[]): { project: Project; named: number; marks: number; missing: string[] } {
  const byNumber = new Map(names.map((n) => [n.number, n]));
  let named = 0;
  let marks = 0;
  const territories = p.territories.map((t) => {
    const n = byNumber.get(t.number);
    if (!n) return t;
    named++;
    const landmarks = n.points.length
      ? n.points.slice(0, MAX_LANDMARKS).map((pt) => ({ text: pt.name, at: [pt.lng, pt.lat] as [number, number], box: [pt.lng, pt.lat] as [number, number] }))
      : t.landmarks;
    marks += n.points.length ? (landmarks?.length ?? 0) : 0;
    return { ...t, locality: n.locality || t.locality, landmarks };
  });
  const have = new Set(p.territories.map((t) => t.number));
  return { project: { ...p, territories }, named, marks, missing: names.map((n) => n.number).filter((n) => !have.has(n)) };
}
