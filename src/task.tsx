import { Component, createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/** Report progress: what is happening now, and how far along (0–1) when that is known. */
export type Report = (detail: string, fraction?: number) => void;

interface Running {
  label: string;
  detail: string;
  fraction?: number;
  started: number;
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
      setTask({ label, detail: '', started: Date.now(), ...(opts?.cancellable ? { cancel: () => ctrl.abort() } : {}) });
      const report: Report = (detail, fraction) => setTask((t) => t && { ...t, detail, fraction });
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

function TaskBar({ task }: { task: Running }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((now - task.started) / 1000));
  const elapsed = secs < 60 ? `${secs} s` : `${Math.floor(secs / 60)} min ${secs % 60} s`;
  const pct = task.fraction === undefined ? undefined : Math.round(Math.min(1, Math.max(0, task.fraction)) * 100);
  return (
    <div className="task-bar" role="status" aria-live="polite">
      <div className="task-head">
        <b>{task.label}</b>
        <span className="muted tiny">
          {pct !== undefined && `${pct}% · `}
          {elapsed}
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
      {task.detail && <div className="muted tiny task-detail">{task.detail}</div>}
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
