import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

/* Regression tests for the login, session and account-identity fixes. Same
   shape as security.test.mjs: a full KV in place of the fixture's read-only
   one, and outbound fetch stubbed (Resend, Have I Been Pwned, Discord). */

async function setup({ discord } = {}) {
  const f = await fixture();
  const kv = new Map();
  f.env.SESSIONS = {
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async put(k, v) { kv.set(k, String(v)); },
    async delete(k) { kv.delete(k); }
  };
  f.env.RESEND_API_KEY = 'test';
  const mail = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input && input.url || input);
    if (u.startsWith('https://api.resend.com/')) { mail.push(JSON.parse(init.body)); return new Response('{}'); }
    if (u.startsWith('https://api.pwnedpasswords.com/range/')) return new Response('0000000000000000000000000000000000A:0');
    if (u.startsWith('https://discord.com/') && discord) return discord(u, init);
    throw new Error('unexpected fetch ' + u);
  };
  const post = (path, body, cookie, headers = {}) => f.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: JSON.stringify(body)
  });
  const get = (path, cookie, headers = {}) => f.request(path, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
  const cookieOf = res => (res.headers.get('Set-Cookie') || '').split(';')[0];
  // Each from its own connection: signup allows five an hour per address.
  let ip = 0;
  const fresh = () => ({ 'CF-Connecting-IP': '10.200.0.' + (++ip) });
  const signup = async (username, email, password) => {
    const res = await post('/api/signup', { username, email, password }, null, fresh());
    assert.equal(res.status, 200, username);
    return cookieOf(res);
  };
  const resetToken = m => (String(m.html).match(/reset-password\?token=([a-f0-9]+)/) || [])[1];
  const finish = async () => { globalThis.fetch = realFetch; await f.finish(); };
  return { f, kv, mail, post, get, cookieOf, signup, fresh, resetToken, finish };
}

const loggedIn = async (t, cookie) => (await (await t.get('/api/me', cookie)).json()).loggedIn;

test('revoking sessions does not depend on the KV index still listing them', async () => {
  const t = await setup();
  try {
    const first = await t.signup('joan', 'jo@example.com', 'jos-password-11');
    const other = t.cookieOf(await t.post('/api/login', { username: 'joan', password: 'jos-password-11' }));
    // The capped index lost track of the other device.
    t.kv.delete('usess:' + t.f.db.prepare("SELECT id FROM users WHERE username='joan'").get().id);
    assert.equal(await loggedIn(t, other), true);
    const res = await t.post('/api/account/password', { currentPassword: 'jos-password-11', newPassword: 'jos-password-22' }, first);
    assert.equal(res.status, 200);
    assert.equal(await loggedIn(t, other), false, 'the forgotten session is over');
    assert.equal(await loggedIn(t, first), true, 'the tab that changed it keeps its session');
  } finally { await t.finish(); }
});

test('a ban ends sessions, and read routes take isAdmin from D1', async () => {
  const t = await setup();
  try {
    await t.signup('boss', 'boss@example.com', 'bosses-password');
    t.f.db.prepare("UPDATE users SET is_admin=1 WHERE username='boss'").run();
    await t.signup('kim', 'kim@example.com', 'kims-password-1');
    t.kv.clear();
    const a = t.cookieOf(await t.post('/api/login', { username: 'boss', password: 'bosses-password' }));
    const m = t.cookieOf(await t.post('/api/login', { username: 'kim', password: 'kims-password-1' }));
    // An old session minted when the account was admin: the cookie's flag is
    // not what /api/me (or any read route) goes by.
    const token = m.split('=')[1];
    const stored = JSON.parse(t.kv.get('sess:' + token));
    t.kv.set('sess:' + token, JSON.stringify({ ...stored, isAdmin: true }));
    const me = await (await t.get('/api/me', m)).json();
    assert.equal(me.isAdmin, false);
    t.kv.delete('usess:' + stored.userId);
    const res = await t.post('/api/admin/user', { id: stored.userId, action: 'ban' }, a);
    assert.equal(res.status, 200);
    assert.equal(await loggedIn(t, m), false);
  } finally { await t.finish(); }
});

test('the session cookie is read only under its own name', async () => {
  const t = await setup();
  try {
    const cookie = await t.signup('lee', 'lee@example.com', 'lees-password-1');
    const token = cookie.split('=')[1];
    assert.equal(await loggedIn(t, 'xbotc_session=' + token), false);
    assert.equal(await loggedIn(t, 'theme=dark; botc_session=' + token), true);
  } finally { await t.finish(); }
});

test('a reset link survives a hash upgrade and dies on a real password change', async () => {
  const t = await setup();
  try {
    await t.signup('max', 'max@example.com', 'maxs-password-1');
    await t.post('/api/forgot-password', { email: 'max@example.com' });
    await t.post('/api/forgot-password', { email: 'max@example.com' });
    await Promise.all(t.f.background);
    const [one, two] = t.mail.filter(m => /Reset/.test(m.subject)).map(t.resetToken);
    assert.ok(one && two);
    // The pepper rollout rewrites the hash at the next login; nothing about
    // the password changed.
    t.f.env.PASSWORD_PEPPER = 'pepper-pepper-pepper';
    assert.equal((await t.post('/api/login', { username: 'max', password: 'maxs-password-1' })).status, 200);
    await Promise.all(t.f.background);
    assert.match(t.f.db.prepare("SELECT password_hash FROM users WHERE username='max'").get().password_hash, /keyid=pepper/);
    let res = await t.post('/api/reset-password', { token: one, password: 'maxs-password-2' });
    assert.equal(res.status, 200, 'still good after the upgrade');
    res = await t.post('/api/reset-password', { token: two, password: 'maxs-password-3' });
    assert.equal(res.status, 400, 'the real change killed the other link');
  } finally { await t.finish(); }
});

test('forgot-password answers the same for members, strangers and a failing KV', async () => {
  const t = await setup();
  try {
    await t.signup('ned', 'ned@example.com', 'neds-password-1');
    const known = await t.post('/api/forgot-password', { email: 'ned@example.com' });
    const unknown = await t.post('/api/forgot-password', { email: 'nobody@example.com' });
    assert.equal(known.status, 200); assert.equal(unknown.status, 200);
    assert.deepEqual(await known.json(), await unknown.json());
    t.f.env.SESSIONS.put = async () => { throw new Error('KV quota'); };
    const broken = await t.post('/api/forgot-password', { email: 'ned@example.com' });
    assert.equal(broken.status, 200);
    await Promise.allSettled(t.f.background);
  } finally { await t.finish(); }
});

test('a Discord-only account is not announced to an email-shaped login', async () => {
  const t = await setup();
  try {
    t.f.db.prepare("INSERT INTO users (username, password_hash, email, discord_id) VALUES ('dee', '', 'dee@example.com', '42')").run();
    let res = await t.post('/api/login', { username: 'dee@example.com', password: 'whatever-123' });
    assert.equal(res.status, 401);
    assert.doesNotMatch((await res.json()).error, /Discord/);
    res = await t.post('/api/login', { username: 'dee', password: 'whatever-123' });
    assert.match((await res.json()).error, /Discord/, 'a name is public, so the hint stays');
  } finally { await t.finish(); }
});

test('the wrong-password lock is the same for an email nobody has', async () => {
  const t = await setup();
  try {
    await t.signup('oli', 'oli@example.com', 'olis-password-1');
    for (const email of ['oli@example.com', 'ghost@example.com']) {
      for (let i = 0; i < 20; i++) {
        const res = await t.post('/api/login', { username: email, password: 'guess-' + i }, null, { 'CF-Connecting-IP': '10.1.' + email.length + '.' + i });
        assert.equal(res.status, 401);
      }
      const res = await t.post('/api/login', { username: email, password: 'guess-x' }, null, { 'CF-Connecting-IP': '10.2.2.2' });
      assert.equal(res.status, 429, email);
    }
  } finally { await t.finish(); }
});

test('lookalike Latin letters cannot register a copy of a handle', async () => {
  const t = await setup();
  try {
    await t.signup('alice', 'a1@example.com', 'alices-password');
    await t.signup('liz', 'l1@example.com', 'lizs-password-1');
    for (const twin of ['ａlice', 'ɑlice', 'ᴀlice', 'ⅼiz', 'lⅰz']) {
      const res = await t.post('/api/signup', { username: twin, email: 'twin' + Math.random() + '@example.com', password: 'twins-password-1' }, null, t.fresh());
      assert.equal(res.status, 409, twin);
    }
    // And a lookalike typed at login finds the real account.
    assert.equal((await t.post('/api/login', { username: 'ａlice', password: 'alices-password' })).status, 200);
  } finally { await t.finish(); }
});

test('a legacy account whose folded key collides can still log in by its exact handle', async () => {
  const t = await setup();
  try {
    const hash = await t.f.hooks.hashPassword(t.f.env, 'plain-alice-pw');
    const hash2 = await t.f.hooks.hashPassword(t.f.env, 'wide-alice-pw');
    // Keyed under the old rules: the fullwidth name had a key of its own.
    t.f.db.exec('ALTER TABLE users ADD COLUMN username_key TEXT; CREATE UNIQUE INDEX idx_users_username_key ON users(username_key)');
    t.f.db.prepare("INSERT INTO users (username, username_key, password_hash, email) VALUES ('alice','alice',?, 'p@example.com')").run(hash);
    t.f.db.prepare("INSERT INTO users (username, username_key, password_hash, email) VALUES ('ａlice','ａlice',?, 'w@example.com')").run(hash2);
    assert.equal((await t.post('/api/login', { username: 'alice', password: 'plain-alice-pw' })).status, 200);
    assert.equal((await t.post('/api/login', { username: 'ａlice', password: 'wide-alice-pw' })).status, 200);
    const keys = t.f.db.prepare('SELECT username_key FROM users ORDER BY id').all().map(r => r.username_key);
    assert.equal(new Set(keys).size, 2, 'no two accounts share a key');
  } finally { await t.finish(); }
});

test('two signups racing onto one email or one name get a 409, not a 500', async () => {
  const t = await setup();
  try {
    await t.signup('pam', 'pam@example.com', 'pams-password-1');
    // Both pre-checks miss, as they would for the second of two racing
    // requests; the UNIQUE indexes have to catch it.
    t.f.state.intercept = ({ sql, value }) => /^SELECT (1|id) FROM users WHERE/.test(sql.trim()) ? null : value;
    let res = await t.post('/api/signup', { username: 'pammy', email: 'PAM@example.com', password: 'pams-password-2' }, null, t.fresh());
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /email/);
    res = await t.post('/api/signup', { username: 'pam', email: 'other@example.com', password: 'pams-password-2' }, null, t.fresh());
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /username/);
    t.f.state.intercept = null;
    assert.equal(t.f.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  } finally { await t.finish(); }
});

test('starting a Discord sign-in is rate-limited per connection', async () => {
  const t = await setup();
  try {
    t.f.env.DISCORD_CLIENT_ID = 'cid'; t.f.env.DISCORD_CLIENT_SECRET = 'secret';
    const ip = { 'CF-Connecting-IP': '10.3.3.3' };
    for (let i = 0; i < 30; i++) {
      const res = await t.get('/api/auth/discord', null, ip);
      assert.match(res.headers.get('Location'), /^https:\/\/discord\.com\//);
    }
    const res = await t.get('/api/auth/discord', null, ip);
    assert.match(res.headers.get('Location'), /\/login\?error=/);
    assert.equal([...t.kv.keys()].filter(k => k.startsWith('oauth:')).length, 30);
  } finally { await t.finish(); }
});

test('the Discord callback fails into /login, and never moves an existing Discord link', async () => {
  let mode = 'ok';
  const t = await setup({
    discord(u) {
      if (mode === 'down') throw new Error('network');
      if (u.endsWith('/oauth2/token')) return new Response(mode === 'garbage' ? 'not json' : '{"access_token":"x"}');
      return new Response(JSON.stringify({ id: '777', username: 'q', email: 'quinn@example.com', verified: true }));
    }
  });
  try {
    t.f.env.DISCORD_CLIENT_ID = 'cid'; t.f.env.DISCORD_CLIENT_SECRET = 'secret';
    const state = async () => {
      const loc = (await t.get('/api/auth/discord')).headers.get('Location');
      return new URL(loc).searchParams.get('state');
    };
    // An over-long state is a sign-in that timed out, not a crash.
    let res = await t.f.safeRequest('/api/auth/discord/callback?code=c&state=' + 'a'.repeat(5000));
    assert.match(res.headers.get('Location') || '', /\/login\?error=/);
    for (mode of ['down', 'garbage']) {
      res = await t.f.safeRequest('/api/auth/discord/callback?code=c&state=' + await state());
      assert.match(res.headers.get('Location') || '', /\/login\?error=/, mode);
    }
    mode = 'ok';
    // Same verified email, but the account already signs in with another Discord.
    t.f.db.prepare("INSERT INTO users (username, password_hash, email, email_verified, discord_id) VALUES ('quinn', '', 'quinn@example.com', 1, '555')").run();
    res = await t.get('/api/auth/discord/callback?code=c&state=' + await state());
    assert.match(res.headers.get('Location'), /\/login\?error=.*different%20Discord/);
    assert.equal(t.f.db.prepare("SELECT discord_id FROM users WHERE username='quinn'").get().discord_id, '555');
  } finally { await t.finish(); }
});
