import { describe, expect, it } from 'vitest';
import { arrangeLandmarks } from '../src/card/arrange';

const square = { type: 'Polygon' as const, coordinates: [[[77.43, 8.17], [77.44, 8.17], [77.44, 8.18], [77.43, 8.18], [77.43, 8.17]]] };

describe('arrange landmarks', () => {
  it('puts boxes beside the territory and apart from each other', () => {
    const marks = [
      { text: 'North gate', at: [77.435, 8.18] as [number, number], box: [77.435, 8.18] as [number, number] },
      { text: 'North shop', at: [77.436, 8.18] as [number, number], box: [77.436, 8.18] as [number, number] },
    ];
    const r = arrangeLandmarks(square, marks, () => [200, 52], 1190, 690, 0.15);
    expect(r.touching).toBe(0);
    for (const l of r.marks) expect(l.box[1]).toBeGreaterThan(8.18); // above the square's top edge
    expect(r.marks[0].box).not.toEqual(r.marks[1].box);
  });
});
