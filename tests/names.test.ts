import { describe, expect, it } from 'vitest';
import { applyNames } from '../src/names';
import { parseNames } from '../src/handoff';
import { newProject, type Territory } from '../src/types';

const t = (number: string): Territory => ({ id: 't' + number, number, locality: 'Old ' + number, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, buildings: 0 });

describe('names from the congregation', () => {
  it('sets localities and up to four landmarks by territory number', () => {
    const p = { ...newProject(), territories: [t('1'), t('2')] };
    const points = [1, 2, 3, 4, 5].map((i) => ({ name: 'J' + i, lng: 77 + i / 100, lat: 8 }));
    const r = applyNames(p, [{ number: '1', locality: 'Market Road', points }, { number: '9', locality: 'Nowhere', points: [] }]);
    expect(r.project.territories[0].locality).toBe('Market Road');
    expect(r.project.territories[0].landmarks?.map((l) => l.text)).toEqual(['J1', 'J2', 'J3', 'J4']);
    expect(r.project.territories[1].locality).toBe('Old 2');
    expect(r.missing).toEqual(['9']);
  });
  it('keeps the arranged box of a renamed card landmark', () => {
    const old = { ...t('1'), landmarks: [{ text: 'Agri Field', at: [77.005, 8.005] as [number, number], box: [77.02, 8.02] as [number, number] }] };
    const r = applyNames({ ...newProject(), territories: [old] }, [{ number: '1', locality: 'Seethapal', points: [{ name: 'Paddy Field', lng: 77.005, lat: 8.005 }, { name: 'New', lng: 77.1, lat: 8.1 }] }]);
    expect(r.project.territories[0].landmarks).toEqual([
      { text: 'Paddy Field', at: [77.005, 8.005], box: [77.02, 8.02] },
      { text: 'New', at: [77.1, 8.1], box: [77.1, 8.1] },
    ]);
  });
  it('accepts names only from a trusted origin and drops unnamed points', () => {
    const data = { type: 'tm-names', names: [{ number: '3', locality: ' Hill ', points: [{ name: '', lng: 1, lat: 2 }, { name: 'Gate', lng: 1, lat: 2 }] }] };
    expect(parseNames({ origin: 'https://evil.example', data })).toBeNull();
    expect(parseNames({ origin: 'https://territory.congregationassistant.com', data })).toEqual([{ number: '3', locality: 'Hill', points: [{ name: 'Gate', lng: 1, lat: 2 }] }]);
  });
});
