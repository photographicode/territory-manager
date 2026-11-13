// How far a project is: which making steps are finished and which one comes next.
import type { Project, Stage } from './types';

export type StepId = 'boundary' | 'split' | 'review' | 'cards' | 'print' | 'poster';
export type StepState = 'done' | 'next' | 'todo';

export const STEPS: { id: StepId; label: string; hint: string; guide: string }[] = [
  { id: 'boundary', label: 'Boundary', hint: 'Import the congregation outline', guide: 'Choose the KML or KMZ file of the whole congregation area, then use it as the boundary.' },
  { id: 'split', label: 'Split', hint: 'Divide it into territories', guide: 'Download roads and buildings, choose how many territories or houses each, then split.' },
  { id: 'review', label: 'Review', hint: 'Check, merge and number', guide: 'Merge, cut or adjust territories until each is right, renumber, then press Finish review.' },
  { id: 'cards', label: 'Cards', hint: 'Names and landmarks', guide: 'Give every territory its locality name and add landmark boxes where they help.' },
  { id: 'print', label: 'Print', hint: 'Territory card PDFs', guide: 'Set the card text and download the PDF of all cards.' },
  { id: 'poster', label: 'Full map', hint: 'Wall map, up to 2A0', guide: 'Choose colours, groups and paper size, then download the wall map PDF.' },
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

/** Each step needs the one before it, so the work is done in order. Printing needs named, reviewed territories. */
const REQUIRES: Record<StepId, StepId | null> = { boundary: null, split: 'boundary', review: 'split', cards: 'review', print: 'cards', poster: 'cards' };

/** The earliest unfinished step that `id` depends on, or null when `id` can be worked on now. */
export function blockedBy(id: StepId, p: Project): StepId | null {
  const need = REQUIRES[id];
  if (!need) return null;
  return blockedBy(need, p) ?? (isDone(need, p) ? null : need);
}

/** What still has to happen before a step counts as done, in plain words. */
export function todo(id: StepId, p: Project): string {
  const unnamed = p.territories.filter((t) => !t.locality.trim()).length;
  switch (id) {
    case 'boundary':
      return 'Import the congregation boundary (KML or KMZ).';
    case 'split':
      return 'Download the map data and split the boundary into territories.';
    case 'review':
      return 'Check every territory, then press "Finish review".';
    case 'cards':
      return p.finalized ? `${unnamed} ${unnamed === 1 ? 'territory still needs' : 'territories still need'} a locality name.` : 'Finish the review first.';
    case 'print':
    case 'poster':
      return '';
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
