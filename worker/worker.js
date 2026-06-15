/**
 * BOTC Homebrew Wiki — Cloudflare Worker
 * ----------------------------------------------------------------
 * Option B architecture: the frontend stays static and renders in the
 * browser. This Worker only changes WHERE the data comes from and adds
 * admin authentication for writes.
 *
 * Routes it handles:
 *   GET  /characters.json   -> built from D1 (replaces static file)
 *   GET  /collections.json  -> built from D1
 *   GET  /scripts.json      -> built from D1
 *   POST /api/login         -> admin login, sets session cookie
 *   POST /api/logout        -> clears session
 *   GET  /api/me            -> who am I (is the viewer an admin?)
 *   POST /api/character     -> create/update a character (admin only)
 *   POST /api/collection    -> create/update a collection (admin only)
 *   POST /api/script        -> create/update a script (admin only)
 *   POST /api/seed          -> one-time data load from repo JSON (admin only)
 *   everything else         -> served from static assets (GitHub Pages-style)
 * ----------------------------------------------------------------
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

// ---- password hashing (PBKDF2, matches the seeded admin hash) ----
async function verifyPassword(password, stored) {
  // stored format: pbkdf2_sha256$iterations$salt_b64$hash_b64
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = parseInt(parts[1], 10);
  const salt = base64ToBytes(parts[2]);
  const expected = parts[3];
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password),
    { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key, 256
  );
  return bytesToBase64(new Uint8Array(bits)) === expected;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ---- sessions (stored in KV) ----
async function createSession(env, userId, isAdmin) {
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  const session = JSON.stringify({ userId, isAdmin, created: Date.now() });
  // 30-day expiry
  await env.SESSIONS.put('sess:' + token, session, { expirationTtl: 60 * 60 * 24 * 30 });
  return token;
}
async function getSession(env, request) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/botc_session=([^;]+)/);
  if (!m) return null;
  const raw = await env.SESSIONS.get('sess:' + m[1]);
  if (!raw) return null;
  try { return { token: m[1], ...JSON.parse(raw) }; } catch { return null; }
}
function sessionCookie(token) {
  return `botc_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
}
function clearCookie() {
  return 'botc_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

// ---- build the three JSON files from D1 ----
async function buildCharactersJSON(env) {
  const { results } = await env.DB.prepare('SELECT data FROM characters').all();
  return results.map(r => JSON.parse(r.data));
}
async function buildCollectionsJSON(env) {
  const { results } = await env.DB.prepare('SELECT data FROM collections').all();
  return results.map(r => JSON.parse(r.data));
}
async function buildScriptsJSON(env) {
  const { results } = await env.DB.prepare('SELECT data FROM scripts').all();
  return results.map(r => JSON.parse(r.data));
}

function jsonResponse(obj, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    headers: { ...JSON_HEADERS, 'Cache-Control': 'no-store', ...extraHeaders }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ---------- DATA ENDPOINTS (replace static JSON files) ----------
    if (method === 'GET' && path === '/characters.json') {
      return jsonResponse(await buildCharactersJSON(env));
    }
    if (method === 'GET' && path === '/collections.json') {
      return jsonResponse(await buildCollectionsJSON(env));
    }
    if (method === 'GET' && path === '/scripts.json') {
      return jsonResponse(await buildScriptsJSON(env));
    }

    // ---------- AUTH ----------
    if (method === 'POST' && path === '/api/login') {
      const body = await request.json().catch(() => ({}));
      const { username, password } = body;
      if (!username || !password) return jsonResponse({ error: 'Missing credentials' }, { status: 400 });
      const user = await env.DB.prepare('SELECT id, password_hash, is_admin FROM users WHERE username = ?')
        .bind(username).first();
      if (!user) return jsonResponse({ error: 'Invalid login' }, { status: 401 });
      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) return jsonResponse({ error: 'Invalid login' }, { status: 401 });
      const token = await createSession(env, user.id, !!user.is_admin);
      return jsonResponse({ ok: true, isAdmin: !!user.is_admin }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (method === 'POST' && path === '/api/logout') {
      const sess = await getSession(env, request);
      if (sess) await env.SESSIONS.delete('sess:' + sess.token);
      return jsonResponse({ ok: true }, { 'Set-Cookie': clearCookie() });
    }

    if (method === 'GET' && path === '/api/me') {
      const sess = await getSession(env, request);
      return jsonResponse({ loggedIn: !!sess, isAdmin: sess ? !!sess.isAdmin : false });
    }

    // ---------- WRITES (admin only) ----------
    if (method === 'POST' && path.startsWith('/api/')) {
      const sess = await getSession(env, request);
      if (!sess || !sess.isAdmin) return jsonResponse({ error: 'Not authorized' }, { status: 403 });

      if (path === '/api/character') {
        const c = await request.json();
        if (!c || !c.slug || !c.name || !c.team || !c.ability)
          return jsonResponse({ error: 'Missing required fields' }, { status: 400 });
        await env.DB.prepare(
          `INSERT INTO characters (slug,name,team,creator,owner_id,tags,appears_in,data,updated_at)
           VALUES (?,?,?,?,?,?,?,?,datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             name=excluded.name, team=excluded.team, creator=excluded.creator,
             tags=excluded.tags, appears_in=excluded.appears_in,
             data=excluded.data, updated_at=datetime('now')`
        ).bind(c.slug, c.name, c.team, c.creator || null, sess.userId,
               c.tags || null, c.appearsIn || null, JSON.stringify(c)).run();
        return jsonResponse({ ok: true, slug: c.slug });
      }

      if (path === '/api/collection') {
        const c = await request.json();
        if (!c || !c.slug) return jsonResponse({ error: 'Missing slug' }, { status: 400 });
        await env.DB.prepare(
          `INSERT INTO collections (slug,display_name,owner_id,data,updated_at)
           VALUES (?,?,?,?,datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             display_name=excluded.display_name, data=excluded.data, updated_at=datetime('now')`
        ).bind(c.slug, c.displayName || c.slug, sess.userId, JSON.stringify(c)).run();
        return jsonResponse({ ok: true, slug: c.slug });
      }

      if (path === '/api/script') {
        const s = await request.json();
        if (!s || !s.slug) return jsonResponse({ error: 'Missing slug' }, { status: 400 });
        await env.DB.prepare(
          `INSERT INTO scripts (slug,name,author,owner_id,data,updated_at)
           VALUES (?,?,?,?,?,datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             name=excluded.name, author=excluded.author, data=excluded.data, updated_at=datetime('now')`
        ).bind(s.slug, s.name || s.slug, s.author || null, sess.userId, JSON.stringify(s)).run();
        return jsonResponse({ ok: true, slug: s.slug });
      }

      if (path === '/api/seed') {
        // Safety: refuse if data already exists (prevents accidental overwrite)
        const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM characters').first();
        if (existing && existing.n > 0) {
          return jsonResponse({ error: 'Database already has ' + existing.n + ' characters. Seed aborted to protect data.' }, { status: 409 });
        }
        // Read the JSON files from static assets (already in the repo)
        const origin = new URL(request.url).origin;
        async function loadJSON(file) {
          const res = await env.ASSETS.fetch(new Request(origin + '/' + file));
          if (!res.ok) throw new Error('Could not read ' + file);
          return res.json();
        }
        const [chars, cols, scripts] = await Promise.all([
          loadJSON('characters.json'),
          loadJSON('collections.json'),
          loadJSON('scripts.json')
        ]);
        // Insert everything, owned by the admin (sess.userId)
        const stmts = [];
        for (const c of chars) {
          stmts.push(env.DB.prepare(
            'INSERT OR REPLACE INTO characters (slug,name,team,creator,owner_id,tags,appears_in,data) VALUES (?,?,?,?,?,?,?,?)'
          ).bind(c.slug, c.name, c.team, c.creator || null, sess.userId, c.tags || null, c.appearsIn || null, JSON.stringify(c)));
        }
        for (const c of cols) {
          stmts.push(env.DB.prepare(
            'INSERT OR REPLACE INTO collections (slug,display_name,owner_id,data) VALUES (?,?,?,?)'
          ).bind(c.slug, c.displayName || c.slug, sess.userId, JSON.stringify(c)));
        }
        for (const s of scripts) {
          stmts.push(env.DB.prepare(
            'INSERT OR REPLACE INTO scripts (slug,name,author,owner_id,data) VALUES (?,?,?,?,?)'
          ).bind(s.slug, s.name || s.slug, s.author || null, sess.userId, JSON.stringify(s)));
        }
        await env.DB.batch(stmts);
        return jsonResponse({ ok: true, characters: chars.length, collections: cols.length, scripts: scripts.length });
      }

      return jsonResponse({ error: 'Unknown endpoint' }, { status: 404 });
    }

    // ---------- STATIC ASSETS (pass through to Pages) ----------
    // env.ASSETS is the static site binding (Cloudflare Pages / Workers Assets)
    return env.ASSETS.fetch(request);
  }
};
