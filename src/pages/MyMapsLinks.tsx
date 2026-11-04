import { useEffect, useState } from 'react';
import type { PageProps } from '../App';
import { useTask } from '../task';

// The background helper (scripts/helper.ts) drives Chrome to make the maps; a web page cannot do that itself.
const HELPER = 'http://127.0.0.1:4747';

interface Job {
  running: boolean;
  total: number;
  failed: number;
  links: Record<string, string>;
}

/** Makes one public Google My Maps map per territory and puts each map's link on its card's QR code. */
export default function MyMapsLinks({ project, update }: Pick<PageProps, 'project' | 'update'>) {
  const ts = project.territories;
  const missing = ts.filter((t) => !t.mapUrl).length;
  const task = useTask();
  const [helper, setHelper] = useState<boolean | null>(null);
  const [result, setResult] = useState('');

  useEffect(() => {
    fetch(`${HELPER}/api/ping`, { signal: AbortSignal.timeout(2000) })
      .then((r) => setHelper(r.ok))
      .catch(() => setHelper(false));
  }, []);

  const applyLinks = (links: Record<string, string>) =>
    update((p) =>
      p.territories.some((t) => links[t.id] && t.mapUrl !== links[t.id])
        ? { ...p, territories: p.territories.map((t) => (links[t.id] ? { ...t, mapUrl: links[t.id] } : t)) }
        : p,
    );

  async function makeAll() {
    setResult('');
    const job = await task.run(
      'Making Google My Maps links',
      async (report, signal) => {
        report('Opening Chrome…', 0);
        const r = await fetch(`${HELPER}/api/mymaps`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ territories: ts, congregation: project.settings.congregation }),
        });
        // 409: a run is already going (e.g. started before the page was reloaded); follow that one.
        if (!r.ok && r.status !== 409) throw new Error((await r.json().catch(() => ({}))).error ?? 'The helper did not start');
        // Cancel stops after the map being made, so it is never left half-done.
        signal.addEventListener('abort', () => void fetch(`${HELPER}/api/mymaps/stop`, { method: 'POST' }), { once: true });
        for (;;) {
          await new Promise((ok) => setTimeout(ok, 2000));
          signal.throwIfAborted();
          const j: Job = await fetch(`${HELPER}/api/mymaps`).then((x) => x.json());
          applyLinks(j.links);
          const made = Object.keys(j.links).length;
          report(`${made} of ${j.total} maps made`, j.total ? made / j.total : 0);
          if (!j.running) return j;
        }
      },
      { cancellable: true },
    );
    if (job) {
      const made = Object.keys(job.links).length;
      setResult(job.failed ? `${made} maps made; ${job.failed} could not be made. Press the button again to retry them.` : `Done: ${made} maps made.`);
    }
  }

  return (
    <section className="mymaps">
      <h3>Google My Maps links</h3>
      <p className="muted tiny">
        Each territory gets its own public map in Google My Maps; its card's QR code opens it in Google Maps on the phone. {ts.length - missing} of{' '}
        {ts.length} territories have one.
      </p>
      {helper === false && <p className="warn">Open Territory Manager from its desktop or taskbar icon to make the maps.</p>}
      {helper && (
        <button className="btn primary" disabled={!missing || task.busy} onClick={makeAll}>
          {missing ? `Make maps for ${missing} ${missing === 1 ? 'territory' : 'territories'}` : 'Every territory has a map'}
        </button>
      )}
      {result && <p className="tiny">{result}</p>}
    </section>
  );
}
