import { useState } from 'react';
import { useProject, type ProjectApi } from './store';
import type { Section, Stage } from './types';
import BoundaryStep from './pages/BoundaryStep';
import SplitStep from './pages/SplitStep';
import ReviewStep from './pages/ReviewStep';
import CardsStep from './pages/CardsStep';
import TerritoriesPage from './pages/TerritoriesPage';
import SettingsPage from './pages/SettingsPage';

type MakeStep = 'boundary' | 'split' | 'review';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'territories', label: 'Territories' },
  { id: 'print', label: 'Print cards' },
  { id: 'make', label: 'Make territories' },
  { id: 'backup', label: 'Backup' },
];
const STEPS: { id: MakeStep; label: string }[] = [
  { id: 'boundary', label: 'Boundary' },
  { id: 'split', label: 'Split' },
  { id: 'review', label: 'Review' },
];

export default function App() {
  const api = useProject();
  const [section, setSection] = useState<Section | null>(null);
  const [step, setStep] = useState<MakeStep | null>(null);
  if (!api.project) return <div className="loading">Loading…</div>;
  const p = api.project;
  const current: Section = section ?? (p.finalized ? 'territories' : 'make');
  const currentStep: MakeStep = step ?? (p.territories.length ? 'review' : p.boundary ? 'split' : 'boundary');

  const go = (s: Stage) => {
    if (s === 'boundary' || s === 'split' || s === 'review') {
      setSection('make');
      setStep(s);
    } else setSection(s === 'cards' ? 'print' : s === 'assign' ? 'territories' : 'backup');
  };
  const props = { ...(api as ProjectApi), go };
  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          Territory Manager{p.settings.congregation && <span className="cong"> · {p.settings.congregation}</span>}
        </div>
        <nav className="tabs">
          {SECTIONS.map((t) => (
            <button key={t.id} className={t.id === current ? 'on' : ''} onClick={() => setSection(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      {current === 'make' && (
        <nav className="stepper">
          {STEPS.map((s, i) => (
            <button key={s.id} className={s.id === currentStep ? 'on' : ''} onClick={() => setStep(s.id)}>
              <span className="dot">{i + 1}</span> {s.label}
            </button>
          ))}
          <span className="muted tiny step-hint">You only need to do this once. Afterwards, work from the Territories page.</span>
        </nav>
      )}
      <main className="body">
        {current === 'make' && currentStep === 'boundary' && <BoundaryStep {...props} />}
        {current === 'make' && currentStep === 'split' && <SplitStep {...props} />}
        {current === 'make' && currentStep === 'review' && <ReviewStep {...props} />}
        {current === 'print' && <CardsStep {...props} />}
        {current === 'territories' && <TerritoriesPage {...props} />}
        {current === 'backup' && <SettingsPage {...props} />}
      </main>
    </div>
  );
}

export type PageProps = ProjectApi & { go: (s: Stage) => void };
