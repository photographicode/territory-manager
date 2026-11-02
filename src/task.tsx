import { Component, createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/** Report progress: what is happening now, how far along (0–1) when that is known, and the current stage. */
export type Report = (detail: string, fraction?: number, stage?: string) => void;

interface Running {
  label: string;
  detail: string;
  fraction?: number;
  stage?: string;
  started: number;
  /** When the job last reported anything; used to spot a job that has gone quiet. */
  updated: number;
  cancel?: () => void;
}
interface Failure {
  label: string;
  message: string;
  at: string;
}

interface TaskApi {
  busy: boolean;
  /** Run a slow job with the progress bar showing. Errors are shown in the error panel; returns undefined on failure or cancel. */
  run<T>(label: string, fn: (report: Report, signal: AbortSignal) => Promise<T> | T, opts?: { cancellable?: boolean }): Promise<T | undefined>;
  fail(label: string, err: unknown): void;
}

const Ctx = createContext<TaskApi>(null!);
export const useTask = () => useContext(Ctx);

export const message = (e: unknown) => (e instanceof Error ? e.message || e.name : String(e));
export const isCancel = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
/** Let the browser draw the progress bar before blocking work starts. */
export const nextPaint = () => new Promise<void>((r) => setTimeout(r, 30));

export function TaskProvider({ children }: { children: ReactNode }) {
  const [task, setTask] = useState<Running | null>(null);
  const [errors, setErrors] = useState<Failure[]>([]);
  const busyRef = useRef(false);

  const fail = useCallback((label: string, err: unknown) => {
    console.error(label, err);
    setErrors((e) => [...e.slice(-4), { label, message: message(err), at: new Date().toLocaleTimeString() }]);
  }, []);

  useEffect(() => {
    const onError = (e: ErrorEvent) => fail('Unexpected error', e.error ?? e.message);
    const onReject = (e: PromiseRejectionEvent) => !isCancel(e.reason) && fail('Unexpected error', e.reason);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onReject);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onReject);
    };
  }, [fail]);

  const run = useCallback<TaskApi['run']>(
    async (label, fn, opts) => {
      if (busyRef.current) return undefined;
      busyRef.current = true;
      const ctrl = new AbortController();
      setTask({ label, detail: '', started: Date.now(), updated: Date.now(), ...(opts?.cancellable ? { cancel: () => ctrl.abort() } : {}) });
      const report: Report = (detail, fraction, stage) => setTask((t) => t && { ...t, detail, fraction, stage: stage ?? t.stage, updated: Date.now() });
      try {
        await nextPaint();
        return await fn(report, ctrl.signal);
      } catch (e) {
        if (!isCancel(e) && !ctrl.signal.aborted) fail(label, e);
        return undefined;
      } finally {
        busyRef.current = false;
        setTask(null);
      }
    },
    [fail],
  );

  return (
    <Ctx.Provider value={{ busy: !!task, run, fail }}>
      <Boundary onCrash={fail}>{children}</Boundary>
      <div className="task-dock">
        {task && <TaskBar task={task} />}
        {errors.map((e, i) => (
          <div key={i} className="task-error" role="alert">
            <div>
              <b>{e.label} failed</b> <span className="muted tiny">at {e.at}</span>
              <div className="task-msg">{e.message}</div>
              <div className="muted tiny">Your saved work is safe. Try again, or reload the page if things look wrong.</div>
            </div>
            <button className="btn ghost" aria-label="Dismiss" onClick={() => setErrors((x) => x.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

const duration = (ms: number) => {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs} s`;
  const m = Math.floor(secs / 60);
  return m < 60 ? `${m} min ${secs % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const QUIET_MS = 30_000;

/** Time left from how fast the bar moved over the last couple of minutes (undefined until there is enough to go on). */
function useEstimate(task: Running, now: number) {
  const samples = useRef<{ t: number; f: number }[]>([]);
  const first = useRef<number>();
  const f = task.fraction;
  if (f !== undefined && samples.current[samples.current.length - 1]?.f !== f) samples.current.push({ t: task.updated, f });
  samples.current = samples.current.filter((s) => s.t > now - 120_000 || s === samples.current[samples.current.length - 1]);
  if (f === undefined || f < 0.02 || now - task.started < 5000) return {};
  const old = samples.current[0];
  const rate = old && f > old.f ? (f - old.f) / Math.max(1, now - old.t) : f / (now - task.started);
  const left = (1 - f) / rate;
  if (!first.current && f >= 0.1) first.current = now - task.started + left;
  return { left, total: first.current };
}

function TaskBar({ task }: { task: Running }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const elapsed = now - task.started;
  const quiet = now - task.updated;
  const pct = task.fraction === undefined ? undefined : Math.min(100, Math.max(0, task.fraction * 100));
  const { left, total } = useEstimate(task, now);
  const late = total !== undefined && elapsed > total * 1.5 + 30_000;
  return (
    <div className="task-bar" role="status" aria-live="polite">
      <div className="task-head">
        <b>{task.label}</b>
        <span className="muted tiny">
          {pct !== undefined && `${pct < 10 ? pct.toFixed(1) : Math.floor(pct)}% · `}
          {duration(elapsed)} so far
          {left !== undefined && pct! < 100 && ` · about ${duration(left)} left`}
        </span>
        {task.cancel && (
          <button className="btn ghost small-btn" onClick={task.cancel}>
            Cancel
          </button>
        )}
      </div>
      <div className={`progress${pct === undefined ? ' indeterminate' : ''}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div style={pct === undefined ? undefined : { width: `${pct}%` }} />
      </div>
      {task.stage && <div className="tiny task-stage">{task.stage}</div>}
      {task.detail && <div className="muted tiny task-detail">{task.detail}</div>}
      {quiet > QUIET_MS ? (
        <div className="tiny task-warn">
          No update for {duration(quiet)}. It may still be working on one very large piece{task.cancel ? '; you can Cancel and try again' : ''}.
        </div>
      ) : (
        late && <div className="tiny task-warn">Taking longer than first estimated ({duration(total!)}), but still making progress.</div>
      )}
    </div>
  );
}

/** Catches errors while drawing a page, so one broken screen shows a message instead of a blank app. */
class Boundary extends Component<{ children: ReactNode; onCrash: (label: string, e: unknown) => void }, { crashed: boolean }> {
  state = { crashed: false };
  static getDerivedStateFromError() {
    return { crashed: true };
  }
  componentDidCatch(e: unknown) {
    this.props.onCrash('Showing this page', e);
  }
  render() {
    if (this.state.crashed)
      return (
        <div className="page narrow">
          <h2>Something went wrong on this screen</h2>
          <p>Your saved work is safe. The error is shown below.</p>
          <button className="btn primary" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      );
    return this.props.children;
  }
}
