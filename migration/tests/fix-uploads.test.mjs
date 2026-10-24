import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';
import * as Bloodstar from '../../worker/bloodstar.js';

const member = id => ({ Cookie: 'botc_session=user-' + id });
function users(f, ids = [1, 2, 3]) {
  for (const id of ids) {
    f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(?,?,'')").run(id, 'user-' + id);
    f.state.sessions.set('sess:user-' + id, { userId: id, username: 'user-' + id });
  }
}
const sess = id => ({ userId: id, username: 'user-' + id });
const own = (f, table, slug, id) => f.db.prepare(`UPDATE ${table} SET owner_id=? WHERE slug=?`).run(id, slug);
const png = 'data:image/png;base64,' + Buffer.alloc(1000, 1).toString('base64');

// A stand-in bucket: put/get/head/delete/list with the owner stamp and etags.
function bucket(f) {
  const objects = new Map();
  let n = 0;
  const meta = (key, o) => ({
    key, size: o.body.length, etag: o.etag, httpEtag: '"' + o.etag + '"', uploaded: null,
    customMetadata: o.custom || {},
    writeHttpMetadata(h) { h.set('Content-Type', key.endsWith('.webp') ? 'image/webp' : 'image/png'); }
  });
  f.env.ART = {
    objects,
    set(key, body, custom) { objects.set(key, { body: Buffer.from(body), etag: 'e' + (++n), custom }); },
    async put(key, body, opts) {
      objects.set(key, { body: Buffer.from(body), etag: 'e' + (++n), custom: opts && opts.customMetadata });
      return { etag: 'e' + n };
    },
    async head(key) { const o = objects.get(key); return o ? meta(key, o) : null; },
    async get(key, opts) {
      const o = objects.get(key); if (!o) return null;
      const m = meta(key, o);
      const inm = opts?.onlyIf?.get?.('If-None-Match');
      return inm === m.httpEtag ? m : { ...m, body: new Blob([o.body]).stream() };
    },
    async delete(keys) { for (const k of [].concat(keys)) objects.delete(k); },
    async list({ prefix }) {
      return { truncated: false, objects: [...objects.keys()].filter(k => k.startsWith(prefix)).map(k => meta(k, objects.get(k))) };
    }
  };
  return f.env.ART;
}

test('a script or collection image key that names two pages never lets one owner write the other\'s file', async t => {
  const f = await fixture(); t.after(() => f.finish()); users(f); const art = bucket(f);
  f.insert('scripts', 'night', { name: 'Night' }); own(f, 'scripts', 'night', 1);
  f.insert('scripts', 'night-logo', { name: 'Night Logo' }); own(f, 'scripts', 'night-logo', 2);
  const denied = (id, key) => f.hooks.uploadSlotDenied(f.env, sess(id), key);
  // Nobody's file there yet: night-logo's owner may put its header in.
  assert.equal(await denied(2, 'scripts/night-logo.png'), null);
  // Night's logo is in that slot now: night-logo's owner may not write over it…
  art.set('scripts/night-logo.png', 'x', { owner: '1' });
  assert.equal((await denied(2, 'scripts/night-logo.png')).status, 403);
  // …and night's owner may not write over night-logo's header either.
  art.set('scripts/night-logo.png', 'x', { owner: '2' });
  assert.equal((await denied(1, 'scripts/night-logo.png')).status, 403);
  // An account that owns neither page is refused outright.
  assert.equal((await denied(3, 'scripts/night-logo.png')).status, 403);
  // Unambiguous keys are untouched: a page's own slot, whoever uploaded the file.
  art.set('scripts/night-bg.png', 'x', { owner: '9' });
  assert.equal(await denied(1, 'scripts/night-bg.png'), null);
  assert.equal((await denied(2, 'scripts/night-bg.png')).status, 403);
  // Collections resolve the same way (kebab id or PK slug).
  f.insert('collections', 'Odd', { id: 'odd', displayName: 'Odd' }); own(f, 'collections', 'Odd', 1);
  f.insert('collections', 'odd-logo', { id: 'odd-logo', displayName: 'Odd Logo' }); own(f, 'collections', 'odd-logo', 2);
  art.set('collections/odd-logo.png', 'x', { owner: '1' });
  assert.equal((await denied(2, 'collections/odd-logo.png')).status, 403);
});

test('a character called "Imp Alt" cannot overwrite Imp\'s second icon', async t => {
  const f = await fixture(); t.after(() => f.finish()); users(f); const art = bucket(f);
  f.insert('characters', 'imp', { name: 'Imp', artAlt: 'art/imp-alt.png' }); own(f, 'characters', 'imp', 1);
  art.set('art/imp-alt.png', 'x', { owner: '1' });
  const denied = (id, key) => f.hooks.uploadSlotDenied(f.env, sess(id), key);
  // Before the "Imp Alt" row exists, the key is Imp's alone.
  assert.equal((await denied(2, 'art/imp-alt.png')).status, 403);
  f.insert('characters', 'imp-alt', { name: 'Imp Alt' }); own(f, 'characters', 'imp-alt', 2);
  // After: its own row says yes, but Imp's file is in that slot.
  assert.equal((await denied(2, 'art/imp-alt.png')).status, 403);
  assert.equal((await denied(2, 'thumb/imp-alt.png.webp')).status, 403);
  // Imp's owner can still replace their own file.
  assert.equal(await denied(1, 'art/imp-alt.png'), null);
  // With nobody's file in it, the slot is free to whichever page asks first.
  art.objects.delete('art/imp-alt.png');
  assert.equal(await denied(2, 'art/imp-alt.png'), null);
  // A suffixed slot with no row of its own still follows its character,
  // whoever uploaded the file last (the approved-editor / assigned-owner case).
  art.set('art/imp-alt2.png', 'x', { owner: '9' });
  assert.equal(await denied(1, 'art/imp-alt2.png'), null);
});

test('an art key names its own row first: uploads to foo-alt stamp foo-alt, and its editor is not refused', async t => {
  const f = await fixture(); t.after(() => f.finish()); users(f); bucket(f);
  f.db.prepare('UPDATE users SET is_admin=1 WHERE id=1').run();
  f.insert('characters', 'foo', { name: 'Foo', art: 'art/foo.png' });
  f.insert('characters', 'foo-alt', { name: 'Foo Alt', art: 'art/foo-alt.png' });
  f.db.prepare("UPDATE characters SET updated_at='2026-01-01 00:00:00' WHERE slug='foo'").run();
  const stamp = slug => f.db.prepare('SELECT updated_at FROM characters WHERE slug=?').get(slug).updated_at;
  const upload = body => f.request('/api/upload', { method: 'POST',
    headers: { ...member(1), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const loaded = stamp('foo-alt');
  const res = await upload({ key: 'art/foo-alt.png', data: png, baseUpdatedAt: loaded });
  assert.equal(res.status, 200, 'foo-alt\'s own stamp is current, so its upload is not a conflict');
  const body = await res.json();
  assert.notEqual(stamp('foo-alt'), loaded, 'foo-alt\'s version rolls');
  assert.equal(body.updatedAt, stamp('foo-alt'));
  // foo's editor uploading its second icon, with foo's stamp, is not refused either.
  assert.equal((await upload({ key: 'art/foo-alt.png', data: png, baseUpdatedAt: stamp('foo') })).status, 200);
  // A stale stamp still is.
  assert.equal((await upload({ key: 'art/foo-alt.png', data: png, baseUpdatedAt: '2020-01-01 00:00:00' })).status, 409);
});

test('thumbnails and resized copies do not spend the art upload allowance, and bad base64 is a 400', async t => {
  const f = await fixture(); t.after(() => f.finish()); users(f); bucket(f);
  const upload = body => f.request('/api/upload', { method: 'POST',
    headers: { ...member(2), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await upload({ key: 'art/mine.png', data: png })).status, 200);
  f.db.prepare("UPDATE rate_limits SET n=400 WHERE key='rl:upload:u2'").run();
  assert.equal((await upload({ key: 'art/mine-alt.png', data: png })).status, 429);
  const webp = 'data:image/webp;base64,' + Buffer.alloc(1000, 1).toString('base64');
  assert.equal((await upload({ key: 'thumb/mine.png.webp', data: webp })).status, 200);
  assert.ok(f.db.prepare("SELECT n FROM rate_limits WHERE key='rl:uploadcopy:u2'").get().n >= 1);
  assert.equal((await upload({ key: 'art/other.png', data: 'data:image/png;base64,@@not base64@@' })).status, 400);
});

test('HEAD on an R2-only image answers like GET without a body; a current resized copy answers 304', async t => {
  const f = await fixture(); t.after(() => f.finish()); const art = bucket(f);
  art.set('art/r2-only.png', 'x'.repeat(800));
  const head = await f.request('/assets/art/r2-only.png', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Type'), 'image/png');
  assert.equal((await head.text()).length, 0);
  art.set('scripts/banner.png', 'o'.repeat(800));
  const source = art.objects.get('scripts/banner.png').etag;
  art.set('media/320/scripts/banner.png.webp', 'w'.repeat(800), { sourceETag: source });
  const first = await f.request('/assets/media/320/scripts/banner.png.webp');
  assert.equal(first.status, 200);
  const again = await f.request('/assets/media/320/scripts/banner.png.webp', { headers: { 'If-None-Match': first.headers.get('ETag') } });
  assert.equal(again.status, 304);
});

test('a failed avatar upload leaves the old picture in place', async t => {
  const f = await fixture(); t.after(() => f.finish()); users(f); const art = bucket(f);
  art.set('avatars/u2.png', 'old', { owner: '2' });
  art.put = async () => { throw new Error('R2 down'); };
  const webp = 'data:image/webp;base64,' + Buffer.alloc(100, 1).toString('base64');
  await f.request('/api/account/avatar', { method: 'POST', headers: { ...member(2), 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: webp }) }).catch(() => null);
  assert.ok(art.objects.has('avatars/u2.png'));
});

test('the orphan sweep walks thumbnails, resized copies and attachments, matches any file name, and purge re-checks', async t => {
  const f = await fixture(); t.after(() => f.finish()); users(f); const art = bucket(f);
  f.db.prepare('UPDATE users SET is_admin=1 WHERE id=1').run();
  f.state.sessions.set('sess:user-1', { userId: 1, username: 'user-1', isAdmin: true });
  f.insert('characters', 'odd', { name: 'Odd', art: "art/Café d'or (1).png", artAlt: 'https://botchomebrew.wiki/assets/art/space%20name.png' });
  f.insert('scripts', 'sc', { name: 'Sc', header: 'scripts/sc.png' });
  f.db.exec('CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY, images TEXT)');
  f.db.prepare('INSERT INTO comments(images) VALUES(?)').run(JSON.stringify(['/assets/attachments/202610/1-abc.png']));
  for (const k of ["art/Café d'or (1).png", 'art/space name.png', 'art/gone.png', 'thumb/Café d\'or (1).png.webp',
    'thumb/gone.png.webp', 'scripts/sc.png', 'media/320/scripts/sc.png.webp', 'media/320/scripts/old.png.webp',
    'attachments/202610/1-abc.png', 'attachments/202610/1-zzz.png']) art.set(k, 'x');
  const res = await f.request('/api/admin/orphans', { headers: member(1) });
  assert.equal(res.status, 200);
  const orphans = (await res.json()).orphans.map(o => o.key).sort();
  assert.deepEqual(orphans, ['art/gone.png', 'attachments/202610/1-zzz.png', 'media/320/scripts/old.png.webp', 'thumb/gone.png.webp']);
  // A page started using one of these since the scan: purge leaves it.
  f.insert('characters', 'back', { name: 'Back', art: 'art/gone.png' });
  const purge = await f.request('/api/admin/purge-images', { method: 'POST', headers: { ...member(1), 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: ['art/gone.png', 'thumb/gone.png.webp', 'attachments/202610/1-zzz.png', "art/Café d'or (1).png"] }) });
  const out = await purge.json();
  assert.equal(out.deleted, 1); assert.equal(out.skipped, 3);
  assert.ok(art.objects.has('art/gone.png')); assert.ok(!art.objects.has('attachments/202610/1-zzz.png'));
});

test('a backup covers every table there is, and a table never created is empty rather than failed', async t => {
  const f = await fixture(); t.after(() => f.finish()); bucket(f);
  f.db.exec("CREATE TABLE favorites (user_id INTEGER, entity_type TEXT, slug TEXT); INSERT INTO favorites VALUES (1,'character','x')");
  f.db.exec("CREATE TABLE some_later_table (a TEXT); INSERT INTO some_later_table VALUES ('kept')");
  const res = await f.hooks.runBackup(f.env);
  assert.equal(res.ok, true, JSON.stringify(res.failed));
  assert.equal(res.saved.favorites, 1);
  assert.equal(res.saved.some_later_table, 1);
  assert.equal(res.saved.dm_reports, 0);
  assert.equal(res.failed.dm_reports, undefined);
});

test('Bloodstar: the host pin takes own hosts only, and redirects are followed only back onto Bloodstar', async t => {
  assert.equal(Bloodstar.isBloodstarHost('constructor'), false);
  assert.equal(Bloodstar.isBloodstarHost('__proto__'), false);
  assert.equal(Bloodstar.bloodstarHost('toString'), '');
  assert.equal(Bloodstar.bloodstarHost('bloodstar.xyz'), 'www.bloodstar.xyz');
  assert.ok(Bloodstar.bloodstarSource('https://bloodstar.clocktica.com/p/User/almanac.html').error);
  assert.equal(Bloodstar.bloodstarSource('bloodstar.clocktica.com/p/User/Proj/almanac.html').project, 'Proj');
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const asked = [];
  globalThis.fetch = async (url, init) => {
    asked.push(url); assert.equal(init.redirect, 'manual');
    if (url.includes('/evil')) return new Response(null, { status: 302, headers: { Location: 'https://example.com/x' } });
    if (url.includes('/hop')) return new Response(null, { status: 301, headers: { Location: 'http://bloodstar.xyz/p/U/P/script.json' } });
    return new Response('[]');
  };
  await assert.rejects(Bloodstar.fetchBloodstar('https://bloodstar.clocktica.com/p/U/evil/script.json'));
  assert.ok(!asked.some(u => u.includes('example.com')));
  const ok = await Bloodstar.fetchBloodstar('https://bloodstar.clocktica.com/p/U/hop/script.json');
  assert.equal(await ok.text(), '[]');
  assert.equal(asked.at(-1), 'https://www.bloodstar.xyz/p/U/P/script.json');
  // A body read stops at the cap, announced or not.
  const big = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)); } }));
  assert.equal(await Bloodstar.readCapped(big, 10 * 1024), null);
  assert.equal((await Bloodstar.readCapped(new Response('abc'), 10)).length, 3);
});

test('Bloodstar: almanac text keeps spaces outside marks, finds every block, and stays linear on junk', () => {
  assert.equal(Bloodstar.htmlToText('<p>wakes.<em> (aside) </em>Then</p>', 'wiki'), 'wakes. *(aside)* Then');
  assert.equal(Bloodstar.htmlToText('<a href="https://x.test/a_(b)">Link</a>', 'wiki'), '[Link](https://x.test/a_%28b%29)');
  assert.equal(Bloodstar.htmlToText('<table><tr><td>One</td><td>Two</td></tr></table>', 'plain'), 'One Two');
  assert.equal(Bloodstar.decodeEntities('&#12ab; &#65; &constructor;'), '&#12ab; A &constructor;');
  const page = '<ol class="almanac-viewport"><li class="page" id="x"><div class="page-contents townsfolk"><h2>X</h2>' +
    '<div class="tip"><p>Same</p></div><div class="tip"></div><div class="tip"><p>Later</p></div><div class="tip"><p>Same</p></div>' +
    '</div></li></ol>';
  assert.deepEqual(Bloodstar.parseAlmanac(page, 'https://bloodstar.clocktica.com/p/U/P/').entries.x.tips, ['Same', 'Later', 'Same']);
  const junk = '<b x'.repeat(100000) + '<p class="ability">'.repeat(20000) + '<!--'.repeat(20000) + '<em>'.repeat(20000);
  const t0 = Date.now();
  Bloodstar.htmlToText(junk, 'wiki');
  Bloodstar.parseAlmanac('<ol class="almanac-viewport"><li class="page" id="y"><div class="page-contents">' + junk, '');
  assert.ok(Date.now() - t0 < 3000, 'took ' + (Date.now() - t0) + ' ms');
});

test('Bloodstar bundle: absolute images, a third icon, no false warnings, and an empty page has no almanac', () => {
  const source = Bloodstar.bloodstarSource('https://bloodstar.clocktica.com/p/U/P/');
  const official = [{ id: 'chambermaid', name: 'Chambermaid', ability: 'Each night, choose 2 alive players.' }];
  const html = '<ol class="almanac-viewport"><li class="page" id="chambermaid"><div class="page-contents townsfolk"><h2>Chambermaid</h2></div></li>' +
    '<li class="page" id="t"><div class="page-contents traveller"><h2>Trav</h2></div></li></ol>';
  const bundle = Bloodstar.buildBundle([
    { id: '_meta', name: 'P', logo: 'logo.png', background: 'javascript:alert(1)' },
    'chambermaid',
    { id: 't', name: 'Trav', team: 'traveller', ability: 'x', image: ['/p/U/P/t.png', 'https://i.test/g.png', 'e.png'] }
  ], Bloodstar.parseAlmanac(html, source.base), source, official);
  assert.equal(bundle.meta.logo, 'https://bloodstar.clocktica.com/p/U/P/logo.png');
  assert.equal(bundle.meta.background, '');
  const trav = bundle.characters.find(c => c.id === 't');
  assert.equal(trav.image, 'https://bloodstar.clocktica.com/p/U/P/t.png');
  assert.equal(trav.imageAlt, 'https://i.test/g.png');
  assert.equal(trav.imageAlt2, 'https://bloodstar.clocktica.com/p/U/P/e.png');
  assert.equal(trav.hasAlmanac, false);
  assert.deepEqual(bundle.warnings, []);
});
