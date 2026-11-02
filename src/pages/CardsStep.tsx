import { useEffect, useRef, useState } from 'react';
import type { PageProps } from '../App';
import { cardsPdf, qrLink, renderCard, viewerUrl } from '../card/render';
import { zipSync } from 'fflate';
import { download, fileName } from '../geo/kml';
import type { Settings, Territory } from '../types';
import { useTask, type Report } from '../task';
import KmlExport from './KmlExport';

const byNumber = (a: { number: string }, b: { number: string }) => a.number.localeCompare(b.number, undefined, { numeric: true });

export default function CardsStep({ project, update }: PageProps) {
  const s = project.settings;
  const ts = [...project.territories].sort(byNumber);
  const [current, setCurrent] = useState(ts[0]?.id ?? '');
  const task = useTask();
  const busy = task.busy;
  const preview = useRef<HTMLDivElement>(null);
  const t = ts.find((x) => x.id === current) ?? ts[0];
  const set = (patch: Partial<Settings>) => update((p) => ({ ...p, settings: { ...p.settings, ...patch } }));
  const base = `Territory Cards${s.congregation ? ` - ${s.congregation}` : ''}`;
  const local = /^(https?:\/\/)?(localhost|127\.|\[::1\])/.test(viewerUrl(s));

  useEffect(() => {
    if (!t) return;
    let stale = false;
    const timer = setTimeout(() => {
      renderCard(t, s).then((c) => {
        if (stale || !preview.current) return;
        c.className = 'card-preview';
        preview.current.replaceChildren(c);
      });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [t, s]);

  const make = (list: Territory[], report: Report, signal: AbortSignal) =>
    cardsPdf(
      list,
      s,
      (n, total) => report(n < total ? `Drawing card ${n + 1} of ${total} (loading its map)…` : 'Putting the PDF together…', n / total),
      signal,
    );

  /** Open the PDF in a new tab for printing; the tab is opened first so pop-up blockers allow it. */
  async function openPdf(list: Territory[]) {
    const win = window.open('', '_blank');
    const bytes = await task.run(`Making PDF of ${list.length === 1 ? 'the card' : `${list.length} cards`}`, (r, sig) => make(list, r, sig), {
      cancellable: true,
    });
    if (!bytes) return void win?.close();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    if (win) win.location.href = url;
    else download(`${base}.pdf`, bytes, 'application/pdf');
  }

  async function pdf(list: Territory[], name: string) {
    const bytes = await task.run(`Making PDF of ${list.length === 1 ? 'the card' : `${list.length} cards`}`, (r, sig) => make(list, r, sig), {
      cancellable: true,
    });
    if (bytes) download(name, bytes, 'application/pdf');
  }

  async function separatePdfs() {
    const files = await task.run(
      `Making ${ts.length} separate PDFs`,
      async (report, signal) => {
        const out: Record<string, Uint8Array> = {};
        for (const [i, x] of ts.entries()) {
          report(`Card ${i + 1} of ${ts.length}: Territory ${x.number}`, i / ts.length);
          out[`${fileName(x)}.pdf`] = await cardsPdf([x], s, undefined, signal);
        }
        report('Packing the ZIP file…', 1);
        return zipSync(out, { level: 0 });
      },
      { cancellable: true },
    );
    if (files) download(`${base} (separate PDFs).zip`, files, 'application/zip');
  }

  if (!t) return <div className="page">No territories yet.</div>;

  return (
    <div className="split-layout cards">
      <aside className="panel">
        <h2>Print cards</h2>
        <label className="field">
          <span>Card title</span>
          <input value={s.cardTitle} onChange={(e) => set({ cardTitle: e.target.value })} />
        </label>
        <div className="row">
          <label className="field">
            <span>Locality label</span>
            <input value={s.localityLabel} onChange={(e) => set({ localityLabel: e.target.value })} />
          </label>
          <label className="field">
            <span>Number label</span>
            <input value={s.numberLabel} onChange={(e) => set({ numberLabel: e.target.value })} />
          </label>
        </div>
        <label className="field">
          <span>Instructions printed at the bottom (any language)</span>
          <textarea rows={4} value={s.footerText} onChange={(e) => set({ footerText: e.target.value })} />
        </label>
        <label className="field">
          <span>Map page address in QR codes (leave empty to use this site)</span>
          <input value={s.viewerUrl} placeholder={viewerUrl(s)} onChange={(e) => set({ viewerUrl: e.target.value.trim() })} />
        </label>
        {local && (
          <p className="warn">
            This address only works on this computer. Publish the app (for example on GitHub Pages) and enter its <code>view.html</code> address
            here before printing, so phones can open the QR codes.
          </p>
        )}
        <h3>Print</h3>
        <div className="dl-list">
          <button className="btn primary" disabled={!!busy} onClick={() => openPdf(ts)}>
            Open PDF of all {ts.length} cards
          </button>
          <button className="btn" disabled={!!busy} onClick={() => openPdf([t])}>
            Open PDF of the card shown
          </button>
        </div>
        <h3>Download</h3>
        <div className="dl-list">
          <button className="btn" disabled={!!busy} onClick={() => pdf(ts, `${base}.pdf`)}>
            All {ts.length} cards in one PDF
          </button>
          <button className="btn" disabled={!!busy} onClick={separatePdfs}>
            Each card as its own PDF (ZIP)
          </button>
          <button className="btn" disabled={!!busy} onClick={() => pdf([t], `${fileName(t)}.pdf`)}>
            Only the card shown
          </button>
        </div>
        <h3>Google My Maps</h3>
        <p className="muted tiny">
          One KML per territory: import each into its own My Maps map, share it, and paste the link on the territory's page so its QR opens My Maps.
        </p>
        <KmlExport territories={ts} congregation={s.congregation} />
      </aside>
      <div className="preview-pane">
        <div className="toolbar">
          <select value={t.id} onChange={(e) => setCurrent(e.target.value)}>
            {ts.map((x) => (
              <option key={x.id} value={x.id}>
                {x.number} · {x.locality || 'Unnamed'}
              </option>
            ))}
          </select>
          <a className="btn ghost" href={qrLink(t, s)} target="_blank" rel="noopener">
            Open QR link
          </a>
        </div>
        <div ref={preview} className="preview-box">
          <p className="muted">Rendering…</p>
        </div>
        <p className="muted tiny">6 × 4 inch card at 300 dpi. Map © OpenStreetMap contributors, OpenFreeMap.</p>
      </div>
    </div>
  );
}
