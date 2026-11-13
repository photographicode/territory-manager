import { useEffect, useMemo, useRef } from 'react';
import type { PageProps } from '../App';
import { assignGroups, defaultPoster, GROUP_COLOURS, PAPERS, posterLink, posterPdf, renderPosterPreview, type Paper, type PosterOptions, type TerritoryGroup } from '../card/poster';
import { mergeAreas } from '../geo/core';
import { download } from '../geo/kml';
import { useTask } from '../task';

export default function PosterStep({ project, update }: PageProps) {
  const s = project.settings;
  const opt = { ...defaultPoster(), ...s.poster };
  const ts = project.territories;
  const task = useTask();
  const preview = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<PosterOptions>) => update((p) => ({ ...p, settings: { ...p.settings, poster: { ...opt, ...patch } } }));
  // The outer line: the imported boundary, or all territories joined when there is none.
  const boundary = useMemo(() => project.boundary?.geometry ?? (ts.length ? mergeAreas(ts.map((t) => t.geometry)) : undefined), [project.boundary, ts]);
  const name = `Territory Map${s.congregation ? ` - ${s.congregation}` : ''} (${opt.paper})`;

  useEffect(() => {
    if (!ts.length || !boundary) return;
    let stale = false;
    const timer = setTimeout(() => {
      renderPosterPreview(ts, boundary, s, opt).then((c) => {
        if (stale || !preview.current) return;
        c.className = 'card-preview';
        preview.current.replaceChildren(c);
      });
    }, 400);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [ts, boundary, s]); // the options live in s

  async function make() {
    const bytes = await task.run(
      `Making the ${opt.paper} map`,
      (report, signal) =>
        posterPdf(ts, boundary!, s, opt, (n, total) => report(n < total ? `Drawing part ${n + 1} of ${total}…` : 'Putting the PDF together…', n / total), signal),
      { cancellable: true },
    );
    if (bytes) download(`${name}.pdf`, bytes, 'application/pdf');
  }

  if (!ts.length || !boundary) return <div className="page">No territories yet.</div>;
  const [a, b] = PAPERS[opt.paper];

  return (
    <div className="split-layout cards">
      <aside className="panel">
        <h2>Full map</h2>
        <p className="muted tiny">One wall map of all {ts.length} territories, with each number in the middle of its territory.</p>
        <label className="field">
          <span>Congregation name (printed in the title box)</span>
          <input value={s.congregation} onChange={(e) => update((p) => ({ ...p, settings: { ...p.settings, congregation: e.target.value } }))} />
        </label>
        <label className="field">
          <span>Paper size (300 dpi; the page turns to fit the map)</span>
          <select value={opt.paper} onChange={(e) => set({ paper: e.target.value as Paper })}>
            {(Object.keys(PAPERS) as Paper[]).map((p) => (
              <option key={p} value={p}>
                {p} – {PAPERS[p][0]} × {PAPERS[p][1]} mm{p === '2A0' ? ' (largest)' : ''}
              </option>
            ))}
          </select>
        </label>
        <h3>Colours</h3>
        <label className="check">
          <input type="radio" name="poster-colour" checked={!opt.byGroup && opt.colorful} onChange={() => set({ colorful: true, byGroup: false })} />
          <span>Colourful (neighbours always differ)</span>
        </label>
        <label className="check">
          <input type="radio" name="poster-colour" checked={!opt.byGroup && !opt.colorful} onChange={() => set({ colorful: false, byGroup: false })} />
          <span>One colour</span>
          <input type="color" value={opt.color} disabled={opt.byGroup || opt.colorful} onChange={(e) => set({ color: e.target.value })} aria-label="Territory colour" />
        </label>
        <label className="check">
          <input type="radio" name="poster-colour" checked={opt.byGroup} onChange={() => set({ byGroup: true })} />
          <span>By group (outline and legend for each group)</span>
        </label>
        {opt.byGroup && <GroupEditor groups={opt.groups} numbers={ts.map((t) => t.number)} onChange={(groups) => set({ groups })} />}
        <label className="field">
          <span>Number size: {Math.round(opt.numberScale * 100)}%</span>
          <input type="range" min={0.4} max={3} step={0.1} value={opt.numberScale} onChange={(e) => set({ numberScale: Number(e.target.value) })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={opt.names} onChange={(e) => set({ names: e.target.checked })} />
          <span>Locality name under each number</span>
        </label>
        <h3>Extras</h3>
        <label className="check">
          <input type="checkbox" checked={opt.frame} onChange={(e) => set({ frame: e.target.checked })} />
          <span>Border around the page</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={opt.qr} onChange={(e) => set({ qr: e.target.checked })} />
          <span>QR code</span>
        </label>
        {opt.qr && (
          <label className="field">
            <span>QR opens (leave empty for the congregation outline, or paste a Google My Maps link of all territories)</span>
            <input value={opt.link} placeholder="https://www.google.com/maps/d/…" onChange={(e) => set({ link: e.target.value })} />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={opt.compass} onChange={(e) => set({ compass: e.target.checked })} />
          <span>North arrow</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={opt.scaleBar} onChange={(e) => set({ scaleBar: e.target.checked })} />
          <span>Scale bar</span>
        </label>
        <h3>Download</h3>
        <button className="btn primary" disabled={task.busy} onClick={make}>
          Download {opt.paper} PDF
        </button>
        <p className="muted tiny">
          Drawn piece by piece at 300 dpi, so it takes a few minutes. Keep this tab in front until it finishes. Prints sharp at {opt.paper} ({a} × {b} mm) or
          any smaller size.
        </p>
      </aside>
      <div className="preview-pane">
        <div className="toolbar">
          {opt.qr && (
            <a className="btn ghost" href={posterLink(s, opt, boundary)} target="_blank" rel="noopener">
              Open QR link
            </a>
          )}
        </div>
        <div ref={preview} className="preview-box">
          <p className="muted">Rendering…</p>
        </div>
        <p className="muted tiny">Preview only. The PDF has far more map detail (street and place names).</p>
      </div>
    </div>
  );
}

/** Groups of territories (e.g. field service groups): a name, a colour and the territory numbers, typed as "1-12, 15". */
function GroupEditor({ groups, numbers, onChange }: { groups: TerritoryGroup[]; numbers: string[]; onChange: (g: TerritoryGroup[]) => void }) {
  const { of, problems } = assignGroups(numbers, groups);
  const left = numbers.filter((_, i) => of[i] === -1);
  const edit = (i: number, patch: Partial<TerritoryGroup>) => onChange(groups.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  return (
    <div className="card-box group-editor">
      {groups.map((g, i) => (
        <div key={i} className="group-row">
          <input type="color" value={g.color} onChange={(e) => edit(i, { color: e.target.value })} aria-label={`Colour of ${g.name || `group ${i + 1}`}`} />
          <input value={g.name} placeholder={`Group ${i + 1}`} maxLength={60} onChange={(e) => edit(i, { name: e.target.value })} aria-label="Group name" />
          <input value={g.numbers} placeholder="e.g. 1-12, 15" onChange={(e) => edit(i, { numbers: e.target.value })} aria-label={`Territories in ${g.name || `group ${i + 1}`}`} />
          <button className="btn ghost" onClick={() => onChange(groups.filter((_, j) => j !== i))} aria-label={`Remove ${g.name || `group ${i + 1}`}`}>
            ✕
          </button>
        </div>
      ))}
      <button className="btn" onClick={() => onChange([...groups, { name: '', color: GROUP_COLOURS[groups.length % GROUP_COLOURS.length], numbers: '' }])}>
        + Add group
      </button>
      {problems.map((p) => (
        <p key={p} className="warn tiny">
          {p}
        </p>
      ))}
      {groups.length > 0 && <p className="muted tiny">{left.length ? `Not in any group (shown grey): ${left.length}` : 'Every territory is in a group.'}</p>}
    </div>
  );
}
