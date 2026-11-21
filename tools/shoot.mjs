// shoot.mjs — how the handed-in screenshots are made.
//
//   node tools/shoot.mjs <dossier-dir> <dest-dir>
//
// The four images in screenshots/ are real renders of the built
// dashboard, taken in a desktop browser at 1440x1000 — not mockups
// and not exports from a design tool. This is the exact script
// that produces them, kept in the repository so the provenance of
// every handed-in image can be re-run, not just believed.
//
// It serves the dossier locally, opens the dashboard's four
// views (the ?shot= modes the page itself supports), and waits
// until the page's own verification has finished — the checks
// line above the board only states the build's runtime after the
// in-page refit has run — before photographing each view. A shot
// that would exceed the 256 KiB hand-in cap is re-encoded at a
// lower quality until it fits, and the script says so when it
// happens.
//
// Requires puppeteer (a dev-only dependency; the dashboard and
// the build itself use no packages at all).

import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.argv[2];
const dest = process.argv[3];
if (!root || !dest) {
  console.error('usage: node tools/shoot.mjs <dossier-dir> <dest-dir>');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const path = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/dashboard/index.html`;

const SHOTS = [
  ['01-board.jpg', ''],
  ['02-evidence.jpg', '?shot=evidence'],
  ['03-detail.jpg', '?shot=detail&slug=steakhouse-financial'],
  ['04-watchlist.jpg', '?shot=watchlist'],
];
const CAP_BYTES = 262144;

const browser = await puppeteer.launch({ args: ['--no-sandbox', '--force-color-profile=srgb'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  for (const [name, query] of SHOTS) {
    await page.goto(base + query, { waitUntil: 'networkidle0' });
    // The verdict this page prints about itself is part of the
    // picture: do not photograph until the in-page refit has run
    // to completion (window.REFIT is assigned only when it has,
    // on every view, whether it matched or not).
    await page.waitForFunction(() => typeof window.REFIT !== 'undefined', { timeout: 60000 });
    const path = join(dest, name);
    let quality = 84;
    await page.screenshot({ path, type: 'jpeg', quality });
    let size = (await stat(path)).size;
    while (size > CAP_BYTES && quality > 40) {
      quality -= 12;
      await page.screenshot({ path, type: 'jpeg', quality });
      size = (await stat(path)).size;
      console.log(`shot ${name}: re-encoded at quality ${quality} to fit the cap`);
    }
    console.log(`shot ${name} (${size} bytes)`);
  }
} finally {
  await browser.close();
  server.close();
}
