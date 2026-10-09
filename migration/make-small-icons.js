#!/usr/bin/env node
/* Display-size image copies, made in a headless Chromium. Run from the repo
   root:

     node migration/make-small-icons.js [icons|decor|all]     (default: icons)

   `icons` — assets/icons-sm/{id}.webp, the official role icons at 192px (a
   64px slot at 3x), WebP q85, transparency kept, ~7 KB each. The wiki draws
   official icons at 40-70 CSS px — a script roster row, a jinx box, a node
   on the /jinxes map — and fetched them from the official CDN
   (release.botc.app: another origin to connect to, 400px files, cached for
   ten minutes) or, on /jinxes, as the 539px PNGs in assets/icons/ (~116 KB
   each).

   The SOURCE is each role's `image` in assets/roles.json — the release-CDN
   art the pages already showed — NOT assets/icons/, which holds the older
   art style and would have changed how every official character looks.

   DISPLAY ONLY. Nothing that leaves the wiki — the official-schema JSON, the
   Token Tool, an export's `image` — ever points here; they keep the URLs they
   had. The files are cached immutable (_headers), so a changed picture needs
   a new filename, never an overwrite.

   Travellers: roles.json carries the UNALIGNED icon for every traveller
   (CLAUDE.md, gotcha 16), so that is what this copies. If roles.json is ever
   regenerated, strip the `_g` from the traveller rows FIRST, then re-run this.
   Re-run it too whenever roles.json gains a character: a role with no small
   icon falls back to its CDN image in the browser, so nothing breaks, it is
   just slower.

   `decor` — the top bar's badge and skull (assets/ccc-parchment.webp,
   assets/logo_skull.webp) from their PNG originals, at ~3x the height they
   are drawn at (32px and 54px at most), q85. They were the full-size PNGs
   re-encoded: 17 KB and 16 KB for a 24-54px picture on every first visit.
   These two were overwritten in place rather than renamed, which the
   immutable rule normally forbids — allowed here only because the picture
   is the same and only its resolution dropped to what a 3x screen uses, so
   a reader still holding the old copy sees exactly the same thing. A
   picture that LOOKS different must get a new filename.

   There is no image library in this repo (and no package.json), so the
   resize runs in the Playwright Chromium the sandbox ships with: a canvas
   draw + toDataURL('image/webp'). Nothing here touches R2 or D1. */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const A = path.join(ROOT, 'assets');
const ROLES = path.join(A, 'roles.json');
const DST = path.join(A, 'icons-sm');
const SIZE = 192;
const QUALITY = 0.85;
const DECOR = [
  // [source PNG, output WebP, height in px]
  ['ccc-parchment.png', 'ccc-parchment.webp', 96],
  ['logo_skull.png', 'logo_skull.webp', 162]
];

function playwright() {
  const tries = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node-tools/node_modules/playwright'].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch (e) { /* next */ } }
  console.error('Playwright is not available (set PLAYWRIGHT_MODULE to its path).');
  process.exit(1);
}

// Draw `src` into a canvas fitting {box} (longest side) or {height}, never
// enlarged, and return the WebP bytes.
async function encode(page, src, fit) {
  const out = await page.evaluate(async ({ src, fit, quality }) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';   // the CDN sends Access-Control-Allow-Origin: *
    img.src = src;
    await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight;
    const s = Math.min(1, fit.height ? fit.height / h : fit.box / Math.max(w, h));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * s)); cv.height = Math.max(1, Math.round(h * s));
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/webp', quality);
  }, { src, fit, quality: QUALITY });
  if (!/^data:image\/webp;base64,/.test(out)) throw new Error('this Chromium cannot encode WebP');
  const buf = Buffer.from(out.slice(out.indexOf(',') + 1), 'base64');
  if (buf.length < 512) throw new Error(src.slice(0, 80) + ': the render came out empty');
  return buf;
}

async function icons(page) {
  fs.mkdirSync(DST, { recursive: true });
  const roles = JSON.parse(fs.readFileSync(ROLES, 'utf8'))
    .filter(r => r && /^[a-z0-9]+$/.test(r.id || '') && /^https:\/\//.test(r.image || ''));
  let after = 0;
  for (const r of roles) {
    const buf = await encode(page, r.image, { box: SIZE });
    fs.writeFileSync(path.join(DST, r.id + '.webp'), buf);
    after += buf.length;
  }
  console.log(`${roles.length} icons, ${(after / 1024).toFixed(0)} KB (avg ${(after / roles.length / 1024).toFixed(1)} KB)`);
}

async function decor(page) {
  for (const [src, dst, height] of DECOR) {
    const data = 'data:image/png;base64,' + fs.readFileSync(path.join(A, src)).toString('base64');
    const before = fs.existsSync(path.join(A, dst)) ? fs.statSync(path.join(A, dst)).size : 0;
    const buf = await encode(page, data, { height });
    fs.writeFileSync(path.join(A, dst), buf);
    console.log(dst.padEnd(22), `${(before / 1024).toFixed(1)} KB -> ${(buf.length / 1024).toFixed(1)} KB`);
  }
}

(async () => {
  const what = process.argv[2] || 'icons';
  const { chromium } = playwright();
  const exe = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : '');
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>images</title>');
  if (what === 'icons' || what === 'all') await icons(page);
  if (what === 'decor' || what === 'all') await decor(page);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
