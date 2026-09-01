#!/usr/bin/env node
/* Refresh the self-hosted copies of the Google faces (assets/fonts/*.woff2)
   and print the @font-face block for styles.css. Run from the repo root:

     node migration/fetch-google-fonts.js > /tmp/fontfaces.css

   It fetches Google's CSS with a modern browser user-agent (that is what makes
   Google answer with woff2 subsets and unicode-range), keeps the latin and
   latin-ext faces, downloads each file once — Google serves one variable file
   for several weights, so identical files are kept once and declared with a
   weight RANGE — and writes them under stable names. See assets/fonts/README.md.
   The families and weights below are exactly what styles.css used to @import. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FAMILIES = 'family=Libre+Franklin:ital,wght@0,400;0,500;0,600;0,800;1,400' +
  '&family=Oswald:wght@500;600;700&family=EB+Garamond:ital,wght@1,400;1,500' +
  '&family=Cinzel:wght@600;700&family=Pirata+One&family=IM+Fell+English:ital@0;1' +
  '&family=Grenze+Gotisch:wght@400;600&display=swap';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const OUT = path.join(__dirname, '..', 'assets', 'fonts');
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

(async () => {
  const css = await (await fetch('https://fonts.googleapis.com/css2?' + FAMILIES, { headers: { 'User-Agent': UA } })).text();
  const groups = new Map();
  for (const b of css.split('@font-face').slice(1)) {
    const subset = (b.match(/\/\* ([a-z-]+) \*\//) || [])[1];
    if (subset !== 'latin' && subset !== 'latin-ext') continue;
    const fam = b.match(/font-family: '([^']+)'/)[1];
    const style = b.match(/font-style: (\w+)/)[1];
    const weight = +b.match(/font-weight: (\d+)/)[1];
    const url = b.match(/url\((https:[^)]+)\)/)[1];
    const range = b.match(/unicode-range: ([^;]+);/)[1];
    const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
    const md5 = crypto.createHash('md5').update(bytes).digest('hex');
    const k = [fam, style, subset, md5].join('|');
    if (!groups.has(k)) groups.set(k, { fam, style, subset, bytes, range, weights: [] });
    groups.get(k).weights.push(weight);
  }
  const base = g => `${slug(g.fam)}-${g.style === 'italic' ? 'italic' : 'regular'}-${g.subset}`;
  const count = {};
  for (const g of groups.values()) count[base(g)] = (count[base(g)] || 0) + 1;
  const out = [];
  for (const g of groups.values()) {
    const ws = g.weights.sort((a, b) => a - b);
    const name = (count[base(g)] > 1 ? `${base(g)}-${ws[0]}` : base(g)) + '.woff2';
    fs.writeFileSync(path.join(OUT, name), g.bytes);
    const fw = ws.length > 1 ? `${ws[0]} ${ws[ws.length - 1]}` : String(ws[0]);
    out.push(`@font-face {\n  font-family: '${g.fam}';\n  font-style: ${g.style};\n  font-weight: ${fw};\n  font-display: swap;\n  src: url('fonts/${name}') format('woff2');\n  unicode-range: ${g.range};\n}`);
  }
  process.stdout.write(out.join('\n') + '\n');
  console.error(`${groups.size} files written to ${OUT}`);
})().catch(e => { console.error(e); process.exit(1); });
