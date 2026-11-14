// QR links: each card's QR can open a Google My Maps map of that territory instead of the built-in map page.
// Google has no way to make those maps for us, so this page hands out each territory's KML and collects the links.
import { useState } from 'react';
import type { PageProps } from '../App';
import { download, fileName, territoryKml } from '../geo/kml';
import { isGoogleMap, parseLinks, previewLink } from '../links';
import { safeUrl } from '../safe';
import type { Territory } from '../types';
import { byNumber } from './TerritoriesPage';

export default function LinksStep({ project, update }: PageProps) {
  const ts = [...project.territories].sort(byNumber);
  const [bulk, setBulk] = useState('');
  const [note, setNote] = useState('');
  const linked = ts.filter((t) => isGoogleMap(t.mapUrl)).length;
  const pasted = parseLinks(bulk);
  const setLink = (id: string, raw: string) =>
    update((p) => ({ ...p, territories: p.territories.map((x) => (x.id === id ? { ...x, mapUrl: previewLink(raw) || raw.trim() || undefined } : x)) }));

  function applyBulk() {
    const byNum = new Map(pasted.map((r) => [r.number, r.url]));
    const unknown = pasted.filter((r) => !ts.some((t) => t.number === r.number)).map((r) => r.number);
    update((p) => ({ ...p, territories: p.territories.map((x) => (byNum.has(x.number) ? { ...x, mapUrl: byNum.get(x.number) } : x)) }), true);
    const n = pasted.length - unknown.length;
    setNote(`${n} link${n === 1 ? '' : 's'} added.${unknown.length ? ` No territory numbered ${unknown.join(', ')}.` : ''}`);
    if (!unknown.length) setBulk('');
  }

  const kml = (t: Territory) => download(`${fileName(t)}.kml`, territoryKml(t, project.settings.congregation), 'application/vnd.google-earth.kml+xml');

  return (
    <div className="page">
      <div className="card-box">
        <h2>
          {linked} of {ts.length} cards open Google Maps
        </h2>
        <p className="muted">
          The rest open the built-in map page. Do this once the names and borders are final: each card's QR code changes to its link, on the screen and in the PDFs.
        </p>
        <ol className="muted tiny">
          <li>Press “KML” for a territory to download its outline.</li>
          <li>
            In{' '}
            <a href="https://www.google.com/maps/d/" target="_blank" rel="noopener">
              Google My Maps
            </a>
            , create a new map and import that file.
          </li>
          <li>Share the map as “Anyone with the link can view”, then copy its link (or the Preview link).</li>
          <li>Paste it next to the territory below. Edit links are turned into view links automatically.</li>
        </ol>
      </div>

      <div className="card-box">
        <label className="field" style={{ width: '100%' }}>
          <span>Paste many at once: one line per territory, the number then the link</span>
          <textarea rows={4} value={bulk} placeholder={'1 https://www.google.com/maps/d/viewer?mid=…\n2 https://www.google.com/maps/d/viewer?mid=…'} onChange={(e) => setBulk(e.target.value)} />
        </label>
        <button className="btn" disabled={!pasted.length} onClick={applyBulk}>
          Add {pasted.length || ''} links
        </button>
        {note && (
          <p className="muted tiny" aria-live="polite">
            {note}
          </p>
        )}
      </div>

      <table className="links-table">
        <thead>
          <tr>
            <th>No.</th>
            <th>Locality</th>
            <th>Outline</th>
            <th>Google My Maps link</th>
            <th>QR opens</th>
          </tr>
        </thead>
        <tbody>
          {ts.map((t) => {
            const url = safeUrl(t.mapUrl);
            const state = !t.mapUrl ? 'Built-in map' : !url ? 'Not a web address' : isGoogleMap(url) ? 'Google Maps' : 'Other site';
            return (
              <tr key={t.id}>
                <td>{t.number}</td>
                <td>{t.locality}</td>
                <td>
                  <button className="btn ghost" onClick={() => kml(t)}>
                    KML
                  </button>
                </td>
                <td>
                  <input aria-label={`Google My Maps link for territory ${t.number}`} value={t.mapUrl ?? ''} placeholder="https://www.google.com/maps/d/viewer?mid=…" onChange={(e) => setLink(t.id, e.target.value)} />
                </td>
                <td className={state === 'Not a web address' ? 'warn' : state === 'Google Maps' ? 'ok' : 'muted'}>
                  {url ? (
                    <a href={url} target="_blank" rel="noopener">
                      {state}
                    </a>
                  ) : (
                    state
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
