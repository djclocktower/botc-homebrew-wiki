import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fixture } from './worker-fixture.mjs';

/* Every page's runtime and head: the login hint cookie, views that a
   prefetch must not count (and the beacon that counts them when shown), the
   deferred SSR scripts with the early announcement, and the pure pieces of
   the site-text observer in site.js. */

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');

async function withKV() {
  const f = await fixture();
  const kv = new Map();
  f.env.SESSIONS = {
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async put(k, v) { kv.set(k, String(v)); },
    async delete(k) { kv.delete(k); }
  };
  return { f, kv };
}
const cookies = res => typeof res.headers.getSetCookie === 'function'
  ? res.headers.getSetCookie() : [res.headers.get('Set-Cookie') || ''];
const hintOf = res => cookies(res).find(c => /^botc_li=/.test(c)) || null;

test('login sets the JS-readable login hint, logout and a dead session clear it', async t => {
  const { f, kv } = await withKV();
  t.after(() => f.finish());
  const hash = await f.hooks.hashPassword(f.env, 'a fine long password');
  f.db.prepare("INSERT INTO users(id,username,password_hash,email) VALUES(5,'ivy',?,'ivy@example.com')").run(hash);
  const post = (path, body, cookie) => f.safeRequest(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body || {})
  });

  const login = await post('/api/login', { username: 'ivy', password: 'a fine long password' });
  assert.equal(login.status, 200);
  const session = cookies(login).find(c => /^botc_session=/.test(c));
  assert.ok(session && /HttpOnly/.test(session));
  const hint = hintOf(login);
  assert.match(hint, /^botc_li=1; Path=\/; Secure; SameSite=Lax; Max-Age=2592000$/);
  assert.doesNotMatch(hint, /HttpOnly/, 'the page has to be able to read it');
  const sessionCookie = session.split(';')[0];

  // A session from before the hint: the next private response carries one…
  const boot = await f.safeRequest('/api/boot', { headers: { Cookie: sessionCookie } });
  assert.match(hintOf(boot) || '', /^botc_li=1;/);
  // …but never one a shared cache could keep, and never twice.
  const asset = await f.safeRequest('/assets/styles.css', { headers: { Cookie: sessionCookie } });
  assert.equal(hintOf(asset), null);
  const again = await f.safeRequest('/api/boot', { headers: { Cookie: sessionCookie + '; botc_li=1' } });
  assert.equal(hintOf(again), null);
  // A logged-out reader gets nothing at all.
  assert.equal(hintOf(await f.safeRequest('/api/boot')), null);

  // /api/me for a session that is gone clears both cookies.
  const me = await f.safeRequest('/api/me', { headers: { Cookie: 'botc_session=gone-token; botc_li=1' } });
  assert.equal((await me.json()).loggedIn, false);
  assert.match(cookies(me).find(c => /^botc_session=/.test(c)), /Max-Age=0/);
  assert.match(hintOf(me), /^botc_li=; .*Max-Age=0/);
  // …and a reader who never logged in is not sent any cookie.
  assert.deepEqual(cookies(await f.safeRequest('/api/me')).filter(Boolean), []);

  const out = await post('/api/logout', {}, sessionCookie + '; botc_li=1');
  assert.equal(out.status, 200);
  assert.match(hintOf(out), /Max-Age=0/);
  assert.equal([...kv.keys()].filter(k => k.startsWith('sess:')).length, 0);
});

test('a prefetch is not a view; the page counts itself through /api/view when shown', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  f.insert('characters', 'seer', { slug: 'seer', name: 'Seer', team: 'townsfolk', art: 'art/demo.png', ability: 'Learn.' });
  f.insert('characters', 'hidden', { slug: 'hidden', name: 'Hidden', team: 'townsfolk', ability: 'Learn.' }, 'draft');
  f.insert('collections', 'The Coll', { id: 'the-coll', displayName: 'The Coll', include: ['seer'] });
  const views = () => {
    try { return f.db.prepare('SELECT entity_type AS t, slug, n FROM page_views ORDER BY t, slug').all().map(r => ({ ...r })); }
    catch { return []; }
  };
  const ua = { 'User-Agent': 'Mozilla/5.0 (Phone) Chrome/141', Accept: 'text/html' };
  const flush = async () => { await Promise.all(f.background.splice(0)); };

  await f.request('/c/test-set/seer', { headers: { ...ua, 'Sec-Purpose': 'prefetch' } }); await flush();
  // The cached copy is a hit now; a prefetch of it does not count either.
  await f.request('/c/test-set/seer', { headers: { ...ua, 'Sec-Purpose': 'prefetch' } }); await flush();
  assert.deepEqual(views(), []);
  await f.request('/c/test-set/seer', { headers: ua }); await flush();
  assert.deepEqual(views(), [{ t: 'character', slug: 'seer', n: 1 }]);

  const beacon = (body, headers = {}) => f.request('/api/view', {
    method: 'POST', headers: { 'Content-Type': 'text/plain', ...ua, ...headers }, body: JSON.stringify(body)
  });
  assert.equal((await beacon({ type: 'character', slug: 'seer' })).status, 204);
  assert.deepEqual(views(), [{ t: 'character', slug: 'seer', n: 2 }]);
  // A collection page states its kebab id; the view lands on the stored key.
  assert.equal((await beacon({ type: 'collection', slug: 'the-coll' })).status, 204);
  // Drafts, unknown pages and types, and bots are never counted.
  await beacon({ type: 'character', slug: 'hidden' });
  await beacon({ type: 'character', slug: 'nobody' });
  await beacon({ type: 'user', slug: 'seer' });
  await beacon({ type: 'character', slug: 'seer' }, { 'User-Agent': 'Discordbot/2.0' });
  assert.deepEqual(views(), [{ t: 'character', slug: 'seer', n: 2 }, { t: 'collection', slug: 'The Coll', n: 1 }]);
  // Garbage is a quiet 204, never an error page.
  const junk = await f.request('/api/view', { method: 'POST', headers: ua, body: 'not json' });
  assert.equal(junk.status, 204);
});

test('server-rendered pages defer every script and paint a remembered announcement before the body', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  f.insert('characters', 'seer', { slug: 'seer', name: 'Seer', team: 'townsfolk', art: 'art/demo.png', ability: 'Learn.' });
  const res = await f.request('/c/test-set/seer', { headers: { Accept: 'text/html' } });
  const html = await res.text();
  const tags = html.match(/<script src="[^"]*"[^>]*>/g) || [];
  assert.ok(tags.length > 3);
  for (const tag of tags) assert.match(tag, / defer>$/, tag);
  assert.ok(/<head>[\s\S]*data\.[^"]*js" defer>[\s\S]*<\/head>/.test(html), 'data.js stays first, in the head');
  // The early bar is right after <body>, before the top bar.
  const body = html.indexOf('<body'), early = html.indexOf('botc_announce'), bar = html.indexOf('class="topbar"');
  assert.ok(body < early && early < bar);
  // Hints: the faces, the parchment and the phone background, nothing more.
  const link = res.headers.get('Link');
  for (const want of ['styles', 'header-redesign', 'trade-gothic-lt-std.woff2', 'dumbledor2.woff2',
    'trade-gothic-lt-std-bold-condensed.woff2', 'parchment.webp', 'bg-m.webp>; rel=preload; as=image; type=image/webp; media="(max-width: 760px)"']) {
    assert.ok(link.includes(want), want);
  }
  assert.equal(link.split(', <').length, 7);

  // Run the inline lines against a minimal document, as a returning reader.
  const start = html.lastIndexOf('<script>', early) + '<script>'.length;
  const script = html.slice(start, html.indexOf('</script>', early));
  const run = (stored, dismissed) => {
    const inserted = [];
    const el = tag => ({ tag, attrs: {}, children: [], setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); } });
    const store = { botc_announce: stored, botc_announce_dismissed: dismissed };
    vm.runInNewContext(script, {
      localStorage: { getItem: k => store[k] == null ? null : store[k] },
      document: { createElement: el, body: { firstChild: null, insertBefore: n => inserted.push(n) } },
      Date, JSON
    });
    return inserted;
  };
  const ann = text => JSON.stringify({ ts: Date.now(), ann: { text } });
  const [shown] = run(ann('Read the [new rules](/p/rules) today'));
  assert.equal(shown.className, 'site-announcement');
  assert.equal(shown.attrs['data-text'], 'Read the [new rules](/p/rules) today');
  assert.equal(shown.children[0].textContent, 'Read the new rules today');
  assert.equal(shown.children[1].className, 'site-announcement-close');
  assert.equal(run(ann('Old news'), 'Old news').length, 0, 'a dismissed message stays dismissed');
  assert.equal(run(JSON.stringify({ ts: Date.now() - 4 * 864e5, ann: { text: 'Stale' } })).length, 0);
  assert.equal(run(null).length, 0);
});

test('static pages announce data.js and the same faces and textures in _headers', async () => {
  const headers = await read('_headers');
  const lines = headers.split('\n').filter(l => /^\s+Link:/.test(l));
  assert.equal(lines.length, 2);
  for (const l of lines) {
    for (const want of ['</assets/data.js>; rel=preload; as=script', 'trade-gothic-lt-std-bold-condensed.woff2', 'parchment.webp', 'media="(max-width: 760px)"']) {
      assert.ok(l.includes(want), want);
    }
  }
});

test('site-text observer: quick rejects, placeholder needles, and only the outermost touched nodes', async () => {
  const noop = () => {};
  const list = () => [];
  const el = { setAttribute: noop, addEventListener: noop, appendChild: noop, querySelector: () => null, querySelectorAll: list, classList: { toggle: noop, add: noop, contains: () => false } };
  const document = {
    body: null, documentElement: null, title: '', readyState: 'complete', cookie: '',
    querySelector: () => null, querySelectorAll: list, getElementById: () => null,
    createElement: () => el, addEventListener: noop, head: el
  };
  const window = {
    BotcData: { boot: () => new Promise(noop), me: () => new Promise(noop), root: () => '', loginHint: () => false, forgetMe: noop },
    addEventListener: noop
  };
  const context = vm.createContext({ window, document, localStorage: { getItem: () => null, setItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop }, location: { pathname: '/team' }, setTimeout, Set, WeakMap, JSON, Math, Date });
  vm.runInContext(await read('assets/site.js'), context);
  const I = window.SiteText.internals;

  const rules = [{ o: 'Each night', r: 'Every night' }, { o: 'Add {missing} to fix.', r: 'Fix by adding {missing}.' }].map(I.compile);
  const n = I.needlesFor(rules);
  assert.deepEqual([...n.list].sort(), [' to fix.', 'Each night'].sort());
  assert.equal(n.any, false);
  assert.equal(I.textMayMatch(n, 'A card about the Imp'), false);
  assert.equal(I.textMayMatch(n, 'Add tags to fix.'), true);
  assert.equal(I.textMayMatch(n, 'Each night, learn'), true);
  assert.equal(I.textMayMatch(I.needlesFor([I.compile({ o: '{x}', r: 'y' })]), 'anything'), true, 'an all-placeholder rule can never be skipped');

  // A batch of records: a grid and the cards inside it, a card twice, a
  // detached node. Only the grid (and the unrelated node) need walking.
  const grid = { parentNode: { parentNode: null } };
  const card1 = { parentNode: grid }, card2 = { parentNode: grid }, text = { parentNode: card1 };
  const other = { parentNode: { parentNode: null } }, gone = { parentNode: null, gone: true };
  const roots = I.rootsOf([card1, grid, card2, card1, text, other, gone], node => !node.gone);
  assert.equal(roots.length, 2);
  assert.ok(roots[0] === grid && roots[1] === other);
});

test('who is reading: no /api/me without a login hint, one shared request with it', async () => {
  const run = async ({ cookie, bootSetsHint }) => {
    const calls = [];
    const doc = { baseURI: 'https://botchomebrew.wiki/', cookie, body: null };
    const session = new Map();
    const context = vm.createContext({
      window: {}, URL, location: { origin: 'https://botchomebrew.wiki', protocol: 'https:' }, document: doc,
      sessionStorage: { getItem: k => session.get(k) ?? null, setItem: (k, v) => session.set(k, v), removeItem: k => session.delete(k) },
      localStorage: { getItem: () => null },
      fetch: async url => {
        calls.push(url);
        if (url === '/api/boot' && bootSetsHint) doc.cookie = 'botc_li=1';
        return { ok: true, json: async () => url === '/api/me' ? { loggedIn: true, username: 'ivy' } : { items: [] } };
      }
    });
    vm.runInContext(await read('assets/data.js'), context);
    const B = context.window.BotcData;
    const [a, b] = await Promise.all([B.me(), B.me()]);
    return { calls, a, b, again: await B.me() };
  };
  // A reader who never logged in: boot only, never /api/me.
  let r = await run({ cookie: '' });
  assert.deepEqual(r.calls, ['/api/boot']);
  assert.equal(r.a.loggedIn, false);
  // Logged in: one /api/me for any number of askers.
  r = await run({ cookie: 'other=1; botc_li=1' });
  assert.deepEqual(r.calls, ['/api/me']);
  assert.ok(r.a === r.b && r.a === r.again && r.a.loggedIn);
  // A session from before the hint: boot hands the hint over, then /api/me.
  r = await run({ cookie: '', bootSetsHint: true });
  assert.deepEqual(r.calls, ['/api/boot', '/api/me']);
  assert.equal(r.a.loggedIn, true);
});
