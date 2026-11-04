// Small background helper for the Territory Manager app: it runs the Google My Maps job (scripts/mymaps.ts),
// which needs a local Chrome window a web page cannot open. The installed app shortcut starts it hidden
// (launcher/Territory Manager.vbs); `npm run helper` starts it in a terminal.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { makeLinks } from './mymaps';
import type { Territory } from '../src/types';

const PORT = 4747;
// Only the app (published, or the dev server) may use the helper.
const ORIGINS = ['https://photographicode.github.io', 'http://localhost:5180'];

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
  } else return json(res, 403, { error: 'Not allowed' });
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  try {
    await api(req, res, path);
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
})
  // A second start (helper already running) just exits.
  .on('error', (e: NodeJS.ErrnoException) => process.exit(e.code === 'EADDRINUSE' ? 0 : 1))
  .listen(PORT, '127.0.0.1', () => console.log(`Territory Manager helper is listening on http://127.0.0.1:${PORT}`));
