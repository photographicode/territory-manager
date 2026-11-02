import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import type { PageProps } from '../App';
import { cardsPdf } from '../card/render';
import { download, fileName, territoryKml } from '../geo/kml';
import { useTask } from '../task';
import { createMap, toLatLngs } from '../map';
import { STATUS_LABEL, statusOf, uid, type Assignment, type Territory, type TerritoryStatus } from '../types';

// Local calendar date (toISOString would give the UTC date, a day early in India before 5:30 am).
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const daysBetween = (a: string, b = today()) => Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000));
export const byNumber = (a: Territory, b: Territory) => a.number.localeCompare(b.number, undefined, { numeric: true });
const plural = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
const fmt = (d?: string) => (d ? new Date(d + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
type Filter = 'all' | TerritoryStatus;
const FILTERS: Filter[] = ['all', 'inuse', 'available', 'never', 'reserved'];

export default function TerritoriesPage(props: PageProps) {
  const { project, go } = props;
  const { territories, assignments } = project;
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const status = (t: Territory) => statusOf(t, assignments);
  const counts = Object.fromEntries(FILTERS.map((f) => [f, f === 'all' ? territories.length : territories.filter((t) => status(t) === f).length]));
  const active = (id: string) => assignments.find((a) => a.territoryId === id && !a.completedOn);
  const lastDone = (id: string) =>
    assignments
      .filter((a) => a.territoryId === id && a.completedOn)
      .map((a) => a.completedOn!)
      .sort()
      .pop();

  const s = q.trim().toLowerCase();
  const rows = [...territories].sort(byNumber).filter((t) => {
    if (filter !== 'all' && status(t) !== filter) return false;
    const a = active(t.id);
    return !s || t.number.toLowerCase() === s || t.locality.toLowerCase().includes(s) || !!a?.publisher.toLowerCase().includes(s) || !!t.reservation?.for.toLowerCase().includes(s);
  });

  function exportCsv() {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [['Terr. No.', 'Locality', 'Worked by', 'Given out', 'Returned', 'Days', 'Note'].join(',')];
    for (const t of [...territories].sort(byNumber))
      for (const a of assignments.filter((x) => x.territoryId === t.id).sort((x, y) => x.assignedOn.localeCompare(y.assignedOn)))
        lines.push(
          [t.number, t.locality, a.publisher, a.assignedOn, a.completedOn ?? '', a.completedOn ? String(daysBetween(a.assignedOn, a.completedOn)) : '', a.note ?? '']
            .map(esc)
            .join(','),
        );
    download('Territory work log.csv', '﻿' + lines.join('\n'), 'text/csv');
  }

  if (!territories.length)
    return (
      <div className="page narrow empty">
        <h2>No territories yet</h2>
        <p className="muted">Start by making territories from your congregation boundary. You only need to do this once.</p>
        <button className="btn primary big" onClick={() => go('boundary')}>
          Make territories
        </button>
      </div>
    );

  const open = territories.find((t) => t.id === openId);

  return (
    <div className={`terr-layout ${open ? 'with-detail' : ''}`}>
      <section className="terr-list">
        <div className="filters">
          {FILTERS.map((f) => (
            <button key={f} className={`chip ${f} ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : STATUS_LABEL[f]} <b>{counts[f]}</b>
            </button>
          ))}
        </div>
        <div className="toolbar">
          <input className="search" placeholder="Search number, locality or name" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn ghost" onClick={exportCsv}>
            Export log (CSV)
          </button>
        </div>
        <div className="tcards">
          {rows.map((t) => {
            const st = status(t);
            const a = active(t.id);
            const done = lastDone(t.id);
            return (
              <button key={t.id} className={`tcard ${openId === t.id ? 'on' : ''}`} onClick={() => setOpenId(openId === t.id ? null : t.id)}>
                <span className="tno">{t.number}</span>
                <span className="tmain">
                  <span className="tloc">{t.locality || <i className="muted">Unnamed</i>}</span>
                  <span className="tsub muted">
                    {st === 'inuse' && a && (
                      <>
                        {a.publisher} · {plural(daysBetween(a.assignedOn))}
                      </>
                    )}
                    {st === 'reserved' && t.reservation && <>For {t.reservation.for}</>}
                    {st === 'available' && done && <>Last worked {fmt(done)}</>}
                    {st === 'never' && <>Not worked yet</>}
                  </span>
                </span>
                <span className={`pill ${st} ${st === 'inuse' && a && daysBetween(a.assignedOn) > 120 ? 'late' : ''}`}>{STATUS_LABEL[st]}</span>
              </button>
            );
          })}
          {!rows.length && <p className="muted">No territories match.</p>}
        </div>
      </section>
      {open && <Detail key={open.id} t={open} {...props} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function Detail({ t, project, update, onClose }: PageProps & { t: Territory; onClose: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const { assignments, settings } = project;
  const log = assignments.filter((a) => a.territoryId === t.id).sort((a, b) => b.assignedOn.localeCompare(a.assignedOn));
  const st = statusOf(t, assignments);
  const current = log.find((a) => !a.completedOn);
  const people = [...new Set(assignments.map((a) => a.publisher).concat(project.territories.flatMap((x) => (x.reservation ? [x.reservation.for] : []))))].sort();
  const [form, setForm] = useState<null | 'assign' | 'reserve' | 'return'>(null);
  const [name, setName] = useState('');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const task = useTask();

  useEffect(() => {
    const m = createMap(el.current!);
    const poly = L.polygon(toLatLngs(t.geometry) as L.LatLngExpression[][], { color: '#a5281b', weight: 3, fillOpacity: 0.2 }).addTo(m);
    m.fitBounds(poly.getBounds(), { padding: [16, 16] });
    return () => void m.remove();
  }, [t.geometry]);

  const setAssignments = (fn: (a: Assignment[]) => Assignment[]) => update((p) => ({ ...p, assignments: fn(p.assignments) }));
  const patch = (x: Partial<Territory>) => update((p) => ({ ...p, territories: p.territories.map((y) => (y.id === t.id ? { ...y, ...x } : y)) }));
  const startForm = (f: 'assign' | 'reserve' | 'return') => {
    setForm(f);
    setName(f === 'assign' && t.reservation ? t.reservation.for : '');
    setDate(today());
    setNote('');
  };

  function submit() {
    if (form === 'return' && current) {
      setAssignments((all) => all.map((a) => (a.id === current.id ? { ...a, completedOn: date, note: note.trim() || a.note } : a)));
    } else if (form === 'assign') {
      if (!name.trim()) return;
      setAssignments((all) => [...all, { id: uid(), territoryId: t.id, publisher: name.trim(), assignedOn: date, ...(note.trim() ? { note: note.trim() } : {}) }]);
      patch({ reservation: undefined });
    } else if (form === 'reserve') {
      if (!name.trim()) return;
      patch({ reservation: { for: name.trim(), on: date, ...(note.trim() ? { note: note.trim() } : {}) } });
    }
    setForm(null);
  }

  async function pdf() {
    const bytes = await task.run(`Making card PDF for territory ${t.number}`, (report, signal) =>
      cardsPdf([t], settings, (n) => report(n ? 'Putting the PDF together…' : 'Drawing the card (loading its map)…', n), signal),
    );
    if (bytes) download(`${fileName(t)}.pdf`, bytes, 'application/pdf');
  }

  return (
    <aside className="detail">
      <div className="detail-head">
        <div>
          <div className="dno">Territory {t.number}</div>
          <div className="dloc">{t.locality || 'Unnamed locality'}</div>
        </div>
        <button className="btn ghost" onClick={onClose} aria-label="Close">
          Close
        </button>
      </div>
      <div className="dmap" ref={el} />
      <div className="dstatus">
        <span className={`pill ${st}`}>{STATUS_LABEL[st]}</span>
        {current && (
          <span>
            with <b>{current.publisher}</b> since {fmt(current.assignedOn)} ({plural(daysBetween(current.assignedOn))})
          </span>
        )}
        {st === 'reserved' && t.reservation && (
          <span>
            for <b>{t.reservation.for}</b> since {fmt(t.reservation.on)}
            {t.reservation.note && ` · ${t.reservation.note}`}
          </span>
        )}
        <span className="muted">· about {t.buildings} buildings</span>
      </div>

      {!form && (
        <div className="toolbar">
          {current ? (
            <button className="btn primary" onClick={() => startForm('return')}>
              Mark returned
            </button>
          ) : (
            <button className="btn primary" onClick={() => startForm('assign')}>
              {t.reservation ? `Give to ${t.reservation.for}` : 'Assign'}
            </button>
          )}
          {!current && !t.reservation && (
            <button className="btn" onClick={() => startForm('reserve')}>
              Reserve
            </button>
          )}
          {t.reservation && !current && (
            <button className="btn" onClick={() => patch({ reservation: undefined })}>
              Cancel reservation
            </button>
          )}
          <button className="btn" disabled={task.busy} onClick={pdf}>
            Card PDF
          </button>
        </div>
      )}
      {form && (
        <form
          className="dform"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <b>{form === 'assign' ? 'Assign to' : form === 'reserve' ? 'Reserve for' : `Returned by ${current?.publisher}`}</b>
          {form !== 'return' && (
            <input autoFocus list="tm-people" placeholder={form === 'reserve' ? 'Name, group or campaign' : 'Publisher name'} value={name} onChange={(e) => setName(e.target.value)} />
          )}
          <label className="field">
            <span>{form === 'return' ? 'Date returned' : 'Date'}</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="toolbar">
            <button className="btn primary" type="submit">
              Save
            </button>
            <button className="btn ghost" type="button" onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
          <datalist id="tm-people">
            {people.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </form>
      )}

      <h3>Work log</h3>
      {log.length ? (
        <table className="log">
          <thead>
            <tr>
              <th>Worked by</th>
              <th>Given out</th>
              <th>Returned</th>
              <th>Days</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {log.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.publisher}
                  {a.note && <div className="muted tiny">{a.note}</div>}
                </td>
                <td>{fmt(a.assignedOn)}</td>
                <td>{a.completedOn ? fmt(a.completedOn) : <span className="pill inuse">Still out</span>}</td>
                <td>{daysBetween(a.assignedOn, a.completedOn)}</td>
                <td>
                  <button className="link" onClick={() => confirm(`Remove this log entry (${a.publisher}, ${fmt(a.assignedOn)})?`) && setAssignments((all) => all.filter((x) => x.id !== a.id))}>
                    remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">Nobody has worked this territory yet.</p>
      )}

      <h3>Map link</h3>
      <p className="muted tiny">
        The QR code opens the online map page. To use Google My Maps instead (your usual way): download the KML, in My Maps choose <b>Create a new map → Import</b>,
        share it, and paste its link here.
      </p>
      <div className="toolbar">
        <button className="btn" onClick={() => download(`Territory ${t.number}.kml`, territoryKml(t, settings.congregation), 'application/vnd.google-earth.kml+xml')}>
          KML for My Maps
        </button>
      </div>
      <input
        className="wide"
        placeholder="Paste My Maps link (optional)"
        value={t.mapUrl ?? ''}
        onChange={(e) => patch({ mapUrl: e.target.value.trim() || undefined })}
      />
      <h3>Notes</h3>
      <textarea className="wide" rows={2} placeholder="e.g. dogs at house 12, gated colony" value={t.notes ?? ''} onChange={(e) => patch({ notes: e.target.value || undefined })} />
    </aside>
  );
}
