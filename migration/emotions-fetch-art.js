#!/usr/bin/env node
/*
 * Download the Emotions art into the repo. Run from the repo root:
 *
 *     node migration/emotions-fetch-art.js
 *     npm i --no-save sharp && node migration/optimize-images.js thumbs
 *
 * The project's icons live on the author's host (user-images.klutzbanana.com)
 * under opaque filenames. Pointing the rows at those URLs would leave the
 * wiki hotlinking somebody else's bucket: the pages break if that host goes
 * away or the files are renamed, the official-schema JSON this wiki exports
 * would send the app there too, and none of it can be thumbnailed or
 * immutable-cached the way /assets/ art is.
 *
 * So every icon is copied in under the name its character's identity gives it
 * — art/{identity}.png, -alt, -alt2, the three slots in the order
 * "A character's three icons" defines (for the traveller: unaligned, good,
 * evil) — and the script logo to scripts/emotions-logo.png. The Worker serves
 * /assets/ R2 first and the committed file second, so these need no upload:
 * they go live with the deploy.
 *
 * Re-runnable, and it never overwrites a file that is already committed
 * unless --force is passed: art/ is a shared namespace and a name collision
 * with another character's icon must be a loud failure, not a silent
 * replacement.
 */
const fs = require('fs');
const path = require('path');

const IMP = require(path.join(__dirname, 'emotions-import.json'));
const ROOT = path.join(__dirname, '..');
const force = process.argv.includes('--force');

const kebab = s => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 80);

const SUFFIX = ['', '-alt', '-alt2'];
const jobs = [];
for (const c of IMP.characters) {
  const ident = kebab(c.name);
  const imgs = (Array.isArray(c.image) ? c.image : [c.image]).filter(Boolean);
  imgs.forEach((url, i) => {
    if (i >= SUFFIX.length) throw new Error(c.name + ' has more than three icons');
    jobs.push({ url, dest: path.join('assets', 'art', ident + SUFFIX[i] + '.png') });
  });
}
jobs.push({ url: IMP._meta.logo, dest: path.join('assets', 'scripts', 'emotions-logo.png') });

// A PNG or nothing: these are written into the repo and served from our own
// origin, so what arrives has to be the format the extension claims.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

(async () => {
  let written = 0, skipped = 0;
  const failed = [];
  for (const { url, dest } of jobs) {
    const abs = path.join(ROOT, dest);
    if (fs.existsSync(abs) && !force) { skipped++; continue; }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('not a PNG');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      written++;
    } catch (e) { failed.push(dest + ': ' + e.message); }
  }
  console.log('written:', written, '| already present:', skipped, '| of', jobs.length);
  if (failed.length) { console.error('failed:\n  ' + failed.join('\n  ')); process.exit(1); }
})();
