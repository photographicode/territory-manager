// Make one public Google My Maps map per territory and save each map's link as the territory's card QR link.
// Runs on this computer and drives a Chrome window; nothing is sent anywhere except Google.
//
// Usage: npm run mymaps -- <backup.json> [first number] [last number]
//   <backup.json>  a backup from the app (Backup → Download backup)
// Writes <backup>-with-map-links.json after every map, so a stopped run carries on where it left off.
// Restore that file in the app (Backup → Restore) to put the links on the cards.
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

const [input, from, to] = process.argv.slice(2);
if (!input) throw new Error('Usage: npm run mymaps -- <backup.json> [first number] [last number]');
const out = input.replace(/(\.json)?$/i, '-with-map-links.json');
const project: Project = JSON.parse(readFileSync(existsSync(out) ? out : input, 'utf8'));
const congregation = project.settings.congregation.trim();
const inRange = (t: Territory) => (!from || +t.number >= +from) && (!to || +t.number <= +to);
const todo = project.territories
  .filter((t) => !t.mapUrl && inRange(t))
  .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
console.log(`${todo.length} territories to do; links are saved to ${out}`);

const mapTitle = (t: Territory) => `${t.number}${t.locality ? ` - ${t.locality}` : ''}${congregation ? ` | ${congregation}` : ''}`;

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

async function signIn(page: Page) {
  await page.goto(HOME);
  if (await page.locator('text=/create a new map/i >> visible=true').count()) return;
  console.log('Sign in to Google in the Chrome window that opened, with the account for territory maps. Waiting…');
  // Wait (up to 15 min) for the My Maps home page, wherever the sign-in pages lead.
  for (let i = 0; i < 180; i++) {
    await page.waitForTimeout(5000);
    if (page.url().startsWith(HOME.slice(0, -5)) && (await page.locator('text=/create a new map/i >> visible=true').count())) return;
    if (!/accounts\.google\.com/.test(page.url()) && !page.url().startsWith('https://www.google.com/maps/d')) await page.goto(HOME).catch(() => undefined);
  }
  throw new Error('Not signed in after 15 minutes');
}

async function makeMap(page: Page, t: Territory): Promise<string> {
  const file = join(tmpdir(), `territory-${t.number.replace(/[^\w-]/g, '_')}.kml`);
  writeFileSync(file, territoryKml(t, congregation));

  await page.goto(HOME);
  await page.locator('text=/create a new map/i >> visible=true').first().click();
  // First map on an account shows a note about Drive; accept it.
  const note = page.getByRole('button', { name: /^create$/i });
  await Promise.race([page.waitForURL(/\/edit\?mid=/, { timeout: 30000 }), note.click({ timeout: 30000 })]).catch(() => undefined);
  await page.waitForURL(/\/edit\?mid=/, { timeout: 60000 });
  const mid = new URL(page.url()).searchParams.get('mid');
  if (!mid) throw new Error('New map has no id');

  // Import: the file picker lives in a Google frame; Playwright hands it the file without a dialog.
  await page.locator('text="Import" >> visible=true').first().click();
  let upload = null;
  for (let i = 0; i < 40 && !upload; i++) {
    for (const f of page.frames()) if (await f.locator('text="Upload" >> visible=true').count()) upload = f;
    if (!upload) await page.waitForTimeout(500);
  }
  if (!upload) throw new Error('Import window did not open');
  await upload.locator('text="Upload" >> visible=true').first().click();
  // The picker keeps a hidden file input; filling it is what Browse would do.
  await upload.locator('text="Browse" >> visible=true').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(1000);
  const fileInput = upload.locator('input[type=file]');
  if (await fileInput.count()) await fileInput.first().setInputFiles(file);
  else {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 30000 }), upload.locator('text="Browse" >> visible=true').first().click()]);
    await chooser.setFiles(file);
  }
  await page.getByText('Untitled layer').waitFor({ state: 'detached', timeout: 120000 });

  await page.locator('#map-title-desc-bar div[aria-label]').first().click();
  const dialog = page.locator('[role=dialog]:visible');
  await dialog.locator('input[type=text]').first().fill(mapTitle(t));
  await dialog.locator('text="Save" >> visible=true').first().click();
  await dialog.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => undefined);

  await page.locator('#map-action-share').click();
  const share = page.locator('#linksharing');
  await share.waitFor({ timeout: 15000 });
  if (!(await isPublic(mid))) await page.locator('label[for=linksharing]').click();
  await page.locator('[role=dialog]:visible [aria-label=Close]').first().click();

  for (let i = 0; i < 10; i++) {
    if (await isPublic(mid)) return `https://www.google.com/maps/d/viewer?mid=${mid}`;
    await page.waitForTimeout(2000);
  }
  throw new Error(`Map ${mid} is not viewable without signing in`);
}

/** Opens the map's preview as a stranger would (no Google cookies). */
async function isPublic(mid: string) {
  const html = await fetch(`https://www.google.com/maps/d/viewer?mid=${mid}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)' } })
    .then((r) => r.text())
    .catch(() => '');
  return html.includes('mapdataJson') || html.includes('– Google My Maps');
}

if (todo.length) {
  const { browser, page } = await connect();
  await signIn(page);
  let failed = 0;
  for (const [i, t] of todo.entries()) {
    try {
      const link = await makeMap(page, t);
      project.territories = project.territories.map((x) => (x.id === t.id ? { ...x, mapUrl: link } : x));
      writeFileSync(out, JSON.stringify(project));
      console.log(`${i + 1}/${todo.length}  ${mapTitle(t)}  ${link}`);
    } catch (e) {
      failed++;
      const shot = join(tmpdir(), `mymaps-error-${t.number}.png`);
      await page.screenshot({ path: shot }).catch(() => undefined);
      console.error(`${i + 1}/${todo.length}  ${mapTitle(t)}  FAILED: ${(e as Error).message} (screenshot ${shot})`);
    }
  }
  await browser.close().catch(() => undefined);
  console.log(failed ? `Done, ${failed} failed; run again to retry them.` : 'Done. Restore the new file in the app to put the links on the cards.');
}
