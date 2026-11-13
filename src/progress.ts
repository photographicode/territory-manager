// How far a project is: which making steps are finished and which one comes next.
import type { Project, Stage } from './types';

export type StepId = 'boundary' | 'split' | 'review' | 'cards' | 'print' | 'poster';
export type StepState = 'done' | 'next' | 'todo';

export const STEPS: { id: StepId; label: string; hint: string }[] = [
  { id: 'boundary', label: 'Boundary', hint: 'Import the congregation outline' },
  { id: 'split', label: 'Split', hint: 'Divide it into territories' },
  { id: 'review', label: 'Review', hint: 'Check, merge and number' },
  { id: 'cards', label: 'Cards', hint: 'Names and landmarks' },
  { id: 'print', label: 'Print', hint: 'Territory card PDFs' },
  { id: 'poster', label: 'Full map', hint: 'Wall map, up to 2A0' },
];

/** Whether a step's work is finished. Printing has no lasting trace, so it counts as done once the cards are ready. */
export function isDone(id: StepId, p: Project): boolean {
  const named = p.territories.length > 0 && p.territories.every((t) => t.locality.trim());
  switch (id) {
    case 'boundary':
      // Territories imported directly also mean the outline is known.
      return Boolean(p.boundary) || p.territories.length > 0;
    case 'split':
      return p.territories.length > 0;
    case 'review':
      return p.finalized;
    case 'cards':
      return p.finalized && named;
    case 'print':
    case 'poster':
      return false;
  }
}

/** The first unfinished step, or 'print' once everything that can be checked is done. */
export function nextStep(p: Project): StepId {
  return STEPS.find((s) => s.id !== 'print' && s.id !== 'poster' && !isDone(s.id, p))?.id ?? 'print';
}

export function stepState(id: StepId, p: Project): StepState {
  if (isDone(id, p)) return 'done';
  return nextStep(p) === id ? 'next' : 'todo';
}

/** Share of the four checkable steps that are done, 0–1. */
export const completion = (p: Project) => (['boundary', 'split', 'review', 'cards'] as StepId[]).filter((id) => isDone(id, p)).length / 4;

/** Page to open when the app starts: the dashboard once there is anything to show, otherwise the first step. */
export const startPage = (p: Project): Stage => (p.boundary || p.territories.length ? 'dashboard' : 'boundary');
