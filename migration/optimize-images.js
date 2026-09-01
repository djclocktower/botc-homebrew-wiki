#!/usr/bin/env node
/* Derived images for the repo's committed pictures. Run from the repo root:

     npm i --no-save sharp && node migration/optimize-images.js [decor|thumbs|all]

   `decor`  — the page furniture as WebP, beside the originals: bg.webp and the
              phone-sized bg-m.webp (styles.css picks one by viewport),
              parchment.webp, ccc-parchment.webp, logo_skull.webp. These are
              cached immutable for a year (_headers), so a CHANGED picture must
              get a new filename and a new reference, never an overwrite.
   `thumbs` — assets/thumb/{file}.webp for every file in assets/art/: the
              192px card thumbnail (a 64px card at 3×), transparency kept,
              plus manifest.json listing what is committed. The Worker serves
              these at /assets/thumb/{file}.webp and falls back to the original
              where none exists; R2-only art gets its thumbnails from the
              editors (assets/art-thumb.js) and the dashboard's backfill card.
              Re-runnable: it rewrites every thumbnail from the current art.

   sharp is not a dependency of the site (there is no build step); it is only
   needed to run this script. Nothing here touches R2 or D1. */
const path = require('path');
const fs = require('fs');
let sharp;
try { sharp = require('sharp'); } catch (e) {
  console.error('sharp is not installed: run `npm i --no-save sharp` first.'); process.exit(1);
}
const ROOT = path.join(__dirname, '..');
const A = path.join(ROOT, 'assets') + path.sep;
const what = process.argv[2] || 'all';

async function decor() {
  const jobs = [
    ['bg.jpg', 'bg.webp', { width: 1920 }, { quality: 70 }],
    ['bg.jpg', 'bg-m.webp', { width: 1080 }, { quality: 68 }],
    ['parchment.jpg', 'parchment.webp', { width: 1000 }, { quality: 74 }],
    ['ccc-parchment.png', 'ccc-parchment.webp', null, { quality: 88, alphaQuality: 90 }],
    ['logo_skull.png', 'logo_skull.webp', null, { quality: 88, alphaQuality: 90 }]
  ];
  for (const [src, dst, resize, opts] of jobs) {
    let img = sharp(A + src);
    if (resize) img = img.resize({ ...resize, withoutEnlargement: true });
    await img.webp(opts).toFile(A + dst);
    const a = fs.statSync(A + src).size, b = fs.statSync(A + dst).size;
    console.log(dst.padEnd(22), `${(a / 1024).toFixed(0)} KB -> ${(b / 1024).toFixed(0)} KB`);
  }
}

const THUMB = 192;
async function thumbs() {
  const SRC = A + 'art' + path.sep, DST = A + 'thumb' + path.sep;
  fs.mkdirSync(DST, { recursive: true });
  const files = fs.readdirSync(SRC).filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f)).sort();
  let n = 0, bytes = 0; const failed = [];
  for (const f of files) {
    try {
      await sharp(SRC + f).resize({ width: THUMB, height: THUMB, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80, alphaQuality: 85, effort: 4 }).toFile(DST + f + '.webp');
      bytes += fs.statSync(DST + f + '.webp').size; n++;
    } catch (e) { failed.push(f + ': ' + e.message); }
  }
  const list = fs.readdirSync(DST).filter(f => f.endsWith('.webp')).sort();
  fs.writeFileSync(DST + 'manifest.json', JSON.stringify({ size: THUMB, files: list }));
  console.log(`${n} thumbnails, ${(bytes / 1024 / 1024).toFixed(1)} MB, avg ${Math.round(bytes / Math.max(1, n))} bytes`);
  if (failed.length) console.log('failed:', failed);
}

(async () => {
  if (what === 'decor' || what === 'all') await decor();
  if (what === 'thumbs' || what === 'all') await thumbs();
})().catch(e => { console.error(e); process.exit(1); });
