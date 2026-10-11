// Image delivery: the art display copy (media/full/…), banner sizes that are
// never enlarged and a srcset that only claims true widths, the self-hosted
// small official icons, and the thumbnails /jinxes draws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fixture } from './worker-fixture.mjs';
import PageRender from '../../assets/render-page.js';
import Render from '../../assets/render.js';

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
const member = id => ({ headers: { Cookie: 'botc_session=user-' + id } });
function users(f) {
  for (const id of [1, 2, 3]) {
    f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(?,?,'')").run(id, 'user-' + id);
    f.state.sessions.set('sess:user-' + id, { userId: id, username: 'user-' + id });
  }
}

// Minimal headers that imageDims() reads: a PNG IHDR and a WebP VP8X chunk.
function png(w, h, pad = 900) {
  const b = Buffer.alloc(24 + pad, 1);
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b, 0);
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
function webp(w, h, pad = 900) {
  const b = Buffer.alloc(30 + pad, 0);
  b.write('RIFF', 0); b.writeUInt32LE(22 + pad, 4); b.write('WEBP', 8); b.write('VP8X', 12);
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}

// An R2 stand-in that keeps customMetadata, honours ranged reads and lists.
function r2(f) {
  const objects = new Map(), deleted = [];
  f.env.ART = {
    async head(key) {
      const o = objects.get(key);
      return o ? { etag: o.etag, httpEtag: '"' + o.etag + '"', size: o.body.length, customMetadata: o.meta } : null;
    },
    async get(key, options) {
      const o = objects.get(key); if (!o) return null;
      const body = options && options.range ? o.body.subarray(options.range.offset, options.range.offset + options.range.length) : o.body;
      const md = { size: o.body.length, etag: o.etag, httpEtag: '"' + o.etag + '"', customMetadata: o.meta,
        writeHttpMetadata(h) { h.set('Content-Type', key.endsWith('.webp') ? 'image/webp' : 'image/png'); } };
      return options?.onlyIf?.get?.('If-None-Match') === md.httpEtag ? md : { ...md, body };
    },
    async put(key, bytes, options) {
      const etag = 'etag-' + key.length + '-' + bytes.length + '-' + objects.size;
      objects.set(key, { body: Buffer.from(bytes), etag, meta: (options && options.customMetadata) || {} });
      return { etag };
    },
    async delete(keys) { for (const k of [].concat(keys)) { deleted.push(k); objects.delete(k); } },
    async list({ prefix }) {
      return { truncated: false, objects: [...objects.entries()].filter(([k]) => k.startsWith(prefix))
        .map(([key, o]) => ({ key, size: o.body.length, etag: o.etag, customMetadata: o.meta })) };
    }
  };
  return { objects, deleted, put: (key, body, meta = {}, etag = 'e-' + key) => objects.set(key, { body: Buffer.from(body), etag, meta }) };
}
const upload = (f, id, body) => f.request('/api/upload', { method: 'POST',
  headers: { ...member(id).headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const dataUrl = (type, buf) => 'data:' + type + ';base64,' + buf.toString('base64');

test('a srcset only claims widths its copies really have', () => {
  const attrs = (w) => PageRender.responsiveAttrs('', 'scripts/a.png', 'v1', PageRender.TILE_SIZES, w);
  // Unknown width: the three slots as they always were.
  assert.match(attrs(), /320\/scripts\/a\.png\.webp\?v=v1 320w, .*640w, .*1280\/scripts\/a\.png\.webp\?v=v1 1280w"/);
  // A 400px logo: the 320 copy, then the 640 slot at its true 400px — and nothing claims 1280.
  const narrow = attrs({ 'scripts/a.png': 400 });
  assert.match(narrow, /media\/320\/scripts\/a\.png\.webp\?v=v1 320w, assets\/media\/640\/scripts\/a\.png\.webp\?v=v1 400w"/);
  assert.doesNotMatch(narrow, /1280/);
  // A plain number works too; a source wider than every slot lists all three.
  assert.match(attrs(2000), /1280w"/);
  assert.equal((attrs(300).match(/\dw/g) || []).length, 1);
  // An entry for some other image is ignored.
  assert.match(attrs({ 'scripts/other.png': 100 }), /1280w"/);
  assert.match(PageRender.TILE_SIZES, /210px/);
});

test('banner copies are never enlarged, and the page learns its image width', async t => {
  const f = await fixture(); t.after(() => f.finish()); users(f); const art = r2(f);
  f.db.prepare('UPDATE users SET is_admin=1 WHERE id=1').run();
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Demo', author: 'A', logo: 'scripts/demo-logo.png', characters: [] });
  // The original is stored with its width stamped from its own header.
  const original = await upload(f, 1, { key: 'scripts/demo-logo.png', data: dataUrl('image/png', png(400, 120)) });
  assert.equal(original.status, 200);
  const { etag } = await original.json();
  assert.equal(art.objects.get('scripts/demo-logo.png').meta.w, '400');
  // A "640" copy that is 640px wide is an enlargement of a 400px original: refused.
  const big = await upload(f, 1, { key: 'media/640/scripts/demo-logo.png.webp', data: dataUrl('image/webp', webp(640, 192)), sourceETag: etag });
  assert.equal(big.status, 400);
  assert.ok(!art.objects.has('media/640/scripts/demo-logo.png.webp'));
  // At its true 400px it is accepted, carries its width, and the page records the source width.
  const ok = await upload(f, 1, { key: 'media/640/scripts/demo-logo.png.webp', data: dataUrl('image/webp', webp(400, 120)), sourceETag: etag });
  assert.equal(ok.status, 200);
  assert.equal(art.objects.get('media/640/scripts/demo-logo.png.webp').meta.w, '400');
  const row = JSON.parse(f.db.prepare("SELECT data FROM scripts WHERE slug='demo'").get().data);
  assert.deepEqual(row.imageW, { 'scripts/demo-logo.png': 400 });
  // The script page's logo srcset then stops at the true width.
  const html = await (await f.request('/s/demo')).text();
  assert.match(html, /media\/640\/scripts\/demo-logo\.png\.webp\?v=[a-z0-9]+ 400w/);
  assert.doesNotMatch(html, /demo-logo\.png\.webp\?v=[a-z0-9]+ 1280w/);
});

test('a script save measures its own images and ignores a width a client sends', async t => {
  const f = await fixture(); t.after(() => f.finish()); users(f); const art = r2(f);
  f.db.prepare('UPDATE users SET is_admin=1 WHERE id=1').run();
  // Stored before widths were stamped: read off the first bytes instead.
  art.put('scripts/fresh.png', png(900, 300));
  const save = await f.request('/api/script', { method: 'POST',
    headers: { ...member(1).headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'fresh', name: 'Fresh', author: 'A', header: 'scripts/fresh.png', characters: [],
      imageW: { 'scripts/fresh.png': 5, 'scripts/elsewhere.png': 99 } }) });
  assert.equal(save.status, 200, await save.clone().text());
  const row = JSON.parse(f.db.prepare("SELECT data FROM scripts WHERE slug='fresh'").get().data);
  assert.deepEqual(row.imageW, { 'scripts/fresh.png': 900 });
});

test('character art has a display copy: bound to its original, standing in until made, retired on replace', async t => {
  const f = await fixture(); t.after(() => f.finish()); users(f); const art = r2(f);
  f.insert('characters', 'hero', { slug: 'hero', name: 'Hero', team: 'townsfolk', ability: 'x', art: 'art/hero.png' });
  f.db.prepare("UPDATE characters SET owner_id=1 WHERE slug='hero'").run();
  art.put('art/hero.png', png(591, 591), { w: '591' }, 'orig-1');
  // HEAD on the art answers its ETag without the picture (art-thumb.js binds the copy to it).
  const head = await f.request('/assets/art/hero.png', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('ETag'), '"orig-1"');
  // Same permission as the art: the owner may write the copy, a stranger may not; the token has none.
  assert.equal(await f.hooks.uploadSlotDenied(f.env, { userId: 1 }, 'media/full/art/hero.png.webp'), null);
  assert.equal((await f.hooks.uploadSlotDenied(f.env, { userId: 2 }, 'media/full/art/hero.png.webp')).status, 403);
  assert.equal((await f.hooks.uploadSlotDenied(f.env, { userId: 1 }, 'media/full/art/hero-token.png.webp')).status, 400);
  // Before it exists, the original stands in — for an hour at a versioned URL, not a year.
  const stand = await f.request('/assets/media/full/art/hero.png.webp?v=a');
  assert.equal(stand.status, 200); assert.equal(stand.headers.get('Cache-Control'), 'public, max-age=3600');
  // Made from the current original: served, immutable.
  const made = await upload(f, 1, { key: 'media/full/art/hero.png.webp', data: dataUrl('image/webp', webp(591, 591)), sourceETag: '"orig-1"' });
  assert.equal(made.status, 200);
  const served = await f.request('/assets/media/full/art/hero.png.webp?v=b');
  assert.match(served.headers.get('Cache-Control'), /immutable/);
  assert.equal(served.headers.get('Content-Type'), 'image/webp');
  // Bigger than the original is refused.
  assert.equal((await upload(f, 1, { key: 'media/full/art/hero.png.webp', data: dataUrl('image/webp', webp(800, 800)), sourceETag: '"orig-1"' })).status, 400);
  // Replacing the art retires the thumbnail and the display copy together.
  art.deleted.length = 0;
  assert.equal((await upload(f, 1, { key: 'art/hero.png', data: dataUrl('image/png', png(591, 591)) })).status, 200);
  await Promise.all(f.background);
  assert.ok(art.deleted.includes('thumb/hero.png.webp'));
  assert.ok(art.deleted.includes('media/full/art/hero.png.webp'));
});

test('the /c/ emblem draws the display copy; exports keep the original', async t => {
  const f = await fixture(); t.after(() => f.finish());
  f.insert('characters', 'hero', { slug: 'hero', name: 'Hero', team: 'townsfolk', ability: 'x', art: 'art/hero.png',
    artAlt: 'art/hero-alt.png', token: 'art/hero-token.png', tokenArt: true });
  const page = await (await f.request('/c/test-set/hero')).text();
  const imgs = page.match(/<img class="emblem[^>]*>/g);
  assert.equal(imgs.length, 3);
  assert.match(imgs[0], /width="591" height="591"/);
  assert.match(imgs[0], / src="[^"]*assets\/media\/full\/art\/hero\.png\.webp\?v=/);
  assert.match(imgs[0], /fetchpriority="high"/); assert.match(imgs[0], /decoding="async"/);
  assert.match(imgs[1], / data-src="[^"]*assets\/media\/full\/art\/hero-alt\.png\.webp\?v=/);
  assert.doesNotMatch(imgs[1], /fetchpriority/);
  // The printable token has no display copy.
  assert.match(imgs[2], / data-src="[^"]*assets\/art\/hero-token\.png\?v=/);
  const schema = Render.buildSchema({ slug: 'hero', name: 'Hero', team: 'townsfolk', art: 'art/hero.png', v: 'x' });
  assert.ok(schema.image.every(u => /\/assets\/art\/hero\.png$/.test(u)));
  assert.equal(PageRender.displaySrc({ art: 'art/hero.png', v: 'q' }, ''), 'assets/media/full/art/hero.png.webp?v=q');
  assert.equal(PageRender.displaySrc({ art: 'art/anim.gif' }, ''), 'assets/art/anim.gif');
});

test('official characters are drawn from the small self-hosted icons, with the CDN as fallback', async () => {
  const roles = JSON.parse(await read('assets/roles.json'));
  const files = new Set(await readdir(new URL('../../assets/icons-sm/', import.meta.url)));
  for (const r of roles) assert.ok(files.has(r.id + '.webp'), 'icons-sm/' + r.id + '.webp');
  // A roster row (render-page): the small copy, the CDN image kept for onerror.
  const imp = { slug: 'off-imp', official: true, id: 'imp', name: 'Imp', image: 'https://release.botc.app/x/imp.webp' };
  assert.equal(PageRender.thumbSrc(imp, '../'), '../assets/icons-sm/imp.webp');
  assert.equal(PageRender.thumbFallback(imp), 'https://release.botc.app/x/imp.webp');
  // A jinx target (render.js): the same, and the export URL map is untouched.
  Render.setOfficialIconUrls({ imp: 'https://release.botc.app/x/imp.webp' });
  const t = Render.resolveJinxTarget({ name: 'Imp' }, '../../');
  assert.equal(t.iconSrc, '../../assets/icons-sm/imp.webp');
  assert.equal(t.iconFallback, 'https://release.botc.app/x/imp.webp');
  Render.setOfficialIconUrls(null);
  // Immutable in _headers, like the big ones.
  assert.match(await read('_headers'), /\/assets\/icons-sm\/\*\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable/);
});

test('/api/jinxes draws versioned thumbnails and small official icons', async t => {
  const f = await fixture(); t.after(() => f.finish());
  f.insert('characters', 'hero', { slug: 'hero', name: 'Hero', team: 'townsfolk', ability: 'x', art: 'art/hero.png',
    jinxes: [{ id: 'imp', reason: 'Rule.' }, { name: 'Remote', reason: 'Rule.' }] });
  f.insert('characters', 'remote', { slug: 'remote', name: 'Remote', team: 'minion', ability: 'x', image: 'https://example.com/r.png' });
  const body = await (await f.request('/api/jinxes')).json();
  const hero = body.nodes.find(n => n.slug === 'hero');
  assert.match(hero.icon, /\/assets\/thumb\/hero\.png\.webp\?v=[a-z0-9]+$/);
  assert.equal(body.nodes.find(n => n.slug === 'remote').icon, 'https://example.com/r.png');
  assert.equal(body.nodes.find(n => n.id === 'o:imp').icon, 'https://botchomebrew.wiki/assets/icons-sm/imp.webp');
});

test('no static page still loads the 64 KB parchment JPEG', async () => {
  for (const file of await readdir(new URL('../../', import.meta.url))) {
    if (!file.endsWith('.html')) continue;
    assert.doesNotMatch(await read(file), /parchment\.jpg/, file);
  }
});

test('the backfill scan lists missing or stale display copies and enlarged banner sizes', async t => {
  const f = await fixture(); t.after(() => f.finish()); users(f); const art = r2(f);
  f.db.prepare('UPDATE users SET is_admin=1 WHERE id=1').run();
  f.state.sessions.set('sess:user-1', { userId: 1, username: 'user-1', isAdmin: true });
  for (const slug of ['done', 'stale', 'none']) {
    f.insert('characters', slug, { slug, name: slug, team: 'townsfolk', ability: 'x', art: 'art/' + slug + '.png' });
    art.put('art/' + slug + '.png', png(591, 591), {}, 'orig-' + slug);
    art.put('thumb/' + slug + '.png.webp', webp(192, 192));
  }
  art.put('media/full/art/done.png.webp', webp(591, 591), { sourceETag: 'orig-done', w: '591' });
  art.put('media/full/art/stale.png.webp', webp(591, 591), { sourceETag: 'an-older-original', w: '591' });
  f.insert('scripts', 'old', { slug: 'old', name: 'Old', logo: 'scripts/old.png', imageW: { 'scripts/old.png': 400 } });
  art.put('scripts/old.png', png(400, 100), {}, 'orig-old');
  // Made before the no-enlarging rule: no `w` on them, so they are remade.
  for (const w of [320, 640, 1280]) art.put('media/' + w + '/scripts/old.png.webp', webp(w, 100), { sourceETag: 'orig-old' });
  const scan = await (await f.request('/api/admin/thumb-missing', member(1))).json();
  assert.equal(scan.ok, true, JSON.stringify(scan));
  const by = Object.fromEntries(scan.items.map(it => [it.slug, it]));
  assert.ok(!by.done, 'a current display copy is not listed');
  assert.equal(by.stale.display, true); assert.equal(by.stale.thumb, false);
  assert.equal(by.none.display, true);
  assert.equal(by.old.media, true);
  assert.equal(scan.displays, 1);
});
