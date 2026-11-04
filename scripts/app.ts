// Runs Territory Manager on this computer: serves the built app at http://localhost:4747 and lets it start
// the Google My Maps job (scripts/mymaps.ts), which needs a local Chrome window a web page cannot open.
// Start with `npm run app` (or double-click "Territory Manager.cmd").
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { makeLinks } from './mymaps';
import type { Territory } from '../src/types';

const PORT = 4747;
const DIST = join(import.meta.dirname, '..', 'dist');
// The published copy and the dev server may call the helper too; no other site may.
const ORIGINS = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, 'https://photographicode.github.io', 'http://localhost:5180'];
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const job = { running: false, total: 0, failed: 0, log: [] as string[], links: {} as Record<string, string>, stop: false };

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage) {
  let s = '';
  for await (const chunk of req) s += chunk;
  return JSON.parse(s || '{}');
}

async function api(req: IncomingMessage, res: ServerResponse, path: string) {
  if (path === '/api/ping') return json(res, 200, { ok: true });
  if (path === '/api/mymaps' && req.method === 'GET') return json(res, 200, { ...job, log: job.log.slice(-200) });
  if (path === '/api/mymaps/stop' && req.method === 'POST') {
    job.stop = true;
    return json(res, 200, { ok: true });
  }
  if (path === '/api/mymaps' && req.method === 'POST') {
    if (job.running) return json(res, 409, { error: 'Already making maps' });
    const { territories, congregation } = (await readBody(req)) as { territories: Territory[]; congregation: string };
    if (!Array.isArray(territories)) return json(res, 400, { error: 'No territories' });
    Object.assign(job, { running: true, total: territories.filter((t) => !t.mapUrl).length, failed: 0, log: [], links: {}, stop: false });
    makeLinks(territories, String(congregation ?? ''), {
      log: (m) => job.log.push(m),
      link: (t, url) => (job.links[t.id] = url),
      stopped: () => job.stop,
    })
      .then((failed) => {
        job.failed = failed;
        job.log.push(job.stop ? 'Stopped.' : failed ? `Finished; ${failed} failed. Press the button again to retry them.` : 'Finished.');
      })
      .catch((e) => job.log.push(`Stopped by an error: ${(e as Error).message.split('\n')[0]}`))
      .finally(() => (job.running = false));
    return json(res, 202, { started: true });
  }
  json(res, 404, { error: 'Unknown request' });
}

createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  } else if (origin && req.url?.startsWith('/api/')) return json(res, 403, { error: 'Not allowed' });
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  try {
    if (path.startsWith('/api/')) return await api(req, res, path);
    let file = normalize(join(DIST, path === '/' ? 'index.html' : path));
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
}).listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`Territory Manager is running at ${url} (close this window to stop it)`);
  if (!process.env.NO_OPEN) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
});
