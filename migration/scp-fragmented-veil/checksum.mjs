// Expected (length, checksum) per row, computed with the same SQL the live
// check runs, so a row mangled in transit to D1 shows up. Usage:
//   node checksum.mjs            -> prints the SQL to run on D1
//   node checksum.mjs expected   -> prints the expected answers
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
export const SQL = `WITH RECURSIVE r(slug, d, i, s) AS (
  SELECT slug, data, 1, 0 FROM characters WHERE appears_in='SCP Fragmented Veil'
  UNION ALL SELECT slug, d, i + 1, (s + unicode(substr(d, i, 1)) * (i % 13 + 1)) % 1000000007 FROM r WHERE i <= length(d))
SELECT group_concat(slug || ':' || n || ':' || s, ' ') AS sums FROM (SELECT slug, max(i) - 1 AS n, max(s) AS s FROM r GROUP BY slug ORDER BY slug)`;
if (process.argv[2] === 'expected') {
  const st = JSON.parse(fs.readFileSync(new URL('./stored.json', import.meta.url)));
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE characters(slug TEXT, data TEXT, appears_in TEXT)');
  for (const c of st.characters) db.prepare('INSERT INTO characters VALUES(?,?,?)').run(c.slug, c.data, c.appears_in);
  console.log(db.prepare(SQL).get().sums);
} else console.log(SQL);
