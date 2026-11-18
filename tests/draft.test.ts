import { describe, expect, it } from 'vitest';
import { mergeIdeas, summaryText, type DraftSummary } from '../src/auto/draft';
import type { Area } from '../src/types';

const sq = (x: number): Area => ({ type: 'Polygon', coordinates: [[[x, 0], [x + 0.01, 0], [x + 0.01, 0.01], [x, 0.01], [x, 0]]] });

describe('mergeIdeas', () => {
  it('joins a tiny territory to its neighbour and two small neighbours together, each once', () => {
    const ts = [
      { number: '1', buildings: 40, geometry: sq(0) },
      { number: '2', buildings: 200, geometry: sq(0.01) },
      { number: '3', buildings: 120, geometry: sq(0.02) },
      { number: '4', buildings: 110, geometry: sq(0.03) },
      { number: '5', buildings: 100, geometry: sq(0.5) }, // touches nothing
    ];
    const ideas = mergeIdeas(ts);
    expect(ideas.map((m) => m.numbers)).toEqual([
      ['1', '2'],
      ['4', '3'],
    ]);
    expect(ideas[0].houses).toBe(240);
  });

  it('never makes a territory bigger than the largest hand-drawn ones', () => {
    expect(mergeIdeas([{ number: '1', buildings: 50, geometry: sq(0) }, { number: '2', buildings: 380, geometry: sq(0.01) }])).toEqual([]);
  });
});

it('summaryText lists names, shared names and merges', () => {
  const s: DraftSummary = {
    territories: 2,
    houses: 300,
    names: [
      { number: '1', locality: 'Aroor', localityMl: 'അരൂർ', houses: 100 },
      { number: '2', locality: '', localityMl: '', houses: 200 },
    ],
    sharedNames: [],
    merges: [{ numbers: ['1', '2'], houses: 300, why: 'both are small (100 and 200 houses)' }],
    check: [],
    style: { houses: { p10: 0, median: 0, p90: 0 }, km2: { p10: 0, median: 0, p90: 0 }, compact: { p10: 0, median: 0, p90: 0 }, border: { rail_river_main: 0, secondary: 0, local: 0, lane_stream: 0, none: 0 } },
    warnings: [],
  };
  const t = summaryText('Aroor', s);
  expect(t).toContain('1. Aroor / അരൂർ (100 houses)');
  expect(t).toContain('2. (no name found)');
  expect(t).toContain('1 + 2: both are small');
});
