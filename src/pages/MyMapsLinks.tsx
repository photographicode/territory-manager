import { useEffect, useState } from 'react';
import type { PageProps } from '../App';

// The local helper (scripts/app.ts) drives Chrome to make the maps; a web page cannot do that itself.
const HELPER = location.port === '4747' ? '' : 'http://127.0.0.1:4747';

interface Job {
  running: boolean;
  total: number;
  failed: number;
  log: string[];
  links: Record<string, string>;
}

/** Makes one public Google My Maps map per territory and puts each map's link on its card's QR code. */
export default function MyMapsLinks({ project, update }: Pick<PageProps, 'project' | 'update'>) {
  const ts = project.territories;
  const done = ts.filter((t) => t.mapUrl).length;
  const [helper, setHelper] = useState<boolean | null>(null);
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    fetch(`${HELPER}/api/ping`, { signal: AbortSignal.timeout(2000) })
      .then((r) => setHelper(r.ok))
      .catch(() => setHelper(false));
  }, []);

  // While a job runs, fetch its progress and copy finished links onto the territories.
  const running = !!job?.running;
  useEffect(() => {
    if (!helper) return;
    let stop = false;
    const tick = async () => {
      const j: Job | null = await fetch(`${HELPER}/api/mymaps`)
        .then((r) => r.json())
        .catch(() => null);
      if (stop || !j) return;
      setJob(j);
      if (Object.keys(j.links).length)
        update((p) =>
          p.territories.some((t) => j.links[t.id] && t.mapUrl !== j.links[t.id])
            ? { ...p, territories: p.territories.map((t) => (j.links[t.id] ? { ...t, mapUrl: j.links[t.id] } : t)) }
            : p,
        );
    };
    void tick();
    const timer = running ? setInterval(tick, 2000) : undefined;
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [helper, running]);

  async function start() {
    const r = await fetch(`${HELPER}/api/mymaps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ territories: ts, congregation: project.settings.congregation }),
    });
    if (r.ok) setJob({ running: true, total: ts.length - done, failed: 0, log: ['Starting…'], links: {} });
    else alert((await r.json().catch(() => ({}))).error ?? 'Could not start');
  }

  const made = job ? Object.keys(job.links).length : 0;
  return (
    <section className="mymaps">
      <h3>Google My Maps links</h3>
      <p className="muted tiny">
        Each territory gets its own public My Maps map, named "number - locality | congregation". Its card's QR code then opens the map in Google
        Maps on the phone. {done} of {ts.length} territories have a link.
      </p>
      {helper === false && (
        <p className="warn">
          To make the maps from here, open Territory Manager with <b>Territory Manager.cmd</b> in the app folder (or <code>npm run app</code>).
        </p>
      )}
      {helper && !running && (
        <button className="btn primary" disabled={done === ts.length} onClick={start}>
          {done === ts.length ? 'Every territory has a link' : `Make links for ${ts.length - done} ${ts.length - done === 1 ? 'territory' : 'territories'}`}
        </button>
      )}
      {running && (
        <>
          <progress max={job!.total || 1} value={made} />
          <p className="tiny">
            {made} of {job!.total} maps made. A Chrome window does the work; leave it open.{' '}
            <button className="btn ghost" onClick={() => fetch(`${HELPER}/api/mymaps/stop`, { method: 'POST' })}>
              Stop after this map
            </button>
          </p>
        </>
      )}
      {job && job.log.length > 0 && <pre className="mymaps-log">{job.log.slice(-6).join('\n')}</pre>}
    </section>
  );
}
