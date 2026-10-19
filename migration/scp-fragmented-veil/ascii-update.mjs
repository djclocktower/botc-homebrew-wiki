// An UPDATE that rewrites one row's data in pure ASCII SQL (every other
// character spelled as char(codepoint)), for rows whose text did not survive
// being pasted into the D1 console intact. Usage: node ascii-update.mjs slug…
import fs from 'fs';
const dir = new URL('./sql/', import.meta.url);
const all = fs.readdirSync(dir).filter(f => /^final-\d+-characters\.sql$/.test(f)).map(f => fs.readFileSync(new URL(f, dir), 'utf8')).join('\n');
for (const slug of process.argv.slice(2)) {
  const m = new RegExp("'(\\{\"slug\":\"" + slug + "\"(?:[^']|'')*)'").exec(all);
  if (!m) throw new Error('no row ' + slug);
  const data = m[1].replace(/''/g, "'");
  const out = []; let buf = '', cps = [];
  const a = () => { if (buf) out.push("'" + buf.replace(/'/g, "''") + "'"); buf = ''; };
  const u = () => { for (let i = 0; i < cps.length; i += 50) out.push('char(' + cps.slice(i, i + 50).join(',') + ')'); cps = []; };
  for (const ch of data) { const c = ch.codePointAt(0); if (c < 128) { u(); buf += ch; } else { a(); cps.push(c); } }
  a(); u();
  fs.writeFileSync(new URL('fix-' + slug + '.sql', dir), "UPDATE characters SET data = " + out.join(' || ') + " WHERE slug='" + slug + "';\n");
}
