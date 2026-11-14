// Frames every making step: what to do on this step, a locked screen when an earlier step is unfinished,
// and Back / Next at the bottom. Next opens only once the step is really done, so the work goes in order.
import type { ReactNode } from 'react';
import { Icon } from './icons';
import { blockedBy, isDone, STEPS, todo, type StepId } from './progress';
import type { Project, Stage } from './types';

export default function StepFrame({ step, project, go, children }: { step: StepId; project: Project; go: (s: Stage) => void; children: ReactNode }) {
  const i = STEPS.findIndex((s) => s.id === step);
  const s = STEPS[i];
  const prev = STEPS[i - 1];
  const next = STEPS[i + 1];
  const lock = blockedBy(step, project);
  const done = isDone(step, project);
  // QR links are optional and printing leaves no record, so their Next is always open.
  const canGoOn = done || step === 'links' || step === 'print' || step === 'poster';
  const left = canGoOn ? '' : todo(step, project);
  return (
    <div className="frame">
      <header className="guide">
        <span className={`guide-dot${done ? ' done' : ''}`}>{done ? <Icon name="check" size={16} /> : i + 1}</span>
        <div className="guide-text">
          <p className="eyebrow">
            Step {i + 1} of {STEPS.length}
            {done && <span className="guide-done"> · Done</span>}
          </p>
          <h1>{s.label}</h1>
          <p className="muted">{s.guide}</p>
        </div>
      </header>
      <div className="frame-body">{lock ? <Locked step={step} need={lock} project={project} go={go} /> : children}</div>
      {!lock && (
        <footer className="guide-foot">
          <button className="btn ghost" onClick={() => go(prev ? prev.id : 'dashboard')}>
            ← {prev ? prev.label : 'Dashboard'}
          </button>
          <span className={`guide-left${left ? '' : ' ok'}`} aria-live="polite">
            {left || (next ? `Ready for ${next.label}.` : 'All steps finished.')}
          </span>
          {next ? (
            <button className="btn primary" disabled={!canGoOn} title={left || undefined} onClick={() => go(next.id)}>
              Next: {next.label} <Icon name="arrow" size={16} />
            </button>
          ) : (
            <button className="btn primary" onClick={() => go('dashboard')}>
              Finish <Icon name="check" size={16} />
            </button>
          )}
        </footer>
      )}
    </div>
  );
}

function Locked({ step, need, project, go }: { step: StepId; need: StepId; project: Project; go: (s: Stage) => void }) {
  const n = STEPS.findIndex((s) => s.id === need);
  const label = STEPS[STEPS.findIndex((s) => s.id === step)].label;
  return (
    <div className="locked">
      <span className="locked-icon">
        <Icon name={need} size={28} />
      </span>
      <h2>Finish step {n + 1} first</h2>
      <p className="muted">
        {label} opens after <b>{STEPS[n].label}</b>. {todo(need, project)}
      </p>
      <button className="btn primary big" onClick={() => go(need)}>
        Go to step {n + 1}: {STEPS[n].label} <Icon name="arrow" size={16} />
      </button>
    </div>
  );
}
