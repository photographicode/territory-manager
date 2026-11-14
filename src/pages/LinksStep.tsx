// QR links: each card's QR can open a Google My Maps map of that territory instead of the built-in map page.
// Google has no way to make those maps for us, so this page hands out each territory's KML and collects the links.
import { useState } from 'react';
import type { PageProps } from '../App';
import { compactNumbers } from '../card/poster';
import { download, fileName, territoryKml } from '../geo/kml';
import { isGoogleMap, parseLinks, previewLink } from '../links';
import { safeUrl } from '../safe';
import type { Territory } from '../types';
import { byNumber } from './TerritoriesPage';

export default function LinksStep({ project, update }: PageProps) {
  const ts = [...project.territories].sort(byNumber);
  const [bulk, setBulk] = useState('');
  const [note, setNote] = useState('');
  const [final, setFinal] = useState(false);
  const [copied, setCopied] = useState('');
  const missing = ts.filter((t) => !isGoogleMap(t.mapUrl));
  // Claude Code has the territory-links skill; this prompt starts it with what it needs to know.
  const prompt = `/territory-links Make the Google My Maps for the ${missing.length} territories in Territory Studio (generator.congregationassistant.com) that have no Google link yet: ${compactNumbers(missing.map((t) => t.number))}. The locality names are final.`;
  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied('Copied. Paste it into Claude Code and press Enter.');
    } catch {
      setCopied('Could not copy automatically: select the text below and copy it.');
    }
  }
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

      {missing.length > 0 && (
        <div className="card-box">
          <h3>Let Claude make the maps</h3>
          <p className="muted tiny">Claude opens Google My Maps in your Chrome, makes one shared map per territory and fills in the links here. Close every other tab of this app first.</p>
          <label className="check">
            <input type="checkbox" checked={final} onChange={(e) => setFinal(e.target.checked)} />
            <span>The locality names are final (maps are titled with them)</span>
          </label>
          <button className="btn primary" disabled={!final} onClick={copyPrompt}>
            Copy the prompt for Claude ({missing.length} maps)
          </button>
          {copied && (
            <>
              <p className="muted tiny" aria-live="polite">
                {copied}
              </p>
              <textarea readOnly rows={3} value={prompt} style={{ width: '100%' }} onFocus={(e) => e.currentTarget.select()} />
            </>
          )}
        </div>
      )}

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
