// Make one public Google My Maps map per territory and save each map's link as the territory's card QR link.
// Runs on this computer and drives a Chrome window; nothing is sent anywhere except Google.
//
// From the app: Cards step → "Make My Maps links" (needs the app opened with `npm run app`).
// From a terminal: npm run mymaps -- <backup.json> [first number] [last number]
//   <backup.json>  a backup from the app (Backup → Download backup)
// Writes <backup>-with-map-links.json after every map, so a stopped run carries on where it left off.
// Restore that file in the app (Backup → Restore) to put the links on the cards.
//
// Every step has a second way to do it, each result is checked, and a failed territory is retried on the
// same half-made map (remembered in the Chrome profile folder), so failures leave no stray maps.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { territoryKml } from '../src/geo/kml';
import type { Project, Territory } from '../src/types';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
// Chrome refuses remote control of its normal profile, so this window keeps its own sign-in.
const PROFILE = join(process.env.LOCALAPPDATA ?? tmpdir(), 'TerritoryManager', 'mymaps-chrome');
const HOME = 'https://www.google.com/maps/d/u/0/';
const ATTEMPTS = 3;

let congregation = '';
// Where progress messages go: the terminal, or the app when started from there.
let say = (msg: string) => console.log(msg);

const mapTitle = (t: Territory) => `${t.number}${t.locality ? ` - ${t.locality}` : ''}${congregation ? ` | ${congregation}` : ''}`;

// Half-made maps (territory id → map id), so a retry or a later run finishes the same map instead of making another.
const draftsFile = join(PROFILE, 'drafts.json');
const drafts: Record<string, string> = existsSync(draftsFile) ? JSON.parse(readFileSync(draftsFile, 'utf8')) : {};
const saveDrafts = () => writeFileSync(draftsFile, JSON.stringify(drafts));
// Any finished map works as a starting point for the ⋮ → "New map" way.
let lastMid = '';

async function connect() {
  const tryConnect = () => chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null);
  let browser = await tryConnect();
  if (!browser) {
    mkdirSync(PROFILE, { recursive: true });
    spawn(CHROME, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--no-first-run', HOME], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 30 && !browser; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      browser = await tryConnect();
    }
  }
  if (!browser) throw new Error('Could not open Chrome for My Maps');
  const ctx = browser.contexts()[0];
  return { browser, page: ctx.pages()[0] ?? (await ctx.newPage()) };
}

const visible = (page: Page, text: string) => page.locator(`text=${text} >> visible=true`).first();

async function signIn(page: Page) {
  await page.goto(HOME);
  if (await visible(page, '/create a new map/i').count()) return;
  say('Sign in to Google in the Chrome window that opened, with the account for territory maps. Waiting…');
  // Wait (up to 15 min) for the My Maps home page, wherever the sign-in pages lead.
  for (let i = 0; i < 180; i++) {
    await page.waitForTimeout(5000);
    if (page.url().startsWith(HOME.slice(0, -5)) && (await visible(page, '/create a new map/i').count())) return;
    if (!/accounts\.google\.com/.test(page.url()) && !page.url().startsWith('https://www.google.com/maps/d')) await page.goto(HOME).catch(() => undefined);
  }
  throw new Error('Not signed in after 15 minutes');
}

/** Try each way in turn; fails only when every way has failed. */
async function oneOf(what: string, ways: [string, () => Promise<unknown>][]) {
  const errors: string[] = [];
  for (const [name, way] of ways) {
    try {
      // MYMAPS_TEST_FALLBACKS=1 skips each first way, to check the second ways still work.
      if (process.env.MYMAPS_TEST_FALLBACKS && name === ways[0][0]) throw new Error('skipped for testing');
      return await way();
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message.split('\n')[0]}`);
      say(`   ${what}: "${name}" did not work, trying the next way`);
    }
  }
  throw new Error(`${what} failed (${errors.join('; ')})`);
}

const editUrl = (mid: string) => `https://www.google.com/maps/d/u/0/edit?mid=${mid}`;
const midOf = (page: Page) => new URL(page.url()).searchParams.get('mid');

async function waitForNewMap(page: Page, before: string) {
  const isNew = (u: URL) => /\/edit/.test(u.pathname) && !!u.searchParams.get('mid') && u.searchParams.get('mid') !== before;
  // First map on an account shows a note about Drive; accept it.
  const note = page.getByRole('button', { name: /^create$/i });
  await Promise.race([page.waitForURL(isNew, { timeout: 30000 }), note.click({ timeout: 30000 })]).catch(() => undefined);
  await page.waitForURL(isNew, { timeout: 60000 });
  return midOf(page)!;
}

async function createMap(page: Page): Promise<string> {
  let mid = '';
  await oneOf('Create map', [
    [
      'My Maps home button',
      async () => {
        await page.goto(HOME);
        await visible(page, '/create a new map/i').click({ timeout: 20000 });
        mid = await waitForNewMap(page, '');
      },
    ],
    [
      'map menu (⋮ next to the title)',
      async () => {
        if (!lastMid) throw new Error('no earlier map to start from');
        await page.goto(editUrl(lastMid));
        await page.locator('#map-action-menu').click({ timeout: 15000 });
        await visible(page, '"New map"').click({ timeout: 15000 });
        mid = await waitForNewMap(page, lastMid);
      },
    ],
  ]);
  return mid;
}

/** An empty layer shows an Import link; wait for the layer list before deciding. */
async function imported(page: Page) {
  await page.locator('#map-action-add-layer').waitFor({ timeout: 30000 });
  return !(await visible(page, '"Import"').waitFor({ timeout: 5000 }).then(() => true, () => false));
}

async function openUploadTab(page: Page) {
  await page.keyboard.press('Escape').catch(() => undefined);
  await visible(page, '"Import"').click({ timeout: 20000 });
  for (let i = 0; i < 40; i++) {
    for (const f of page.frames()) {
      if (!(await f.locator('text="Upload" >> visible=true').count().catch(() => 0))) continue;
      await f.locator('text="Upload" >> visible=true').first().click();
      await f.locator('text="Browse" >> visible=true').first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(1000);
      return f;
    }
    await page.waitForTimeout(500);
  }
  throw new Error('import window did not open');
}

async function importKml(page: Page, file: string) {
  if (await imported(page)) return;
  const done = async () => {
    await visible(page, '"Import"').waitFor({ state: 'hidden', timeout: 120000 });
    if (!(await imported(page))) throw new Error('the layer is still empty');
  };
  await oneOf('Import outline', [
    [
      'file box in the import window',
      async () => {
        const f = await openUploadTab(page);
        await f.locator('input[type=file]').first().setInputFiles(file);
        await done();
      },
    ],
    [
      'Browse button',
      async () => {
        await page.reload();
        if (await imported(page)) return;
        const f = await openUploadTab(page);
        const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 30000 }), f.locator('text="Browse" >> visible=true').first().click()]);
        await chooser.setFiles(file);
        await done();
      },
    ],
  ]);
}

const currentTitle = (page: Page) => page.locator('#map-title-desc-bar div[aria-label]').first().getAttribute('aria-label');

async function setTitle(page: Page, title: string) {
  if ((await currentTitle(page)) === title) return;
  const check = async () => {
    await page.waitForTimeout(1500);
    const now = await currentTitle(page);
    if (now !== title) throw new Error(`title is still "${now}"`);
  };
  await oneOf('Rename map', [
    [
      'title box and Save',
      async () => {
        await page.locator('#map-title-desc-bar div[aria-label]').first().click();
        const dialog = page.locator('[role=dialog]:visible');
        await dialog.locator('input[type=text]').first().fill(title);
        await dialog.locator('text="Save" >> visible=true').first().click();
        await check();
      },
    ],
    [
      'title box and keyboard',
      async () => {
        await page.reload();
        await page.locator('#map-title-desc-bar div[aria-label]').first().click();
        await page.locator('[role=dialog]:visible input[type=text]').first().click();
        await page.keyboard.press('Control+A');
        await page.keyboard.type(title);
        await page.keyboard.press('Enter');
        await check();
      },
    ],
  ]);
}

/** Opens the map's preview as a stranger would (no Google cookies). */
async function isPublic(mid: string) {
  const html = await fetch(`https://www.google.com/maps/d/viewer?mid=${mid}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)' } })
    .then((r) => r.text())
    .catch(() => '');
  return html.includes('mapdataJson') || html.includes('– Google My Maps');
}

async function makePublic(page: Page, mid: string) {
  if (await isPublic(mid)) return;
  const check = async () => {
    for (let i = 0; i < 10; i++) {
      if (await isPublic(mid)) return;
      await page.waitForTimeout(2000);
    }
    throw new Error('still not viewable without signing in');
  };
  const openShare = async () => {
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.locator('#map-action-share').click();
    await page.locator('#linksharing').waitFor({ state: 'attached', timeout: 15000 });
  };
  const close = () => page.locator('[role=dialog]:visible [aria-label=Close]').first().click().catch(() => page.keyboard.press('Escape'));
  await oneOf('Share publicly', [
    [
      'switch label',
      async () => {
        await openShare();
        await page.locator('label[for=linksharing]').click();
        await close();
        await check();
      },
    ],
    [
      'switch itself',
      async () => {
        await page.reload();
        await openShare();
        if (!(await isPublic(mid))) await page.locator('#linksharing').click({ force: true });
        await close();
        await check();
      },
    ],
  ]);
}

async function makeMap(page: Page, t: Territory): Promise<string> {
  const file = join(tmpdir(), `territory-${t.number.replace(/[^\w-]/g, '_')}.kml`);
  writeFileSync(file, territoryKml(t, congregation));
  let mid = drafts[t.id];
  if (mid) await page.goto(editUrl(mid));
  if (!mid || midOf(page) !== mid) {
    mid = await createMap(page);
    drafts[t.id] = mid;
    saveDrafts();
  }
  lastMid = mid;
  await importKml(page, file);
  await setTitle(page, mapTitle(t));
  await makePublic(page, mid);
  return `https://www.google.com/maps/d/viewer?mid=${mid}`;
}

export interface LinkJob {
  log: (msg: string) => void;
  /** Called as soon as each map is finished and public. */
  link: (t: Territory, url: string) => void;
  stopped: () => boolean;
}

/** Makes a map for each territory without a link; returns how many failed. */
export async function makeLinks(ts: Territory[], cong: string, job: LinkJob): Promise<number> {
  congregation = cong.trim();
  say = job.log;
  lastMid = ts.map((t) => t.mapUrl && new URL(t.mapUrl).searchParams.get('mid')).find(Boolean) || lastMid;
  const todo = ts.filter((t) => !t.mapUrl).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  if (!todo.length) return 0;
  mkdirSync(PROFILE, { recursive: true });
  const { browser, page } = await connect();
  let failed = 0;
  try {
    await signIn(page);
    for (const [i, t] of todo.entries()) {
      if (job.stopped()) break;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
          const url = await makeMap(page, t);
          delete drafts[t.id];
          saveDrafts();
          job.link(t, url);
          say(`${i + 1}/${todo.length}  ${mapTitle(t)}  ${url}`);
          break;
        } catch (e) {
          const msg = (e as Error).message.split('\n')[0];
          if (attempt < ATTEMPTS) {
            say(`   ${mapTitle(t)}: attempt ${attempt} failed (${msg}); trying again on the same map`);
            await page.waitForTimeout(3000 * attempt);
            continue;
          }
          failed++;
          const shot = join(tmpdir(), `mymaps-error-${t.number}.png`);
          await page.screenshot({ path: shot }).catch(() => undefined);
          say(`${i + 1}/${todo.length}  ${mapTitle(t)}  FAILED: ${msg} (screenshot ${shot})`);
        }
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  return failed;
}

// Terminal use: npm run mymaps -- <backup.json> [first number] [last number]
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/mymaps.ts')) {
  const [input, from, to] = process.argv.slice(2);
  if (!input) throw new Error('Usage: npm run mymaps -- <backup.json> [first number] [last number]');
  const out = input.replace(/(\.json)?$/i, '-with-map-links.json');
  const project: Project = JSON.parse(readFileSync(existsSync(out) ? out : input, 'utf8'));
  const inRange = (t: Territory) => (!from || +t.number >= +from) && (!to || +t.number <= +to);
  console.log(`Links are saved to ${out}`);
  const failed = await makeLinks(project.territories.filter((t) => t.mapUrl || inRange(t)), project.settings.congregation, {
    log: console.log,
    link: (t, url) => {
      project.territories = project.territories.map((x) => (x.id === t.id ? { ...x, mapUrl: url } : x));
      writeFileSync(out, JSON.stringify(project));
    },
    stopped: () => false,
  });
  console.log(failed ? `Done, ${failed} failed; run again to retry them (their half-made maps are reused).` : 'Done. Restore the new file in the app to put the links on the cards.');
}
