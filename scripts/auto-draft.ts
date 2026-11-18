// Makes the automatic first draft for a territory request. Run by .github/workflows/auto-draft.yml when the
// request form stores a boundary file (Supabase sends a repository_dispatch), or by hand for a local file:
//   npx tsx scripts/auto-draft.ts <request-id>          (needs SUPABASE_URL, SUPABASE_ANON_KEY, TM_AUTO_SECRET)
//   npx tsx scripts/auto-draft.ts --file boundary.kml   (writes boundary.draft.kml and boundary.draft.txt; uses
//                                                         boundary.osm.json as map data when it exists)
// This repository is public, so the job log shows counts only, never names or places.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { readKml, territoriesKml } from '../src/geo/kml';
import type { OsmData } from '../src/types';
import { fetchOsm } from '../src/geo/osm';
import { boundaryOf, draftProject, summaryText } from '../src/auto/draft';
import { union, toJsts, clean } from '../src/geo/core';

(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;
const realFetch = globalThis.fetch;
// Overpass rejects Node's default user agent.
const osmFetch: typeof fetch = (u, init) => realFetch(u, { ...init, headers: { 'User-Agent': 'TerritoryManager/0.1 (auto draft)', Accept: 'application/json' } });

/** The free Overpass servers are often busy for a few minutes: try again after 1, 3 and 9 minutes. */
async function osmFor(bbox: [number, number, number, number]): Promise<OsmData> {
  globalThis.fetch = osmFetch;
  try {
    for (let i = 0; ; i++) {
      try {
        return await fetchOsm(bbox, () => {});
      } catch (e) {
        if (i === 3) throw e;
        console.log(`map servers busy, retrying in ${3 ** i} min`);
        await new Promise((r) => setTimeout(r, 3 ** i * 60_000));
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function draft(file: File, congregation: string, cache?: string) {
  const shapes = await readKml(file);
  const boundary = boundaryOf(shapes);
  const e = clean(union([toJsts(boundary)])).getEnvelopeInternal();
  const bbox: [number, number, number, number] = [e.getMinX() - 0.002, e.getMinY() - 0.002, e.getMaxX() + 0.002, e.getMaxY() + 0.002];
  const osm: OsmData = cache && existsSync(cache) ? JSON.parse(readFileSync(cache, 'utf8')) : await osmFor(bbox);
  console.log(`map data: ${osm.lines.length} lines, ${osm.buildings.length} buildings`);
  const { project, summary } = draftProject(boundary, osm, congregation);
  console.log(`draft: ${summary.territories} territories, ${summary.merges.length} merge ideas, ${summary.warnings.length} notes`);
  return { kml: territoriesKml(`${congregation || 'Congregation'} (automatic draft)`, project.territories), text: summaryText(congregation || 'this congregation', summary) };
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  const secret = process.env.TM_AUTO_SECRET;
  if (!url || !key || !secret) throw new Error('SUPABASE_URL, SUPABASE_ANON_KEY and TM_AUTO_SECRET must be set');
  const res = await realFetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' }, // a publishable key goes in apikey only, never as a Bearer token
    body: JSON.stringify({ p_secret: secret, ...args }),
  });
  if (!res.ok) throw new Error(`${name} failed: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const [arg, path] = process.argv.slice(2);
if (arg === '--file') {
  const out = await draft(new File([readFileSync(path)], path.replace(/^.*[\\/]/, '')), '');
  writeFileSync(path.replace(/\.km[lz]$/i, '.draft.kml'), out.kml);
  writeFileSync(path.replace(/\.km[lz]$/i, '.draft.txt'), out.text);
} else {
  if (!/^[0-9a-f-]{36}$/i.test(arg ?? '')) throw new Error('Give a request id');
  const req = await rpc<{ congregation: string; name: string; data: string } | null>('tm_auto_request', { p_request: arg });
  if (!req) {
    console.log('nothing to do (no boundary file, or a draft exists already)');
    process.exit(0);
  }
  try {
    const out = await draft(new File([Buffer.from(req.data, 'base64')], req.name), req.congregation);
    await rpc('tm_auto_draft_save', { p_request: arg, p_kml: out.kml, p_summary: out.text });
  } catch (e) {
    // Tell the owner, so a failed draft never goes unnoticed; the message has no names in it.
    await rpc('tm_auto_draft_save', { p_request: arg, p_kml: null, p_summary: `The automatic draft failed: ${e instanceof Error ? e.message : e}` });
    throw e;
  }
}
