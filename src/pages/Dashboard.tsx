import { useMemo } from 'react';
import type { PageProps } from '../App';
import { areaKm2, formatArea } from '../geo/core';
import { Icon } from '../icons';
import { completion, isDone, nextStep, STEPS, type StepId } from '../progress';
import { statusOf, STATUS_LABEL, type Territory, type TerritoryStatus } from '../types';

const byNumber = (a: Territory, b: Territory) => a.number.localeCompare(b.number, undefined, { numeric: true });
const NEXT_COPY: Record<StepId, { title: string; text: string; action: string }> = {
  boundary: { title: 'Import the congregation boundary', text: 'Start with the KML or KMZ outline of the whole congregation, for example exported from Google My Maps.', action: 'Import boundary' },
  split: { title: 'Split into territories', text: 'Roads, railways and water are downloaded from OpenStreetMap and used as territory borders.', action: 'Split now' },
  review: { title: 'Review the territories', text: 'Merge, cut and renumber until every territory is right, then confirm the review.', action: 'Open review' },
  cards: { title: 'Name every territory', text: 'Give each territory its locality name and add landmarks for the printed cards.', action: 'Open cards' },
  links: { title: 'Add Google My Maps links', text: 'Optional: give each card a Google My Maps link so its QR code opens that map.', action: 'Open QR links' },
  print: { title: 'Print the territory cards', text: 'Everything is ready. Print the cards, or make the full wall map.', action: 'Print cards' },
  poster: { title: 'Make the full map', text: 'One wall map with every territory, up to 2A0 at 300 dpi.', action: 'Open full map' },
};

export default function Dashboard({ project, go }: PageProps) {
  const p = project;
  const ts = useMemo(() => [...p.territories].sort(byNumber), [p.territories]);
  const { minBuildings: min, maxBuildings: max, congregation } = p.settings;
  const stats = useMemo(() => {
    const houses = ts.reduce((n, t) => n + t.buildings, 0);
    const km2 = ts.reduce((n, t) => n + areaKm2(t.geometry), 0);
    const usage = { never: 0, available: 0, inuse: 0, reserved: 0 } as Record<TerritoryStatus, number>;
    for (const t of ts) usage[statusOf(t, p.assignments)]++;
    return { houses, km2, usage };
  }, [ts, p.assignments]);
  const check = ts.filter((t) => t.needsCheck);
  const unnamed = ts.filter((t) => !t.locality.trim());
  const outside = ts.filter((t) => t.buildings && (t.buildings < min || t.buildings > max));
  const next = nextStep(p);
  const copy = NEXT_COPY[next];
  const pct = Math.round(completion(p) * 100);

  return (
    <div className="dash">
      <header className="dash-hero">
        <div>
          <p className="eyebrow">Territory project</p>
          <h1>{congregation ? `${congregation} congregation` : 'New territory project'}</h1>
          <p className="muted">
            {ts.length
              ? `${ts.length} territories · ${stats.houses.toLocaleString('en-IN')} houses · ${formatArea(stats.km2)}`
              : p.boundary
                ? 'Boundary imported. Next, split it into territories.'
                : 'From a boundary file to printed territory cards and a full wall map.'}
          </p>
        </div>
        <div className="ring" style={{ ['--pct' as string]: pct }} role="img" aria-label={`${pct}% of the making steps done`}>
          <span>
            {pct}
            <small>%</small>
          </span>
        </div>
      </header>

      <section className="next-card">
        <div className="next-icon">
          <Icon name={next} size={24} />
        </div>
        <div className="next-text">
          <p className="eyebrow">Next step</p>
          <h2>{copy.title}</h2>
          <p className="muted">{copy.text}</p>
        </div>
        <button className="btn primary big" onClick={() => go(next)}>
          {copy.action} <Icon name="arrow" size={16} />
        </button>
      </section>

      <ol className="journey" aria-label="Making steps">
        {STEPS.map((s, i) => {
          const done = isDone(s.id, p);
          return (
            <li key={s.id} className={done ? 'done' : s.id === next ? 'next' : ''}>
              <button onClick={() => go(s.id)}>
                <span className="j-dot">{done ? <Icon name="check" size={14} /> : i + 1}</span>
                <span className="j-label">{s.label}</span>
                <small>{done ? 'Done' : s.hint}</small>
              </button>
            </li>
          );
        })}
      </ol>

      {ts.length > 0 && (
        <>
          <div className="kpis">
            <Kpi label="Territories" value={ts.length.toString()} />
            <Kpi label="Houses" value={stats.houses.toLocaleString('en-IN')} note="buildings on OpenStreetMap" />
            <Kpi label="Average per territory" value={stats.houses ? Math.round(stats.houses / ts.length).toLocaleString('en-IN') : '—'} note={`target ${min}–${max} houses`} />
            <Kpi label="Ground area" value={formatArea(stats.km2)} note={`about ${formatArea(stats.km2 / ts.length)} each`} />
            <Kpi label="In use" value={stats.usage.inuse.toString()} note={`${stats.usage.available} available · ${stats.usage.never} never used`} />
          </div>

          <div className="dash-grid">
            <section className="panel-card">
              <div className="card-head">
                <h2>Houses per territory</h2>
                <span className="legend">
                  <i className="in" /> in range <i className="low" /> below {min} <i className="high" /> above {max}
                </span>
              </div>
              {stats.houses ? (
                <HouseChart ts={ts} min={min} max={max} />
              ) : (
                <p className="muted">House counts appear after the Split step downloads buildings from OpenStreetMap. Imported territories have none yet.</p>
              )}
            </section>

            <section className="panel-card">
              <div className="card-head">
                <h2>Needs attention</h2>
                <span className="muted tiny">{check.length + unnamed.length + outside.length ? 'Open Review to fix' : 'All clear'}</span>
              </div>
              <Attention icon="alert" label="Straight-line borders to check" items={check} onOpen={() => go('review')} />
              <Attention icon="cards" label="Without a locality name" items={unnamed} onOpen={() => go('cards')} />
              <Attention icon="split" label={`Outside ${min}–${max} houses`} items={outside} onOpen={() => go('review')} />
              {!check.length && !unnamed.length && !outside.length && (
                <p className="all-clear">
                  <Icon name="check" /> Every territory is named, sized and checked.
                </p>
              )}
            </section>
          </div>

          <section className="actions-row">
            <ActionTile icon="print" title="Territory cards" text="6 × 4 inch cards with map and QR code" onClick={() => go('print')} />
            <ActionTile icon="poster" title="Full wall map" text="Every territory on one map, up to 2A0" onClick={() => go('poster')} />
            <ActionTile icon="territories" title="Assignments" text={`${STATUS_LABEL.inuse}: ${stats.usage.inuse} · ${STATUS_LABEL.available}: ${stats.usage.available}`} onClick={() => go('territories')} />
            <ActionTile icon="backup" title="Backup" text="Download everything as one file" onClick={() => go('backup')} />
          </section>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function Attention({ icon, label, items, onOpen }: { icon: 'alert' | 'cards' | 'split'; label: string; items: Territory[]; onOpen: () => void }) {
  if (!items.length) return null;
  const shown = items.slice(0, 12);
  return (
    <button className="attention" onClick={onOpen}>
      <span className="att-icon">
        <Icon name={icon} />
      </span>
      <span className="att-body">
        <b>
          {items.length} {label.toLowerCase()}
        </b>
        <small>
          {shown.map((t) => t.number).join(', ')}
          {items.length > shown.length ? ` and ${items.length - shown.length} more` : ''}
        </small>
      </span>
      <Icon name="arrow" size={16} />
    </button>
  );
}

function ActionTile({ icon, title, text, onClick }: { icon: 'print' | 'poster' | 'territories' | 'backup'; title: string; text: string; onClick: () => void }) {
  return (
    <button className="action-tile" onClick={onClick}>
      <span className="tile-icon">
        <Icon name={icon} size={22} />
      </span>
      <b>{title}</b>
      <small>{text}</small>
    </button>
  );
}

/** One bar per territory in number order, coloured by whether its house count is in the wanted range. */
function HouseChart({ ts, min, max }: { ts: Territory[]; min: number; max: number }) {
  const W = 640;
  const H = 180;
  const top = Math.max(max * 1.15, ...ts.map((t) => t.buildings), 1);
  const y = (v: number) => H - (v / top) * H;
  const bw = W / ts.length;
  const below = ts.filter((t) => t.buildings < min).length;
  const above = ts.filter((t) => t.buildings > max).length;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label={`Houses per territory: ${ts.length - below - above} in range, ${below} below ${min}, ${above} above ${max}`}>
      <rect x={0} y={y(max)} width={W} height={y(min) - y(max)} className="band" />
      {ts.map((t, i) => (
        <rect key={t.id} x={i * bw + bw * 0.15} y={y(t.buildings)} width={Math.max(1, bw * 0.7)} height={H - y(t.buildings)} rx={Math.min(3, bw * 0.2)} className={t.buildings < min ? 'low' : t.buildings > max ? 'high' : 'in'}>
          <title>{`Territory ${t.number}${t.locality ? ` · ${t.locality}` : ''}: ${t.buildings} houses`}</title>
        </rect>
      ))}
      <line x1={0} x2={W} y1={H} y2={H} className="axis" />
      <text x={0} y={H + 14} className="tick">
        {ts[0]?.number}
      </text>
      <text x={W} y={H + 14} className="tick" textAnchor="end">
        {ts[ts.length - 1]?.number}
      </text>
    </svg>
  );
}
