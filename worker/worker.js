/**
 * BOTC Homebrew Wiki — Cloudflare Worker
 * ----------------------------------------------------------------
 * Option B architecture: the frontend stays static and renders in the
 * browser. This Worker only changes WHERE the data comes from and adds
 * admin authentication for writes.
 *
 * Routes it handles:
 *   GET  /characters.json     -> built from D1 (replaces static file)
 *   GET  /collections.json    -> built from D1
 *   GET  /scripts.json        -> built from D1
 *   POST /api/login           -> admin login, sets session cookie
 *   POST /api/logout          -> clears session
 *   GET  /api/me              -> who am I (is the viewer an admin?)
 *   GET  /api/admin/dashboard -> dashboard data (admin only)
 *   POST /api/character       -> create/update a character (admin only)
 *   POST /api/collection      -> create/update a collection (admin only)
 *   POST /api/script          -> create/update a script (admin only)
 *   POST /api/lock            -> lock/unlock the wiki (admin only)
 *   POST /api/seed            -> one-time data load from repo JSON (admin only)
 *   everything else           -> served from static assets (GitHub Pages-style)
 * ----------------------------------------------------------------
 */

// esbuild bundles render.js's CommonJS export into the Worker; no DOM here.
import Render from '../assets/render.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

const R2_PREFIXES = ['art/', 'collections/', 'scripts/', 'tokens/'];
const EXT_CONTENT_TYPE = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml'
};

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

// ---- wiki lock (global freeze flag, stored in D1 settings) ----
async function isWikiLocked(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key='wiki_locked'").first();
    return !!row && row.value === '1';
  } catch { return false; }
}

// ---- activity log helper ----
async function logActivity(env, sess, action, entityType, slug, name) {
  let username = null;
  try {
    const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
    username = u ? u.username : null;
  } catch { /* non-fatal: still log with null username */ }
  try {
    await env.DB.prepare(
      `INSERT INTO activity_log (user_id, username, action, entity_type, entity_slug, entity_name)
       VALUES (?,?,?,?,?,?)`
    ).bind(sess.userId, username, action, entityType, slug || null, name || null).run();
  } catch { /* never let logging break a write */ }
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

function attr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderCharacterPage(d, origin) {
  const team = d.team || 'townsfolk';
  const label = (Render.TEAM_LABEL && Render.TEAM_LABEL[team]) || team;
  const name = d.name || 'Character';
  const desc = (d.ability || d.lede || '').trim();
  const pageUrl = origin + '/c/' + d.slug + '.html';
  const img = d.image || (origin + '/assets/' + (d.art || ''));
  const body = Render.renderCharacter(d, '../assets/' + (d.art || ''), '../');
  const crumb =
    '<a href="../index.html">Home</a><span class="sep">›</span>' +
    '<a href="../all-characters.html">Characters</a><span class="sep">·</span>' +
    '<a href="../script.html">Script Builder</a><span class="sep">·</span>' +
    '<a href="../tokens.html">Token Tool</a><span class="sep">›</span>' +
    '<a href="../team.html?t=' + attr(team) + '">' + attr(label) + '</a>' +
    '<span class="sep">›</span><span class="here">' + attr(name) + '</span>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${attr(name)} — BOTC HomeBrew Wiki</title>
<meta name="description" content="${attr(desc)}">
<link rel="canonical" href="${attr(pageUrl)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="BOTC HomeBrew Wiki">
<meta property="og:title" content="${attr(name)}">
<meta property="og:description" content="${attr(desc)}">
<meta property="og:image" content="${attr(img)}">
<meta property="og:url" content="${attr(pageUrl)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${attr(name)}">
<meta name="twitter:description" content="${attr(desc)}">
<meta name="twitter:image" content="${attr(img)}">
<link rel="icon" type="image/png" sizes="64x64" href="../assets/favicon.png">
<link rel="apple-touch-icon" href="../assets/favicon.png">
<link rel="stylesheet" href="../assets/styles.css">
</head>
<body>

  <header class="topbar">
    <div class="brand-group">
      <a class="brand" href="../index.html">
        <img class="brand-skull" src="../assets/logo_skull.png" alt="">
        <img class="brand-header-text" src="../assets/headertext.png" alt="BOTC HomeBrew Wiki">
      </a>
      <img class="topbar-badge" src="../assets/ccc-parchment.png" alt="Community Created Content">
      <a class="edit-link" id="edit-btn" style="display:none" href="#">&#9998; Edit</a>
    </div>
    <nav class="crumb" aria-label="Breadcrumb" id="crumb">${crumb}</nav>
  <div class="search-wrap" id="search-wrap">
    <input class="search-input" id="search-input" type="search" placeholder="Search characters…" autocomplete="off" aria-label="Search characters" aria-expanded="false" aria-haspopup="listbox">
    <div class="search-drop" id="search-drop" role="listbox" aria-label="Search results" hidden></div>
  </div>
  <button class="hamburger" id="hamburger" aria-label="Navigation menu" aria-expanded="false">
    <span></span><span></span><span></span>
  </button>
</header>
<nav class="nav-dropdown" id="nav-dropdown" aria-label="Mobile navigation">
  <div class="nav-dropdown-search">
    <input type="search" id="nav-search-input" placeholder="Search characters…" autocomplete="off">
  </div>
  <a href="../index.html">Home</a>
  <a href="../all-characters.html">All Characters</a>
  <a href="../tags.html">Tags</a>
  <a href="../creators.html">Creators</a>
  <a href="../script.html">Script Builder</a>
  <a href="../create.html">Create a Character</a>
</nav>

  <main class="wrap" id="content">${body}</main>

  <p class="foot">Fan-made content for <em>Blood on the Clocktower</em> &middot; Not affiliated with The Pandemonium Institute</p>

  <script>window.SSR = true; window.LINK_ROOT = '../'; window.CHAR_SLUG = ${JSON.stringify(d.slug)};</script>
  <script src="../assets/render.js"></script>
  <script src="../assets/charpage.js"></script>
  <script src="../assets/site.js"></script>
</body>
</html>`;
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

    // ---------- CHARACTER PAGES (server-side rendered from D1) ----------
    if (method === 'GET' && path.startsWith('/c/')) {
      let slug = decodeURIComponent(path.slice(3));
      if (slug.endsWith('.html')) slug = slug.slice(0, -5);
      if (slug && /^[a-z0-9-]+$/i.test(slug)) {
        const row = await env.DB.prepare('SELECT data FROM characters WHERE slug = ?')
          .bind(slug).first();
        if (row && row.data) {
          const d = JSON.parse(row.data);
          if (!d.slug) d.slug = slug;
          return new Response(renderCharacterPage(d, url.origin), {
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
          });
        }
      }
      // Unknown slug -> fall back to a committed static page (if any), else 404.
      return env.ASSETS.fetch(request);
    }

    // ---------- IMAGE ASSETS (served from R2, fall back to static) ----------
    if (method === 'GET' && path.startsWith('/assets/')) {
      const key = path.slice('/assets/'.length);
      if (env.ART && R2_PREFIXES.some(p => key.startsWith(p))) {
        const obj = await env.ART.get(key);
        if (obj) {
          const headers = new Headers();
          obj.writeHttpMetadata(headers);
          const ext = key.split('.').pop().toLowerCase();
          if (!headers.has('Content-Type') && EXT_CONTENT_TYPE[ext]) {
            headers.set('Content-Type', EXT_CONTENT_TYPE[ext]);
          }
          headers.set('Cache-Control', 'no-cache, must-revalidate');
          if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
          return new Response(obj.body, { headers });
        }
      }
      return env.ASSETS.fetch(request); // not in R2 -> committed static file
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

    // ---------- ADMIN DASHBOARD (read, admin only) ----------
    if (method === 'GET' && path === '/api/admin/dashboard') {
      const sess = await getSession(env, request);
      if (!sess || !sess.isAdmin) return jsonResponse({ error: 'Not authorized' }, { status: 403 });

      const batch = await env.DB.batch([
        env.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM characters)  AS characters,
             (SELECT COUNT(*) FROM collections) AS collections,
             (SELECT COUNT(*) FROM scripts)     AS scripts,
             (SELECT COUNT(*) FROM users)       AS users`),
        env.DB.prepare(
          `SELECT team, COUNT(*) AS n FROM characters GROUP BY team ORDER BY n DESC`),
        env.DB.prepare(
          `SELECT 'character' AS type, slug, name, updated_at FROM characters
           UNION ALL SELECT 'collection', slug, display_name, updated_at FROM collections
           UNION ALL SELECT 'script', slug, name, updated_at FROM scripts
           ORDER BY updated_at DESC LIMIT 15`),
        env.DB.prepare(
          `SELECT 'character' AS type, slug, name, created_at FROM characters
           UNION ALL SELECT 'collection', slug, display_name, created_at FROM collections
           UNION ALL SELECT 'script', slug, name, created_at FROM scripts
           ORDER BY created_at DESC LIMIT 15`),
        env.DB.prepare(
          `SELECT ts, username, action, entity_type, entity_slug, entity_name
           FROM activity_log ORDER BY ts DESC, id DESC LIMIT 25`),
        env.DB.prepare(
          `SELECT username, email, is_admin, created_at FROM users
           ORDER BY created_at DESC LIMIT 15`),
        env.DB.prepare(`SELECT value FROM settings WHERE key='wiki_locked'`)
      ]);

      const lockVal = batch[6].results[0];
      return jsonResponse({
        counts: batch[0].results[0],
        charactersByTeam: batch[1].results,
        recentEdits: batch[2].results,
        recentCreations: batch[3].results,
        recentActivity: batch[4].results,
        recentSignups: batch[5].results,
        locked: !!lockVal && lockVal.value === '1'
      });
    }

    // ---------- WRITES (admin only) ----------
    if (method === 'POST' && path.startsWith('/api/')) {
      const sess = await getSession(env, request);
      if (!sess || !sess.isAdmin) return jsonResponse({ error: 'Not authorized' }, { status: 403 });

      // Content writes are blocked while the wiki is locked (true freeze,
      // applies to admins too). Lock toggle + seed are intentionally exempt.
      const isContentWrite = (path === '/api/character' || path === '/api/collection' || path === '/api/script');
      if (isContentWrite && await isWikiLocked(env)) {
        return jsonResponse({ error: 'The wiki is locked. Editing and page creation are temporarily disabled.' }, { status: 423 });
      }

      if (path === '/api/upload') {
        if (!env.ART) return jsonResponse({ error: 'Image storage (R2) is not configured' }, { status: 500 });
        const ct = request.headers.get('Content-Type') || '';
        let key, bytes, contentType;
        if (ct.includes('application/json')) {
          const b = await request.json().catch(() => ({}));
          key = b.key;
          if (!key || !b.data) return jsonResponse({ error: 'Missing key or data' }, { status: 400 });
          let data = String(b.data);
          if (data.startsWith('data:')) {
            contentType = data.slice(5, data.indexOf(';'));
            data = data.slice(data.indexOf(',') + 1);
          }
          bytes = base64ToBytes(data);
        } else {
          key = url.searchParams.get('key');
          bytes = new Uint8Array(await request.arrayBuffer());
          contentType = ct || undefined;
        }
        key = String(key || '').replace(/^\/+/, '').replace(/^assets\//, '');
        if (key.includes('..') || !R2_PREFIXES.some(p => key.startsWith(p))) {
          return jsonResponse({ error: 'Key must be under: ' + R2_PREFIXES.join(', ') }, { status: 400 });
        }
        const ext = key.split('.').pop().toLowerCase();
        if (!contentType) contentType = EXT_CONTENT_TYPE[ext] || 'application/octet-stream';
        await env.ART.put(key, bytes, { httpMetadata: { contentType } });
        return jsonResponse({ ok: true, path: '/assets/' + key });
      }

      if (path === '/api/character') {
        const c = await request.json();
        if (!c || !c.slug || !c.name || !c.team || !c.ability)
          return jsonResponse({ error: 'Missing required fields' }, { status: 400 });
        const existed = await env.DB.prepare('SELECT 1 FROM characters WHERE slug=?').bind(c.slug).first();
        await env.DB.prepare(
          `INSERT INTO characters (slug,name,team,creator,owner_id,tags,appears_in,data,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             name=excluded.name, team=excluded.team, creator=excluded.creator,
             tags=excluded.tags, appears_in=excluded.appears_in,
             data=excluded.data, updated_at=datetime('now')`
        ).bind(c.slug, c.name, c.team, c.creator || null, sess.userId,
               c.tags || null, c.appearsIn || null, JSON.stringify(c)).run();
        await logActivity(env, sess, existed ? 'update' : 'create', 'character', c.slug, c.name);
        return jsonResponse({ ok: true, slug: c.slug });
      }

      if (path === '/api/collection') {
        const c = await request.json();
        if (!c || !c.slug) return jsonResponse({ error: 'Missing slug' }, { status: 400 });
        const existed = await env.DB.prepare('SELECT 1 FROM collections WHERE slug=?').bind(c.slug).first();
        await env.DB.prepare(
          `INSERT INTO collections (slug,display_name,owner_id,data,created_at,updated_at)
           VALUES (?,?,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             display_name=excluded.display_name, data=excluded.data, updated_at=datetime('now')`
        ).bind(c.slug, c.displayName || c.slug, sess.userId, JSON.stringify(c)).run();
        await logActivity(env, sess, existed ? 'update' : 'create', 'collection', c.slug, c.displayName || c.slug);
        return jsonResponse({ ok: true, slug: c.slug });
      }

      if (path === '/api/script') {
        const s = await request.json();
        if (!s || !s.slug) return jsonResponse({ error: 'Missing slug' }, { status: 400 });
        const existed = await env.DB.prepare('SELECT 1 FROM scripts WHERE slug=?').bind(s.slug).first();
        await env.DB.prepare(
          `INSERT INTO scripts (slug,name,author,owner_id,data,created_at,updated_at)
           VALUES (?,?,?,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             name=excluded.name, author=excluded.author, data=excluded.data, updated_at=datetime('now')`
        ).bind(s.slug, s.name || s.slug, s.author || null, sess.userId, JSON.stringify(s)).run();
        await logActivity(env, sess, existed ? 'update' : 'create', 'script', s.slug, s.name || s.slug);
        return jsonResponse({ ok: true, slug: s.slug });
      }

      if (path === '/api/lock') {
        const body = await request.json().catch(() => ({}));
        const locked = body.locked ? '1' : '0';
        await env.DB.prepare(
          `INSERT INTO settings (key,value) VALUES ('wiki_locked',?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value`
        ).bind(locked).run();
        await logActivity(env, sess, locked === '1' ? 'lock' : 'unlock', 'wiki', null, null);
        return jsonResponse({ ok: true, locked: locked === '1' });
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
            "INSERT OR REPLACE INTO characters (slug,name,team,creator,owner_id,tags,appears_in,data,created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))"
          ).bind(c.slug, c.name, c.team, c.creator || null, sess.userId, c.tags || null, c.appearsIn || null, JSON.stringify(c)));
        }
        for (const c of cols) {
          stmts.push(env.DB.prepare(
            "INSERT OR REPLACE INTO collections (slug,display_name,owner_id,data,created_at) VALUES (?,?,?,?,datetime('now'))"
          ).bind(c.slug, c.displayName || c.slug, sess.userId, JSON.stringify(c)));
        }
        for (const s of scripts) {
          stmts.push(env.DB.prepare(
            "INSERT OR REPLACE INTO scripts (slug,name,author,owner_id,data,created_at) VALUES (?,?,?,?,datetime('now'))"
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
