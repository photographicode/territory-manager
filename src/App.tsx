import { useEffect, useState } from 'react';
import { listenForHandoff, type Incoming } from './handoff';
import { useProject, type ProjectApi } from './store';
import type { Stage } from './types';
import { Icon, type IconName } from './icons';
import { completion, startPage, stepState, STEPS } from './progress';
import Dashboard from './pages/Dashboard';
import BoundaryStep from './pages/BoundaryStep';
import SplitStep from './pages/SplitStep';
import ReviewStep from './pages/ReviewStep';
import CardEditor from './pages/CardEditor';
import CardsStep from './pages/CardsStep';
import PosterStep from './pages/PosterStep';
import TerritoriesPage from './pages/TerritoriesPage';
import SettingsPage from './pages/SettingsPage';

const MANAGE: { id: Stage; label: string; icon: IconName }[] = [
  { id: 'territories', label: 'Territories', icon: 'territories' },
  { id: 'backup', label: 'Backup', icon: 'backup' },
];

export default function App() {
  const api = useProject();
  const [page, setPage] = useState<Stage | null>(null);
  // A boundary file sent from the territory dashboard opens on the Boundary step.
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  useEffect(
    () =>
      listenForHandoff((i) => {
        setIncoming(i);
        setPage('boundary');
      }),
    [],
  );
  if (!api.project) return <div className="loading">Loading…</div>;
  const p = api.project;
  const current: Stage = page ?? startPage(p);
  const props = { ...(api as ProjectApi), go: setPage };
  const done = Math.round(completion(p) * 100);
  return (
    <div className="app">
      <aside className="side">
        <div className="side-brand">
          <span className="logo" aria-hidden="true">
            <Icon name="boundary" size={20} />
          </span>
          <div>
            <strong>Territory Studio</strong>
            <small>{p.settings.congregation ? `${p.settings.congregation} congregation` : 'New project'}</small>
          </div>
        </div>
        <nav className="side-nav" aria-label="Pages">
          <button className={current === 'dashboard' ? 'on' : ''} aria-current={current === 'dashboard' ? 'page' : undefined} onClick={() => setPage('dashboard')}>
            <Icon name="dashboard" />
            <span>Dashboard</span>
          </button>
          <p className="side-label">
            Create <span>{done}%</span>
          </p>
          <div className="side-progress" role="progressbar" aria-label="Project progress" aria-valuenow={done} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${done}%` }} />
          </div>
          {STEPS.map((s, i) => {
            const state = stepState(s.id, p);
            return (
              <button key={s.id} className={`step ${state}${s.id === current ? ' on' : ''}`} aria-current={s.id === current ? 'step' : undefined} onClick={() => setPage(s.id)}>
                <span className="step-dot">{state === 'done' ? <Icon name="check" size={14} /> : i + 1}</span>
                <span className="step-text">
                  {s.label}
                  <small>{state === 'done' ? 'Done' : s.hint}</small>
                </span>
              </button>
            );
          })}
          <p className="side-label">Manage</p>
          {MANAGE.map((t) => (
            <button key={t.id} className={t.id === current ? 'on' : ''} aria-current={t.id === current ? 'page' : undefined} onClick={() => setPage(t.id)}>
              <Icon name={t.icon} />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
      </aside>
      <main className="body">
        {current === 'dashboard' && <Dashboard {...props} />}
        {current === 'boundary' && <BoundaryStep {...props} incoming={incoming} />}
        {current === 'split' && <SplitStep {...props} />}
        {current === 'review' && <ReviewStep {...props} />}
        {current === 'cards' && <CardEditor {...props} />}
        {current === 'print' && <CardsStep {...props} />}
        {current === 'poster' && <PosterStep {...props} />}
        {current === 'territories' && <TerritoriesPage {...props} />}
        {current === 'backup' && <SettingsPage {...props} />}
      </main>
    </div>
  );
}

export type PageProps = ProjectApi & { go: (s: Stage) => void };
