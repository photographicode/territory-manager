import { describe, expect, it } from 'vitest';
import { completion, isDone, nextStep, startPage, stepState } from '../src/progress';
import { newProject, type Area, type Project } from '../src/types';

const square: Area = { type: 'Polygon', coordinates: [[[76.3, 9.88], [76.31, 9.88], [76.31, 9.89], [76.3, 9.89], [76.3, 9.88]]] };
const territory = (locality: string) => ({ id: locality || 'x', number: '1', locality, geometry: square, buildings: 10 });
const project = (patch: Partial<Project>): Project => ({ ...newProject(), ...patch });

describe('project progress', () => {
  it('starts at the boundary on an empty project', () => {
    const p = newProject();
    expect(nextStep(p)).toBe('boundary');
    expect(stepState('boundary', p)).toBe('next');
    expect(startPage(p)).toBe('boundary');
    expect(completion(p)).toBe(0);
  });
  it('moves through split, review and cards', () => {
    const boundary = { type: 'Feature' as const, properties: {}, geometry: square };
    expect(nextStep(project({ boundary }))).toBe('split');
    expect(nextStep(project({ boundary, territories: [territory('')] }))).toBe('review');
    expect(nextStep(project({ boundary, territories: [territory('')], finalized: true }))).toBe('cards');
    const ready = project({ boundary, territories: [territory('Aroor')], finalized: true });
    expect(nextStep(ready)).toBe('print');
    expect(completion(ready)).toBe(1);
    expect(startPage(ready)).toBe('dashboard');
  });
  it('counts imported territories as a known boundary', () => {
    expect(isDone('boundary', project({ territories: [territory('A')] }))).toBe(true);
  });
});
