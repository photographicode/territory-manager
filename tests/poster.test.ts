import { describe, expect, it } from 'vitest';
import { neighbourColours } from '../src/card/poster';
import type { Area } from '../src/types';

const box = (x: number, y: number): Area => ({
  type: 'Polygon',
  coordinates: [[[x, y], [x + 0.01, y], [x + 0.01, y + 0.01], [x, y + 0.01], [x, y]]],
});

describe('full map colours', () => {
  it('gives touching territories different colours and reuses colours apart', () => {
    // 3 x 3 grid of touching squares.
    const grid = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => box(76.3 + c * 0.01, 9.9 + r * 0.01)));
    const col = neighbourColours(grid);
    const at = (r: number, c: number) => col[r * 3 + c];
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        if (c < 2) expect(at(r, c)).not.toBe(at(r, c + 1));
        if (r < 2) expect(at(r, c)).not.toBe(at(r + 1, c));
        if (r < 2 && c < 2) expect(at(r, c)).not.toBe(at(r + 1, c + 1)); // corners touch too
      }
    expect(neighbourColours([box(76, 9), box(77, 9)])).toEqual([0, 0]);
  });
});

import { assignGroups, compactNumbers, parseNumbers } from '../src/card/poster';

describe('territory groups', () => {
  const nums = ['1', '2', '3', '4', '5', '5a', '10', '12'];
  it('reads ranges, single numbers and lettered numbers', () => {
    expect(parseNumbers('1-3, 5a 12', nums)).toEqual({ matched: ['1', '2', '3', '5a', '12'], unknown: [] });
    expect(parseNumbers('4–5, 99', nums)).toEqual({ matched: ['4', '5', '5a'], unknown: ['99'] });
  });
  it('keeps a territory in its first group and reports clashes and unknowns', () => {
    const { of, problems } = assignGroups(nums, [
      { name: 'North', color: '#000', numbers: '1-4' },
      { name: 'South', color: '#fff', numbers: '4, 10, 77' },
    ]);
    expect(of).toEqual([0, 0, 0, 0, -1, -1, 1, -1]);
    expect(problems).toEqual(['South: no territory 77', 'Territory 4 is in North and South']);
  });
  it('writes number lists compactly', () => {
    expect(compactNumbers(['3', '1', '2', '5', '7a', '8', '9'])).toBe('1–3, 5, 7a, 8, 9');
    expect(compactNumbers(['10', '11', '12', '13'])).toBe('10–13');
  });
});
