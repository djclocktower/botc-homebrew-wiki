import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

/* Account security: hashing, email links, brute force, cross-site writes and
   the headers every response carries. The fixture's KV only reads, so each
   test swaps in a full one, and outbound fetch (Resend, Have I Been Pwned) is
   stubbed so nothing leaves the machine. */

async function setup({ pepper, breached = [] } = {}) {
  const f = await fixture();
  const kv = new Map();
  f.env.SESSIONS = {
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async put(k, v) { kv.set(k, String(v)); },
    async delete(k) { kv.delete(k); }
  };
  f.env.RESEND_API_KEY = 'test';
  if (pepper) f.env.PASSWORD_PEPPER = pepper;
  const mail = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input && input.url || input);
    if (u.startsWith('https://api.resend.com/')) {
      mail.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    if (u.startsWith('https://api.pwnedpasswords.com/range/')) {
      const prefix = u.slice(-5);
      const lines = [];
      for (const pw of breached) {
        const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(pw));
        const hex = [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        if (hex.startsWith(prefix)) lines.push(hex.slice(5) + ':42');
      }
      lines.push('0000000000000000000000000000000000A:0');
      return new Response(lines.join('\r\n'));
    }
    throw new Error('unexpected fetch ' + u);
  };
  const restore = () => { globalThis.fetch = realFetch; };
  const post = (path, body, cookie, headers = {}) => f.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: JSON.stringify(body)
  });
  const cookieOf = res => (res.headers.get('Set-Cookie') || '').split(';')[0];
  const linkToken = (m, path) => {
    const hit = String(m.html).match(new RegExp(path.replace('?', '\\?') + 'token=([a-f0-9]+)'));
    return hit && hit[1];
  };
  const finish = async () => { restore(); await f.finish(); };
  return { f, kv, mail, post, cookieOf, linkToken, finish };
}

test('passwords are salted, peppered when configured, and upgraded on login', async () => {
  const t = await setup();
  try {
    let res = await t.post('/api/signup', { username: 'alice', email: 'alice@example.com', password: 'correct horse battery' });
    assert.equal(res.status, 200);
    res = await t.post('/api/signup', { username: 'bob', email: 'bob@example.com', password: 'correct horse battery' });
    assert.equal(res.status, 200);
    const rows = t.f.db.prepare('SELECT username, password_hash FROM users ORDER BY id').all();
    assert.match(rows[0].password_hash, /^pbkdf2_sha256\$100000\$/);
    assert.notEqual(rows[0].password_hash, rows[1].password_hash, 'same password, different salt');
    assert.ok(!rows[0].password_hash.includes('correct horse'));

    // A pepper added later moves the account onto it at the next login.
    t.f.env.PASSWORD_PEPPER = 'a-long-random-secret';
    res = await t.post('/api/login', { username: 'alice', password: 'correct horse battery' });
    assert.equal(res.status, 200);
    await Promise.all(t.f.background);
    const after = t.f.db.prepare("SELECT password_hash FROM users WHERE username='alice'").get().password_hash;
    assert.match(after, /^pbkdf2_sha256p\$/);
    res = await t.post('/api/login', { username: 'alice', password: 'correct horse battery' });
    assert.equal(res.status, 200, 'the upgraded hash still verifies');
    res = await t.post('/api/login', { username: 'alice', password: 'wrong horse battery' });
    assert.equal(res.status, 401);
    // Without the pepper a peppered hash can never match.
    delete t.f.env.PASSWORD_PEPPER;
    res = await t.post('/api/login', { username: 'alice', password: 'correct horse battery' });
    assert.equal(res.status, 401);
  } finally { await t.finish(); }
});

test('breached, too-short and username-as-password are refused', async () => {
  const t = await setup({ breached: ['password123'] });
  try {
    let res = await t.post('/api/signup', { username: 'carol', email: 'carol@example.com', password: 'password123' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /breach/);
    res = await t.post('/api/signup', { username: 'carol', email: 'carol@example.com', password: 'short' });
    assert.equal(res.status, 400);
    res = await t.post('/api/signup', { username: 'carolyn', email: 'carol@example.com', password: 'carolyn' });
    assert.equal(res.status, 400);
    res = await t.post('/api/signup', { username: 'carol', email: 'carol@example.com', password: 'x'.repeat(201) });
    assert.equal(res.status, 400);
  } finally { await t.finish(); }
});

test('a verification link only verifies the address it was sent to', async () => {
  const t = await setup();
  try {
    const res = await t.post('/api/signup', { username: 'dave', email: 'dave@example.com', password: 'dave-is-great-42' });
    const cookie = t.cookieOf(res);
    await Promise.all(t.f.background);
    const token = t.linkToken(t.mail.find(m => m.to[0] === 'dave@example.com'), '/api/verify-email?');
    assert.ok(token);
    assert.ok(![...t.kv.keys()].some(k => k.includes(token)), 'KV stores only a hash of the token');

    // Point the account at somebody else's address, then use the old link.
    const ch = await t.post('/api/account/email', { email: 'victim@example.com', currentPassword: 'dave-is-great-42' }, cookie);
    assert.equal(ch.status, 200);
    const v = await t.f.request('/api/verify-email?token=' + token);
    assert.match(v.headers.get('Location'), /verified=0/);
    assert.equal(t.f.db.prepare("SELECT email_verified FROM users WHERE username='dave'").get().email_verified, 0);

    // The old address was told about the change.
    await Promise.all(t.f.background);
    assert.ok(t.mail.some(m => m.to[0] === 'dave@example.com' && /email address was changed/i.test(m.subject)));

    // The link sent to the new address does verify it, once.
    const fresh = t.linkToken(t.mail.filter(m => m.to[0] === 'victim@example.com').pop(), '/api/verify-email?');
    const ok = await t.f.request('/api/verify-email?token=' + fresh);
    assert.match(ok.headers.get('Location'), /verified=1/);
    const again = await t.f.request('/api/verify-email?token=' + fresh);
    assert.match(again.headers.get('Location'), /verified=0/);
  } finally { await t.finish(); }
});

test('changing the email needs the current password', async () => {
  const t = await setup();
  try {
    const cookie = t.cookieOf(await t.post('/api/signup', { username: 'erin', email: 'erin@example.com', password: 'erins-password-9' }));
    let res = await t.post('/api/account/email', { email: 'thief@example.com' }, cookie);
    assert.equal(res.status, 403);
    res = await t.post('/api/account/email', { email: 'thief@example.com', currentPassword: 'nope-nope-nope' }, cookie);
    assert.equal(res.status, 403);
    assert.equal(t.f.db.prepare("SELECT email FROM users WHERE username='erin'").get().email, 'erin@example.com');
  } finally { await t.finish(); }
});

test('a reset link is single-use and dies when the password changes', async () => {
  const t = await setup();
  try {
    await t.post('/api/signup', { username: 'frank', email: 'frank@example.com', password: 'franks-first-pw' });
    await t.post('/api/forgot-password', { email: 'frank@example.com' });
    await t.post('/api/forgot-password', { email: 'frank@example.com' });
    await Promise.all(t.f.background);
    const links = t.mail.filter(m => /Reset/.test(m.subject)).map(m => t.linkToken(m, '/reset-password?'));
    assert.equal(links.length, 2);
    let res = await t.post('/api/reset-password', { token: links[0], password: 'franks-second-pw' });
    assert.equal(res.status, 200);
    res = await t.post('/api/reset-password', { token: links[0], password: 'franks-third-pw' });
    assert.equal(res.status, 400, 'used once');
    res = await t.post('/api/reset-password', { token: links[1], password: 'franks-third-pw' });
    assert.equal(res.status, 400, 'the other outstanding link died with the old password');
    res = await t.post('/api/login', { username: 'frank', password: 'franks-second-pw' });
    assert.equal(res.status, 200);
  } finally { await t.finish(); }
});

test('wrong passwords lock the account, from any connection, until a reset', async () => {
  const t = await setup();
  try {
    await t.post('/api/signup', { username: 'gina', email: 'gina@example.com', password: 'ginas-real-pass' });
    for (let i = 0; i < 20; i++) {
      const res = await t.post('/api/login', { username: 'gina', password: 'guess-' + i }, null, { 'CF-Connecting-IP': '10.0.0.' + i });
      assert.equal(res.status, 401);
    }
    let res = await t.post('/api/login', { username: 'gina', password: 'ginas-real-pass' }, null, { 'CF-Connecting-IP': '10.9.9.9' });
    assert.equal(res.status, 429);
    await t.post('/api/forgot-password', { email: 'gina@example.com' }, null, { 'CF-Connecting-IP': '10.9.9.9' });
    await Promise.all(t.f.background);
    const token = t.linkToken(t.mail.filter(m => /Reset/.test(m.subject)).pop(), '/reset-password?');
    res = await t.post('/api/reset-password', { token, password: 'ginas-new-pass' }, null, { 'CF-Connecting-IP': '10.9.9.9' });
    assert.equal(res.status, 200);
    res = await t.post('/api/login', { username: 'gina', password: 'ginas-new-pass' }, null, { 'CF-Connecting-IP': '10.9.9.8' });
    assert.equal(res.status, 200);
  } finally { await t.finish(); }
});

test('API writes from another website are refused', async () => {
  const t = await setup();
  try {
    let res = await t.post('/api/login', { username: 'x', password: 'y' }, null, { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    res = await t.post('/api/login', { username: 'x', password: 'y' }, null, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(res.status, 403);
    res = await t.post('/api/login', { username: 'x', password: 'y' }, null, { Origin: 'https://botchomebrew.wiki' });
    assert.equal(res.status, 401, 'same-origin reaches the route');
  } finally { await t.finish(); }
});

test('every Worker response carries the security headers', async () => {
  const t = await setup();
  try {
    const res = await t.f.safeRequest('/api/me');
    assert.equal(res.headers.get('X-Frame-Options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(res.headers.get('Strict-Transport-Security'), /max-age=/);
    const page = await t.f.safeRequest('/no-such-page-anywhere');
    if (/text\/html/.test(page.headers.get('Content-Type') || '')) {
      assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'self'/);
    }
  } finally { await t.finish(); }
});

test('links cannot hide an off-site address behind a backslash or control character', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const box = { module: { exports: {} } };
  vm.runInNewContext(await readFile(new URL('../../assets/render-wiki.js', import.meta.url), 'utf8'), box);
  const WR = box.module.exports;
  assert.equal(typeof WR.inlineFormat, 'function');
  for (const bad of ['/\\evil.example', '\\\\evil.example', 'java\tscript:alert(1)', 'javascript:alert(1)', '//evil.example', '/\u0001/evil.example']) {
    const html = WR.inlineFormat('[x](' + bad + ')');
    assert.ok(!/<a /.test(html), bad + ' -> ' + html);
  }
  assert.match(WR.inlineFormat('[ok](/scripts)'), /<a [^>]*href="\/scripts"/);
  assert.match(WR.inlineFormat('[ok](https://example.com)'), /href="https:\/\/example.com"/);
});

test('admin reads need a live admin session; new members\' emails never leak', async () => {
  const t = await setup();
  try {
    for (const p of ['/api/admin/new-users?days=90', '/api/admin/queue-counts']) {
      const res = await t.f.request(p);
      assert.equal(res.status, 403, p);
      assert.ok(!/@example\.com/.test(await res.text()));
    }
    const cookie = t.cookieOf(await t.post('/api/signup', { username: 'henry', email: 'henry@example.com', password: 'henrys-password' }));
    assert.equal((await t.f.request('/api/admin/new-users', { headers: { Cookie: cookie } })).status, 403);
    // Promoted in D1 but holding a pre-promotion cookie: still refused, as
    // the cookie says not-admin. A fresh login is admin.
    t.f.db.prepare("UPDATE users SET is_admin=1 WHERE username='henry'").run();
    const admin = t.cookieOf(await t.post('/api/login', { username: 'henry', password: 'henrys-password' }));
    assert.equal((await t.f.request('/api/admin/queue-counts', { headers: { Cookie: admin } })).status, 200);
    // Demoted in D1: the admin cookie stops working at once.
    t.f.db.prepare("UPDATE users SET is_admin=0 WHERE username='henry'").run();
    assert.equal((await t.f.request('/api/admin/queue-counts', { headers: { Cookie: admin } })).status, 403);
  } finally { await t.finish(); }
});

test('a page\'s editor list is the owner\'s; a deleted page is not republished by a save', async () => {
  const t = await setup();
  try {
    const owner = t.cookieOf(await t.post('/api/signup', { username: 'ivy', email: 'ivy@example.com', password: 'ivys-password-1' }));
    const ownerId = t.f.db.prepare("SELECT id FROM users WHERE username='ivy'").get().id;
    t.f.insert('characters', 'shared-one', { name: 'Shared One', team: 'townsfolk', ability: 'x', art: 'art/shared-one.png', editors: [{ id: 99, username: 'secret-friend' }], publicEdit: 'approved' });
    t.f.db.prepare("UPDATE characters SET owner_id=? WHERE slug='shared-one'").run(ownerId);
    const anon = await (await t.f.request('/api/page?type=character&slug=shared-one')).json();
    assert.equal(anon.data.editors, undefined);
    const mine = await (await t.f.request('/api/page?type=character&slug=shared-one', { headers: { Cookie: owner } })).json();
    assert.equal(mine.data.editors[0].username, 'secret-friend');

    t.f.db.prepare("UPDATE characters SET status='deleted' WHERE slug='shared-one'").run();
    const res = await t.post('/api/character', { slug: 'shared-one', name: 'Shared One', team: 'townsfolk', ability: 'x', art: 'art/shared-one.png' }, owner);
    assert.equal(res.status, 400);
    assert.equal(t.f.db.prepare("SELECT status FROM characters WHERE slug='shared-one'").get().status, 'deleted');
  } finally { await t.finish(); }
});
