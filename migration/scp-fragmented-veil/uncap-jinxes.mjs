// Once the Worker dropped its 60-jinx cap: write Abysewhell's and
// Cespholopod's full jinx lists onto the live rows and drop the "More
// jinxes" box that held the overflow. Only those two keys change; ASCII-only
// SQL (char(n) for everything else). Reads stored.json from through-worker.mjs.
import fs from 'fs';
const st = JSON.parse(fs.readFileSync(new URL('./stored.json', import.meta.url)));
const ascii = text => {
  const out = []; let buf = '', cps = [];
  const a = () => { if (buf) out.push("'" + buf.replace(/'/g, "''") + "'"); buf = ''; };
  const u = () => { for (let i = 0; i < cps.length; i += 50) out.push('char(' + cps.slice(i, i + 50).join(',') + ')'); cps = []; };
  for (const ch of text) { const c = ch.codePointAt(0); if (c < 128) { u(); buf += ch; } else { a(); cps.push(c); } }
  a(); u();
  return out.join(' || ');
};
for (const slug of ['abysewhell', 'cespholopod']) {
  const d = JSON.parse(st.characters.find(c => c.slug === slug).data);
  fs.writeFileSync(new URL('./sql/uncap-' + slug + '.sql', import.meta.url),
    "UPDATE characters SET data = json_remove(json_set(data, '$.jinxes', json(" + ascii(JSON.stringify(d.jinxes)) +
    ")), '$.customBoxes'), updated_at = datetime('now') WHERE slug = '" + slug + "';\n");
}
