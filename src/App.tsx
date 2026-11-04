import { useState } from 'react';
import { useProject, type ProjectApi } from './store';
import type { Stage } from './types';
import BoundaryStep from './pages/BoundaryStep';
import SplitStep from './pages/SplitStep';
import ReviewStep from './pages/ReviewStep';
import CardEditor from './pages/CardEditor';
import CardsStep from './pages/CardsStep';
import TerritoriesPage from './pages/TerritoriesPage';
import SettingsPage from './pages/SettingsPage';

// The work in the order it is done; printing comes last.
const STEPS: { id: Stage; label: string }[] = [
  { id: 'boundary', label: 'Boundary' },
  { id: 'split', label: 'Split' },
  { id: 'review', label: 'Review' },
  { id: 'cards', label: 'Cards' },
  { id: 'print', label: 'Print' },
];
const OTHER: { id: Stage; label: string }[] = [
  { id: 'territories', label: 'Territories' },
  { id: 'backup', label: 'Backup' },
];

export default function App() {
  const api = useProject();
  const [page, setPage] = useState<Stage | null>(null);
  if (!api.project) return <div className="loading">Loading…</div>;
  const p = api.project;
  const current: Stage = page ?? (p.finalized ? 'territories' : p.territories.length ? 'review' : p.boundary ? 'split' : 'boundary');
  const props = { ...(api as ProjectApi), go: setPage };
  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          Territory Manager{p.settings.congregation && <span className="cong"> · {p.settings.congregation}</span>}
        </div>
        <nav className="stepper" aria-label="Steps">
          {STEPS.map((s, i) => (
            <button key={s.id} className={s.id === current ? 'on' : ''} aria-current={s.id === current ? 'step' : undefined} onClick={() => setPage(s.id)}>
              <span className="dot">{i + 1}</span> {s.label}
            </button>
          ))}
        </nav>
        <nav className="tabs" aria-label="Pages">
          {OTHER.map((t) => (
            <button key={t.id} className={t.id === current ? 'on' : ''} onClick={() => setPage(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="body">
        {current === 'boundary' && <BoundaryStep {...props} />}
        {current === 'split' && <SplitStep {...props} />}
        {current === 'review' && <ReviewStep {...props} />}
        {current === 'cards' && <CardEditor {...props} />}
        {current === 'print' && <CardsStep {...props} />}
        {current === 'territories' && <TerritoriesPage {...props} />}
        {current === 'backup' && <SettingsPage {...props} />}
      </main>
    </div>
  );
}

export type PageProps = ProjectApi & { go: (s: Stage) => void };
