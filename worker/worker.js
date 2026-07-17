/**
 * BOTC Homebrew Wiki — Cloudflare Worker
 * ----------------------------------------------------------------
 * Option B architecture: the frontend stays static and renders in the
 * browser. This Worker only changes WHERE the data comes from and adds
 * authentication + ownership for writes.
 *
 * Routes it handles:
 *   GET  /characters.json     -> built from D1 (published pages only)
 *   GET  /collections.json    -> built from D1
 *   GET  /scripts.json        -> built from D1
 *
 *   -- auth --
 *   POST /api/signup          -> create an account (username/email/password)
 *   POST /api/login           -> log in (username OR email + password)
 *   POST /api/logout          -> clears session
 *   GET  /api/me              -> who am I
 *   POST /api/forgot-password -> email a password-reset link
 *   POST /api/reset-password  -> set new password from a reset token
 *   GET  /api/verify-email    -> confirm email from the emailed link
 *   POST /api/resend-verification
 *   GET  /api/auth/discord    -> start Discord OAuth (sign in / sign up / link)
 *   GET  /api/auth/discord/callback
 *
 *   -- account --
 *   GET  /api/account         -> profile + your pages + drafts + recent edits
 *   POST /api/account/profile -> update display name / bio
 *   POST /api/account/password-> change (or set) password
 *   POST /api/account/email   -> change email (re-verifies)
 *   POST /api/account/unlink-discord
 *
 *   -- content (any logged-in user; edits restricted to owner/admin) --
 *   GET  /api/page            -> fetch one page for editing (drafts incl.)
 *   POST /api/character       -> create/update a character
 *   POST /api/collection      -> create/update a collection
 *   POST /api/script          -> create/update a script
 *   POST /api/publish         -> flip a page between draft and published
 *   POST /api/delete          -> delete a page you own
 *   POST /api/upload          -> image upload to R2 (ownership-checked)
 *
 *   -- public pages & discovery --
 *   GET  /api/user            -> public profile + published pages (?u=username)
 *   GET  /u/{username}        -> public profile page (serves profile.html)
 *   GET  /random              -> 302 to a random published character page
 *   GET  /sitemap.xml         -> built live from D1
 *   GET  /s/{slug}            -> script page (server-side rendered from D1)
 *   GET  /collection/{id}     -> collection page (server-side rendered from D1)
 *   GET  /script-view(.html)  -> 301 to /s/{slug} (legacy links)
 *   POST /api/admin/assign-owner -> admin: set/clear a page's owner account
 *
 *   -- admin --
 *   GET  /api/admin/dashboard -> dashboard data
 *   POST /api/lock            -> lock/unlock the wiki
 *   POST /api/backup          -> run a D1 -> R2 backup now
 *   POST /api/seed            -> one-time data load from repo JSON
 *
 *   scheduled (cron)          -> nightly D1 -> R2 JSON backup (backups/{date}/)
 *   everything else           -> served from static assets
 * ----------------------------------------------------------------
 * Secrets / vars this Worker uses (set via `wrangler secret put` or the
 * Cloudflare dashboard — all optional, features degrade gracefully):
 *   RESEND_API_KEY        -> enables outgoing email (password reset, verify)
 *   MAIL_FROM             -> e.g. 'BOTC Homebrew Wiki <no-reply@yourdomain>'
 *   DISCORD_CLIENT_ID     -> enables "Sign in with Discord"
 *   DISCORD_CLIENT_SECRET
 */

// esbuild bundles render.js's CommonJS export into the Worker; no DOM here.
import Render from '../assets/render.js';
// Shared script/collection page renderer (also used by the publish pages in
// the browser). It receives render.js's exports through init().
import PageRender from '../assets/render-page.js';
PageRender.init(Render);

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const APP_NAME = 'BOTC Homebrew Wiki';

const R2_PREFIXES = ['art/', 'collections/', 'scripts/', 'tokens/'];
const EXT_CONTENT_TYPE = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml'
};

// Content-type registry: maps API "type" to its table + display columns.
const CONTENT = {
  character:  { table: 'characters',  nameCol: 'name' },
  collection: { table: 'collections', nameCol: 'display_name' },
  script:     { table: 'scripts',     nameCol: 'name' }
};

// ---- password hashing (PBKDF2, matches the seeded admin hash) ----
const PBKDF2_ITERATIONS = 100000;

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password),
    { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key, 256
  );
  return bytesToBase64(new Uint8Array(bits));
}

async function verifyPassword(password, stored) {
  // stored format: pbkdf2_sha256$iterations$salt_b64$hash_b64
  if (!stored) return false; // Discord-only accounts have no password
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = parseInt(parts[1], 10);
  const salt = base64ToBytes(parts[2]);
  return (await pbkdf2(password, salt, iterations)) === parts[3];
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${hash}`;
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
function randomToken() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
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

// ---- basic per-IP rate limiting (KV counter; best-effort) ----
async function rateLimited(env, request, bucket, limit, windowSec) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `rl:${bucket}:${ip}`;
  const cur = parseInt((await env.SESSIONS.get(key)) || '0', 10);
  if (cur >= limit) return true;
  await env.SESSIONS.put(key, String(cur + 1), { expirationTtl: windowSec });
  return false;
}

// ---- outgoing email (Resend; optional) ----
function emailShell(title, bodyHtml) {
  return `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:24px;color:#241a12;background:#f7f0e0;border:1px solid #cdbfa0">
  <h2 style="color:#5b1f21;margin:0 0 12px">${title}</h2>
  ${bodyHtml}
  <p style="font-size:12px;color:#8a7a5e;margin-top:28px">${APP_NAME} — fan-made content for Blood on the Clocktower.<br>
  If you didn't request this email you can safely ignore it.</p>
</div>`;
}

async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) {
    return { ok: false, error: 'Email is not configured on this server yet.' };
  }
  const from = env.MAIL_FROM || `${APP_NAME} <onboarding@resend.dev>`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from, to: [to], subject, html })
    });
    if (!res.ok) return { ok: false, error: 'Email delivery failed (' + res.status + ').' };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Email delivery failed.' };
  }
}

async function sendVerificationEmail(env, origin, user) {
  if (!user.email) return { ok: false, error: 'No email on this account.' };
  const token = randomToken();
  await env.SESSIONS.put('verify:' + token, String(user.id), { expirationTtl: 60 * 60 * 24 });
  const link = origin + '/api/verify-email?token=' + token;
  return sendEmail(env, user.email, 'Verify your email — ' + APP_NAME, emailShell(
    'Verify your email',
    `<p>Hi ${escapeHtml(user.display_name || user.username)},</p>
     <p>Click the link below to verify the email address on your ${APP_NAME} account:</p>
     <p><a href="${link}" style="color:#5b1f21;font-weight:bold">Verify my email</a></p>
     <p>This link expires in 24 hours.</p>`
  ));
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- validation ----
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,19}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validSignup(username, email, password) {
  if (!USERNAME_RE.test(username || '')) {
    return 'Username must be 3–20 characters: letters, numbers, hyphens or underscores.';
  }
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return 'Please enter a valid email address.';
  }
  if (!password || password.length < 8 || password.length > 200) {
    return 'Password must be at least 8 characters.';
  }
  return null;
}

async function findUserByLogin(env, identifier) {
  return env.DB.prepare(
    `SELECT * FROM users WHERE lower(username) = lower(?1) OR (email IS NOT NULL AND lower(email) = lower(?1))`
  ).bind(identifier).first();
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

// ---- ownership: may this session edit this row? ----
function canEditRow(sess, row) {
  if (!sess) return false;
  if (sess.isAdmin) return true;
  return !!row.owner_id && row.owner_id === sess.userId;
}

async function getEntityRow(env, type, slug) {
  const t = CONTENT[type];
  if (!t || !slug) return null;
  return env.DB.prepare(
    `SELECT slug, ${t.nameCol} AS name, owner_id, status, data FROM ${t.table} WHERE slug=?`
  ).bind(slug).first().catch(() => null);
}

// ---- shared validation for script/collection page fields ----
// Caps text lengths, whitelists difficulty, constrains image paths to the
// scripts/ and collections/ R2 areas, and runs the theme through the shared
// sanitizer (hex colors, preset fonts, own -bg image slot only).
const PAGE_FIELD_CAPS = {
  name: 120, displayName: 120, author: 80, description: 2000, tagline: 140,
  version: 32, synopsis: 4000, gameplay: 4000, strategyGood: 2000, strategyEvil: 2000
};
const PAGE_IMG_RE = /^(scripts|collections)\/[a-z0-9._ -]+\.(png|jpe?g|webp)$/i;
function sanitizePageFields(o, themeBase) {
  for (const k of Object.keys(PAGE_FIELD_CAPS)) {
    if (o[k] != null) o[k] = String(o[k]).slice(0, PAGE_FIELD_CAPS[k]);
  }
  if (o.difficulty != null && !['', 'beginner', 'intermediate', 'veteran'].includes(o.difficulty)) {
    o.difficulty = '';
  }
  for (const k of ['header', 'logo']) {
    if (o[k] != null && !(typeof o[k] === 'string' && (o[k] === '' || PAGE_IMG_RE.test(o[k])))) {
      o[k] = '';
    }
  }
  const theme = PageRender.sanitizeTheme(o.theme, themeBase);
  if (theme) o.theme = theme; else delete o.theme;
}

// ---- build the three JSON files from D1 (published pages only) ----
async function buildPublicJSON(env, table) {
  let results;
  try {
    ({ results } = await env.DB.prepare(`SELECT data FROM ${table} WHERE status='published'`).all());
  } catch {
    // status column not migrated yet -> serve everything (legacy behaviour)
    ({ results } = await env.DB.prepare(`SELECT data FROM ${table}`).all());
  }
  return results.map(r => {
    const d = JSON.parse(r.data);
    // clean URLs: stored page paths end in .html, but the site serves them
    // extensionless now — strip it so every consumer links the clean form
    if (typeof d.page === 'string') d.page = d.page.replace(/\.html$/, '');
    return d;
  });
}

// ---- D1 -> R2 backup (nightly cron + POST /api/backup) ----
// Dumps every content table to backups/{YYYY-MM-DD}/{table}.json in the ART
// bucket. backups/ is not in R2_PREFIXES, so the files are never publicly
// servable through /assets/. Keeps 30 days of snapshots.
async function runBackup(env) {
  if (!env.ART) throw new Error('R2 bucket (ART binding) is not configured.');
  const stamp = new Date().toISOString().slice(0, 10);
  const tables = ['characters', 'collections', 'scripts', 'users', 'activity_log', 'settings'];
  const saved = {};
  for (const t of tables) {
    try {
      const { results } = await env.DB.prepare(`SELECT * FROM ${t}`).all();
      await env.ART.put(`backups/${stamp}/${t}.json`, JSON.stringify(results), {
        httpMetadata: { contentType: 'application/json' }
      });
      saved[t] = results.length;
    } catch (e) {
      saved[t] = 'skipped (' + ((e && e.message) || 'error') + ')';
    }
  }
  const cutoff = Date.now() - 30 * 86400000;
  try {
    const listed = await env.ART.list({ prefix: 'backups/', limit: 1000 });
    for (const obj of listed.objects) {
      const m = obj.key.match(/^backups\/(\d{4}-\d{2}-\d{2})\//);
      if (m && Date.parse(m[1]) < cutoff) await env.ART.delete(obj.key);
    }
  } catch { /* pruning is best-effort */ }
  return { date: stamp, saved };
}

function jsonResponse(obj, extraHeaders = {}) {
  // `status` in the second argument sets the HTTP status; everything else
  // is a response header.
  const { status = 200, ...headers } = extraHeaders;
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...JSON_HEADERS, 'Cache-Control': 'no-store', ...headers }
  });
}

function redirectResponse(location, cookie) {
  const headers = new Headers({ Location: location });
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

function attr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Shared HTML shell for every server-rendered page (/c/, /s/, /collection/).
// The topbar/nav markup mirrors the static pages (scripts.html is canonical).
function pageShell(o) {
  // o: {title, desc, canonicalUrl, ogImage, ogCard, crumb, body, bodyClass,
  //     bodyStyle, mainClass, mainStyle, bootstrap, scripts[], draftBanner}
  const bodyAttrs = (o.bodyClass ? ' class="' + attr(o.bodyClass) + '"' : '') +
    (o.bodyStyle ? ' style="' + attr(o.bodyStyle) + '"' : '');
  const mainAttrs = ' class="wrap' + (o.mainClass ? ' ' + attr(o.mainClass) : '') + '"' +
    (o.mainStyle ? ' style="' + attr(o.mainStyle) + '"' : '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${attr(o.title)} — BOTC HomeBrew Wiki</title>
<meta name="description" content="${attr(o.desc)}">
<link rel="canonical" href="${attr(o.canonicalUrl)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="BOTC HomeBrew Wiki">
<meta property="og:title" content="${attr(o.title)}">
<meta property="og:description" content="${attr(o.desc)}">
<meta property="og:image" content="${attr(o.ogImage)}">
<meta property="og:url" content="${attr(o.canonicalUrl)}">
<meta name="twitter:card" content="${attr(o.ogCard || 'summary')}">
<meta name="twitter:title" content="${attr(o.title)}">
<meta name="twitter:description" content="${attr(o.desc)}">
<meta name="twitter:image" content="${attr(o.ogImage)}">
<link rel="icon" type="image/png" sizes="64x64" href="../assets/favicon.png">
<link rel="apple-touch-icon" href="../assets/favicon.png">
<link rel="stylesheet" href="../assets/styles.css">
</head>
<body${bodyAttrs}>
${o.draftBanner || ''}
  <header class="topbar">
    <div class="brand-group">
      <a class="brand" href="../">
        <img class="brand-skull" src="../assets/logo_skull.png" alt="">
        <img class="brand-header-text" src="../assets/headertext.png" alt="BOTC HomeBrew Wiki">
      </a>
      <img class="topbar-badge" src="../assets/ccc-parchment.png" alt="Community Created Content">
      <a class="edit-link" id="edit-btn" style="display:none" href="#">&#9998; Edit</a>
    </div>
    <nav class="crumb" aria-label="Breadcrumb" id="crumb">${o.crumb}</nav>
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
  <a href="../">Home</a>
  <a href="../all-characters">All Characters</a>
  <a href="../tags">Tags</a>
  <a href="../creators">Creators</a>
  <a href="../script">Script Builder</a>
  <a href="../create">Create a Character</a>
</nav>

  <main${mainAttrs} id="content">${o.body}</main>

  <p class="foot">Fan-made content for <em>Blood on the Clocktower</em> &middot; Not affiliated with The Pandemonium Institute</p>

  <script>${o.bootstrap || ''}</script>
${(o.scripts || []).map(s => '  <script src="../assets/' + s + '"></script>').join('\n')}
</body>
</html>`;
}

function renderCharacterPage(d, origin, isDraft) {
  const team = d.team || 'townsfolk';
  const label = (Render.TEAM_LABEL && Render.TEAM_LABEL[team]) || team;
  const name = d.name || 'Character';
  const desc = (d.ability || d.lede || '').trim();
  const pageUrl = origin + '/c/' + d.slug;
  const imgRaw = Array.isArray(d.image) ? d.image[0] : d.image;
  const img = imgRaw || (origin + '/assets/' + (d.art || ''));
  // bulk-imported characters may only have a remote image URL, no local art
  const artSrc = d.art ? '../assets/' + d.art : (imgRaw || '');
  const body = Render.renderCharacter(d, artSrc, '../');
  const crumb =
    '<a href="../">Home</a><span class="sep">›</span>' +
    '<a href="../all-characters">Characters</a><span class="sep">·</span>' +
    '<a href="../script">Script Builder</a><span class="sep">·</span>' +
    '<a href="../tokens">Token Tool</a><span class="sep">›</span>' +
    '<a href="../team?t=' + attr(team) + '">' + attr(label) + '</a>' +
    '<span class="sep">›</span><span class="here">' + attr(name) + '</span>';
  const draftBanner = isDraft
    ? '<div style="background:#7a5c18;color:#f7ecd0;text-align:center;padding:10px 16px;font-family:\'TradeGothicLT\',\'Libre Franklin\',sans-serif;letter-spacing:.04em">DRAFT — only you (and admins) can see this page. Publish it from your <a href="../account" style="color:#ffe9ad">account page</a> or the editor.</div>'
    : '';
  return pageShell({
    title: name, desc, canonicalUrl: pageUrl, ogImage: img, ogCard: 'summary',
    crumb, body, draftBanner,
    bootstrap: `window.SSR = true; window.LINK_ROOT = '../'; window.CHAR_SLUG = ${JSON.stringify(d.slug)};`,
    scripts: ['render.js', 'tags.js', 'charpage.js', 'site.js']
  });
}

// ---- official BotC roles (assets/roles.json), for script rosters that
// include imported official characters ('off-' slugs). Cached per isolate.
let _officialRolesCache = null;
async function loadOfficialRoles(env, origin) {
  if (_officialRolesCache) return _officialRolesCache;
  try {
    const res = await env.ASSETS.fetch(new Request(origin + '/assets/roles.json'));
    const roles = await res.json();
    _officialRolesCache = (roles || []).filter(r => r && r.id).map(r => ({
      slug: 'off-' + String(r.id).toLowerCase().replace(/[^a-z0-9]/g, ''),
      official: true, id: r.id,
      name: r.name || r.id, team: r.team || '',
      ability: r.ability || '', image: r.image || '',
      page: 'https://wiki.bloodontheclocktower.com/' + encodeURIComponent(String(r.name || r.id).replace(/ /g, '_'))
    }));
  } catch {
    _officialRolesCache = [];
  }
  return _officialRolesCache;
}

// Map of slugId(id/name) -> official icon URL, so /c/ jinx icons for official
// characters use the same release-CDN art as the Token Tool. Cached per isolate.
let _officialIconMapCache = null;
async function officialIconMap(env, origin) {
  if (_officialIconMapCache) return _officialIconMapCache;
  const m = {};
  for (const r of await loadOfficialRoles(env, origin)) {
    if (r.image && /^https?:\/\//.test(r.image)) {
      m[Render.slugId(r.id)] = r.image;
      if (r.name) m[Render.slugId(r.name)] = r.image;
    }
  }
  _officialIconMapCache = m;
  return m;
}

// ---- shared SSR for /s/{slug} and /collection/{id} pages ----
async function renderContentPage(env, request, url, type, slug) {
  const isScript = type === 'script';
  const table = isScript ? 'scripts' : 'collections';
  let row = null;
  try {
    row = await env.DB.prepare(`SELECT data, status, owner_id FROM ${table} WHERE slug=?`)
      .bind(slug).first();
  } catch {
    row = await env.DB.prepare(`SELECT data FROM ${table} WHERE slug=?`).bind(slug).first();
  }
  if (!isScript && !row) row = await findCollectionRow(env, slug);
  if (!row || !row.data) return env.ASSETS.fetch(request);

  const isDraft = row.status === 'draft';
  if (isDraft) {
    const sess = await getSession(env, request);
    if (!canEditRow(sess, row)) return env.ASSETS.fetch(request); // 404 for everyone else
  }
  const d = JSON.parse(row.data);
  if (!d.slug) d.slug = row.slug || slug;

  let chars = await buildPublicJSON(env, 'characters');
  // Scripts can carry imported official roles ('off-' slugs) — resolve them
  if (isScript && (d.characters || []).some(s => String(s).indexOf('off-') === 0)) {
    chars = chars.concat(await loadOfficialRoles(env, url.origin));
  }

  const themeBase = isScript ? ('scripts/' + d.slug) : ('collections/' + (d.id || d.slug));
  const theme = PageRender.sanitizeTheme(d.theme, themeBase);
  const ta = PageRender.themeAttrs(theme, '../');

  const name = (isScript ? d.name : (d.displayName || d.slug)) || 'Untitled';
  const body = isScript
    ? PageRender.renderScriptPage(d, chars, { linkRoot: '../', isDraft })
    : PageRender.renderCollectionPage(d, chars, { linkRoot: '../', isDraft });

  const nChars = isScript
    ? (d.characters || []).length
    : PageRender.resolveCollectionMembers(d, chars).length;
  const desc = (d.tagline || '').trim() || (d.description || '').trim() ||
    (nChars + '-character homebrew ' + (isScript ? 'script' : 'collection') +
     ' for Blood on the Clocktower' + (d.author ? ', by ' + d.author : '') + '.');
  const canonical = url.origin + (isScript ? '/s/' : '/collection/') + encodeURIComponent(isScript ? d.slug : (d.id || d.slug));
  const img = url.origin + '/assets/' + (d.header || d.logo || 'logo_skull.png');
  const editHref = isScript
    ? '../publish-script?s=' + encodeURIComponent(d.slug)
    : '../publish-collection?c=' + encodeURIComponent(d.id || d.slug);
  const draftBanner = isDraft
    ? '<div style="background:#7a5c18;color:#f7ecd0;text-align:center;padding:10px 16px;font-family:\'TradeGothicLT\',\'Libre Franklin\',sans-serif;letter-spacing:.04em">DRAFT — only you (and admins) can see this page. Publish it from <a href="' + attr(editHref) + '" style="color:#ffe9ad">the editor</a> or <a href="../account" style="color:#ffe9ad">your account</a>.</div>'
    : '';
  const crumb = isScript
    ? '<a href="../">Home</a><span class="sep">›</span><a href="../scripts">Scripts</a><span class="sep">›</span><span class="here">' + attr(name) + '</span>'
    : '<a href="../">Home</a><span class="sep">›</span><a href="../">Collections</a><span class="sep">›</span><span class="here">' + attr(name) + '</span>';

  const html = pageShell({
    title: (isDraft ? 'Draft: ' : '') + name, desc, canonicalUrl: canonical,
    ogImage: img, ogCard: d.header ? 'summary_large_image' : 'summary',
    crumb, body, draftBanner,
    bodyClass: ta.cls, bodyStyle: ta.style,
    bootstrap: `window.SSR = true; window.LINK_ROOT = '../'; window.PAGE_TYPE = ${JSON.stringify(type)}; window.PAGE_SLUG = ${JSON.stringify(isScript ? d.slug : (d.id || d.slug))};`,
    scripts: ['render.js', 'pageview.js', 'site.js']
  });
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

// Collections: legacy rows have a display-string PK slug (e.g. "The Academy")
// while URLs use the kebab id from the JSON ("the-academy"). Resolve by PK
// first, then by data.id, then by normalized slug/displayName.
async function findCollectionRow(env, key) {
  if (!key) return null;
  let hit = await env.DB.prepare(
    'SELECT slug, display_name AS name, owner_id, status, data FROM collections WHERE slug=?'
  ).bind(key).first().catch(() => null);
  if (hit) return hit;
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const nkey = norm(key);
  const { results } = await env.DB.prepare(
    'SELECT slug, display_name AS name, owner_id, status, data FROM collections'
  ).all().catch(() => ({ results: [] }));
  for (const row of results || []) {
    try {
      const d = JSON.parse(row.data);
      if (d.id === key || norm(d.id) === nkey || norm(row.slug) === nkey || norm(d.displayName) === nkey) return row;
    } catch { /* skip bad rows */ }
  }
  return null;
}

// ---- Discord OAuth helpers ----
function discordConfigured(env) {
  return !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);
}
function discordRedirectUri(origin) {
  return origin + '/api/auth/discord/callback';
}

// Pick a free username derived from the Discord name.
async function uniqueUsername(env, base) {
  let stem = String(base || 'user').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 16);
  if (stem.length < 3) stem = ('user-' + (stem || '')).slice(0, 16).replace(/[-_]+$/, '');
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? stem : stem + '-' + (i + 1);
    const hit = await env.DB.prepare('SELECT 1 FROM users WHERE lower(username)=lower(?)')
      .bind(candidate).first();
    if (!hit) return candidate;
  }
  return stem + '-' + Date.now();
}

function loginErrorRedirect(origin, msg) {
  return redirectResponse(origin + '/login?error=' + encodeURIComponent(msg));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ---------- DATA ENDPOINTS (replace static JSON files) ----------
    if (method === 'GET' && path === '/characters.json') {
      return jsonResponse(await buildPublicJSON(env, 'characters'));
    }
    if (method === 'GET' && path === '/collections.json') {
      return jsonResponse(await buildPublicJSON(env, 'collections'));
    }
    if (method === 'GET' && path === '/scripts.json') {
      return jsonResponse(await buildPublicJSON(env, 'scripts'));
    }

    // ---------- CHARACTER PAGES (server-side rendered from D1) ----------
    if (method === 'GET' && path.startsWith('/c/')) {
      let slug = decodeURIComponent(path.slice(3));
      // clean URLs: the .html form permanently redirects to the extensionless one
      if (slug.endsWith('.html')) {
        slug = slug.slice(0, -5);
        return new Response(null, {
          status: 301,
          headers: { Location: url.origin + '/c/' + slug + url.search, 'Cache-Control': 'no-store' }
        });
      }
      if (slug && /^[a-z0-9-]+$/i.test(slug)) {
        let row = null;
        try {
          row = await env.DB.prepare('SELECT data, status, owner_id FROM characters WHERE slug = ?')
            .bind(slug).first();
        } catch {
          row = await env.DB.prepare('SELECT data FROM characters WHERE slug = ?')
            .bind(slug).first();
        }
        if (row && row.data) {
          const isDraft = row.status === 'draft';
          if (isDraft) {
            const sess = await getSession(env, request);
            if (!canEditRow(sess, row)) return env.ASSETS.fetch(request); // 404 for everyone else
          }
          const d = JSON.parse(row.data);
          if (!d.slug) d.slug = slug;
          Render.setOfficialIconUrls(await officialIconMap(env, url.origin));
          return new Response(renderCharacterPage(d, url.origin, isDraft), {
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
          });
        }
      }
      // Unknown slug -> fall back to a committed static page (if any), else 404.
      return env.ASSETS.fetch(request);
    }

    // ---------- SCRIPT PAGES (server-side rendered from D1) ----------
    if (method === 'GET' && path.startsWith('/s/')) {
      let slug = decodeURIComponent(path.slice(3));
      if (slug.endsWith('.html')) {
        slug = slug.slice(0, -5);
        return new Response(null, {
          status: 301,
          headers: { Location: url.origin + '/s/' + slug + url.search, 'Cache-Control': 'no-store' }
        });
      }
      if (slug && /^[a-z0-9-]+$/i.test(slug)) {
        return renderContentPage(env, request, url, 'script', slug);
      }
      return env.ASSETS.fetch(request);
    }

    // ---------- COLLECTION PAGES (server-side rendered from D1) ----------
    if (method === 'GET' && path.startsWith('/collection/')) {
      let key = decodeURIComponent(path.slice('/collection/'.length));
      if (key.endsWith('.html')) {
        key = key.slice(0, -5);
        return new Response(null, {
          status: 301,
          headers: { Location: url.origin + '/collection/' + encodeURIComponent(key) + url.search, 'Cache-Control': 'no-store' }
        });
      }
      if (key) {
        return renderContentPage(env, request, url, 'collection', key);
      }
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

    // ---------- RANDOM CHARACTER (302 to a random published page) ----------
    if (method === 'GET' && path === '/random') {
      let row;
      try {
        row = await env.DB.prepare(
          "SELECT slug FROM characters WHERE status='published' ORDER BY RANDOM() LIMIT 1"
        ).first();
      } catch {
        row = await env.DB.prepare(
          'SELECT slug FROM characters ORDER BY RANDOM() LIMIT 1'
        ).first();
      }
      const dest = row ? '/c/' + row.slug : '/all-characters';
      return new Response(null, {
        status: 302,
        headers: { Location: url.origin + dest, 'Cache-Control': 'no-store' }
      });
    }

    // ---------- PUBLIC PROFILE PAGE (/u/{username} serves profile.html) ----------
    if (method === 'GET' && path.startsWith('/u/')) {
      const res = await env.ASSETS.fetch(new Request(url.origin + '/profile.html'));
      return new Response(res.body, {
        status: res.status,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' }
      });
    }

    // ---------- PUBLIC PROFILE DATA ----------
    if (method === 'GET' && path === '/api/user') {
      const uname = (url.searchParams.get('u') || '').trim();
      if (!uname) return jsonResponse({ error: 'Missing username' }, { status: 400 });
      const u = await env.DB.prepare(
        'SELECT id, username, display_name, bio, avatar_url, created_at FROM users WHERE lower(username)=lower(?)'
      ).bind(uname).first();
      if (!u) return jsonResponse({ error: 'No such user' }, { status: 404 });
      async function ownedPublished(table) {
        let results;
        try {
          ({ results } = await env.DB.prepare(
            `SELECT data FROM ${table} WHERE owner_id=? AND status='published' ORDER BY updated_at DESC`
          ).bind(u.id).all());
        } catch {
          ({ results } = await env.DB.prepare(
            `SELECT data FROM ${table} WHERE owner_id=?`
          ).bind(u.id).all());
        }
        return results.map(r => JSON.parse(r.data));
      }
      const [characters, collections, scripts] = await Promise.all([
        ownedPublished('characters'), ownedPublished('collections'), ownedPublished('scripts')
      ]);
      return jsonResponse({
        profile: {
          username: u.username,
          displayName: u.display_name || u.username,
          bio: u.bio || '',
          avatarUrl: u.avatar_url || null,
          joined: u.created_at
        },
        characters, collections, scripts
      });
    }

    // ---------- SITEMAP (built live from D1) ----------
    if (method === 'GET' && path === '/sitemap.xml') {
      const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      async function pub(table) {
        try {
          return (await env.DB.prepare(`SELECT slug, updated_at FROM ${table} WHERE status='published'`).all()).results;
        } catch {
          return (await env.DB.prepare(`SELECT slug, updated_at FROM ${table}`).all()).results;
        }
      }
      async function pubCollections() {
        try {
          return (await env.DB.prepare(`SELECT slug, data, updated_at FROM collections WHERE status='published'`).all()).results;
        } catch {
          return (await env.DB.prepare(`SELECT slug, data, updated_at FROM collections`).all()).results;
        }
      }
      const [chars, scripts, colls] = await Promise.all([pub('characters'), pub('scripts'), pubCollections()]);
      const staticPages = ['', 'all-characters', 'scripts', 'tags', 'creators',
        'authors', 'script', 'tokens', 'mass-upload', 'steven-approved-order'];
      const urls = staticPages.map(p => '<url><loc>' + xmlEsc(url.origin + '/' + p) + '</loc></url>');
      const lastmod = r => r.updated_at ? '<lastmod>' + xmlEsc(String(r.updated_at).slice(0, 10)) + '</lastmod>' : '';
      for (const r of chars) {
        urls.push('<url><loc>' + xmlEsc(url.origin + '/c/' + r.slug) + '</loc>' + lastmod(r) + '</url>');
      }
      for (const r of scripts) {
        urls.push('<url><loc>' + xmlEsc(url.origin + '/s/' + encodeURIComponent(r.slug)) + '</loc>' + lastmod(r) + '</url>');
      }
      for (const r of colls) {
        let id = '';
        try { id = JSON.parse(r.data).id || ''; } catch { /* fall back to slug */ }
        urls.push('<url><loc>' + xmlEsc(url.origin + '/collection/' + encodeURIComponent(id || r.slug)) + '</loc>' + lastmod(r) + '</url>');
      }
      const body = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        urls.join('\n') + '\n</urlset>';
      return new Response(body, {
        headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
      });
    }

    // ---------- SCRIPT VIEW (legacy URLs redirect to the SSR /s/ pages) ----------
    if (method === 'GET' && (path === '/script-view.html' || path === '/script-view')) {
      const slug = url.searchParams.get('s');
      if (slug && /^[a-z0-9-]+$/i.test(slug)) {
        return new Response(null, {
          status: 301,
          headers: { Location: url.origin + '/s/' + encodeURIComponent(slug), 'Cache-Control': 'no-store' }
        });
      }
      return new Response(null, {
        status: 302,
        headers: { Location: url.origin + '/scripts', 'Cache-Control': 'no-store' }
      });
    }

    // ---------- AUTH: SIGN UP ----------
    if (method === 'POST' && path === '/api/signup') {
      if (await rateLimited(env, request, 'signup', 5, 3600)) {
        return jsonResponse({ error: 'Too many signups from this connection. Try again later.' }, { status: 429 });
      }
      const body = await request.json().catch(() => ({}));
      const username = String(body.username || '').trim();
      const email = String(body.email || '').trim();
      const password = String(body.password || '');
      const bad = validSignup(username, email, password);
      if (bad) return jsonResponse({ error: bad }, { status: 400 });

      const nameTaken = await env.DB.prepare('SELECT 1 FROM users WHERE lower(username)=lower(?)')
        .bind(username).first();
      if (nameTaken) return jsonResponse({ error: 'That username is already taken.' }, { status: 409 });
      const emailTaken = await env.DB.prepare('SELECT 1 FROM users WHERE email IS NOT NULL AND lower(email)=lower(?)')
        .bind(email).first();
      if (emailTaken) return jsonResponse({ error: 'An account with that email already exists. Try logging in or resetting your password.' }, { status: 409 });

      const hash = await hashPassword(password);
      const res = await env.DB.prepare(
        `INSERT INTO users (username, password_hash, email, is_admin, last_login)
         VALUES (?,?,?,0,datetime('now'))`
      ).bind(username, hash, email).run();
      const userId = res.meta.last_row_id;

      const token = await createSession(env, userId, false);
      await logActivity(env, { userId }, 'signup', 'user', null, username);
      // Best-effort verification email; signup succeeds either way.
      ctx.waitUntil(sendVerificationEmail(env, url.origin, { id: userId, username, email }));
      return jsonResponse({ ok: true, username }, { 'Set-Cookie': sessionCookie(token) });
    }

    // ---------- AUTH: LOG IN ----------
    if (method === 'POST' && path === '/api/login') {
      if (await rateLimited(env, request, 'login', 10, 600)) {
        return jsonResponse({ error: 'Too many login attempts. Wait a few minutes and try again.' }, { status: 429 });
      }
      const body = await request.json().catch(() => ({}));
      const identifier = String(body.username || body.email || '').trim();
      const password = String(body.password || '');
      if (!identifier || !password) return jsonResponse({ error: 'Missing credentials' }, { status: 400 });
      const user = await findUserByLogin(env, identifier);
      if (!user) return jsonResponse({ error: 'Invalid login' }, { status: 401 });
      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) {
        if (!user.password_hash && user.discord_id) {
          return jsonResponse({ error: 'This account signs in with Discord. Use the Discord button (you can set a password afterwards on your account page).' }, { status: 401 });
        }
        return jsonResponse({ error: 'Invalid login' }, { status: 401 });
      }
      const token = await createSession(env, user.id, !!user.is_admin);
      ctx.waitUntil(env.DB.prepare("UPDATE users SET last_login=datetime('now') WHERE id=?").bind(user.id).run());
      return jsonResponse({ ok: true, isAdmin: !!user.is_admin, username: user.username }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (method === 'POST' && path === '/api/logout') {
      const sess = await getSession(env, request);
      if (sess) await env.SESSIONS.delete('sess:' + sess.token);
      return jsonResponse({ ok: true }, { 'Set-Cookie': clearCookie() });
    }

    if (method === 'GET' && path === '/api/me') {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ loggedIn: false, isAdmin: false });
      const u = await env.DB.prepare(
        `SELECT username, email, is_admin, display_name, avatar_url, email_verified, discord_id, password_hash
         FROM users WHERE id=?`
      ).bind(sess.userId).first().catch(() => null);
      if (!u) return jsonResponse({ loggedIn: false, isAdmin: false }, { 'Set-Cookie': clearCookie() });
      return jsonResponse({
        loggedIn: true,
        isAdmin: !!u.is_admin,
        username: u.username,
        displayName: u.display_name || u.username,
        avatarUrl: u.avatar_url || null,
        email: u.email || null,
        emailVerified: !!u.email_verified,
        discordLinked: !!u.discord_id,
        hasPassword: !!u.password_hash
      });
    }

    // ---------- AUTH: FORGOT / RESET PASSWORD ----------
    if (method === 'POST' && path === '/api/forgot-password') {
      if (await rateLimited(env, request, 'forgot', 5, 3600)) {
        return jsonResponse({ error: 'Too many reset requests. Try again later.' }, { status: 429 });
      }
      const body = await request.json().catch(() => ({}));
      const identifier = String(body.email || body.username || '').trim();
      if (!identifier) return jsonResponse({ error: 'Enter your email or username.' }, { status: 400 });
      if (!env.RESEND_API_KEY) {
        return jsonResponse({ error: 'Password reset email is not configured on this server yet. Contact an admin.' }, { status: 501 });
      }
      const user = await findUserByLogin(env, identifier);
      // Always report success so account existence can't be probed.
      if (user && user.email) {
        const token = randomToken();
        await env.SESSIONS.put('pwreset:' + token, String(user.id), { expirationTtl: 3600 });
        const link = url.origin + '/reset-password?token=' + token;
        ctx.waitUntil(sendEmail(env, user.email, 'Reset your password — ' + APP_NAME, emailShell(
          'Reset your password',
          `<p>Hi ${escapeHtml(user.display_name || user.username)},</p>
           <p>Someone (hopefully you) asked to reset the password for your ${APP_NAME} account.</p>
           <p><a href="${link}" style="color:#5b1f21;font-weight:bold">Choose a new password</a></p>
           <p>This link expires in 1 hour and can be used once.</p>`
        )));
      }
      return jsonResponse({ ok: true, message: 'If that account exists, a reset link is on its way to its email address.' });
    }

    if (method === 'POST' && path === '/api/reset-password') {
      const body = await request.json().catch(() => ({}));
      const token = String(body.token || '');
      const password = String(body.password || '');
      if (!token) return jsonResponse({ error: 'Missing reset token.' }, { status: 400 });
      if (!password || password.length < 8) return jsonResponse({ error: 'Password must be at least 8 characters.' }, { status: 400 });
      const userId = await env.SESSIONS.get('pwreset:' + token);
      if (!userId) return jsonResponse({ error: 'That reset link is invalid or has expired. Request a new one.' }, { status: 400 });
      const hash = await hashPassword(password);
      await env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(hash, userId).run();
      await env.SESSIONS.delete('pwreset:' + token);
      // Log them straight in for convenience.
      const u = await env.DB.prepare('SELECT id, is_admin FROM users WHERE id=?').bind(userId).first();
      const sessTok = await createSession(env, u.id, !!u.is_admin);
      return jsonResponse({ ok: true }, { 'Set-Cookie': sessionCookie(sessTok) });
    }

    // ---------- AUTH: EMAIL VERIFICATION ----------
    if (method === 'GET' && path === '/api/verify-email') {
      const token = url.searchParams.get('token') || '';
      const userId = token && await env.SESSIONS.get('verify:' + token);
      if (!userId) return redirectResponse(url.origin + '/account?verified=0');
      await env.DB.prepare('UPDATE users SET email_verified=1 WHERE id=?').bind(userId).run();
      await env.SESSIONS.delete('verify:' + token);
      return redirectResponse(url.origin + '/account?verified=1');
    }

    if (method === 'POST' && path === '/api/resend-verification') {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in' }, { status: 401 });
      if (await rateLimited(env, request, 'verify', 3, 3600)) {
        return jsonResponse({ error: 'Too many verification emails requested. Try again later.' }, { status: 429 });
      }
      const u = await env.DB.prepare('SELECT id, username, display_name, email, email_verified FROM users WHERE id=?')
        .bind(sess.userId).first();
      if (!u || !u.email) return jsonResponse({ error: 'No email on this account.' }, { status: 400 });
      if (u.email_verified) return jsonResponse({ ok: true, message: 'Email is already verified.' });
      const sent = await sendVerificationEmail(env, url.origin, u);
      if (!sent.ok) return jsonResponse({ error: sent.error }, { status: 502 });
      return jsonResponse({ ok: true, message: 'Verification email sent.' });
    }

    // ---------- AUTH: DISCORD OAUTH ----------
    if (method === 'GET' && path === '/api/auth/discord') {
      if (!discordConfigured(env)) return loginErrorRedirect(url.origin, 'Discord sign-in is not configured on this server yet.');
      const state = randomToken();
      let linkUserId = 0;
      if (url.searchParams.get('link') === '1') {
        const sess = await getSession(env, request);
        if (!sess) return loginErrorRedirect(url.origin, 'Log in first, then link Discord from your account page.');
        linkUserId = sess.userId;
      }
      await env.SESSIONS.put('oauth:' + state, JSON.stringify({ link: linkUserId }), { expirationTtl: 600 });
      const auth = new URL('https://discord.com/oauth2/authorize');
      auth.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
      auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('redirect_uri', discordRedirectUri(url.origin));
      auth.searchParams.set('scope', 'identify email');
      auth.searchParams.set('state', state);
      auth.searchParams.set('prompt', 'none');
      return redirectResponse(auth.toString());
    }

    if (method === 'GET' && path === '/api/auth/discord/callback') {
      if (!discordConfigured(env)) return loginErrorRedirect(url.origin, 'Discord sign-in is not configured.');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') || '';
      const stateRaw = state && await env.SESSIONS.get('oauth:' + state);
      if (!code || !stateRaw) return loginErrorRedirect(url.origin, 'Discord sign-in failed (state mismatch). Please try again.');
      await env.SESSIONS.delete('oauth:' + state);
      let linkUserId = 0;
      try { linkUserId = (JSON.parse(stateRaw).link | 0); } catch {}

      // Exchange the code for a token.
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID,
          client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: discordRedirectUri(url.origin)
        })
      });
      if (!tokenRes.ok) return loginErrorRedirect(url.origin, 'Discord sign-in failed (token exchange). Please try again.');
      const tok = await tokenRes.json();

      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: 'Bearer ' + tok.access_token }
      });
      if (!userRes.ok) return loginErrorRedirect(url.origin, 'Discord sign-in failed (profile fetch). Please try again.');
      const du = await userRes.json();
      const discordId = String(du.id);
      const discordName = du.global_name || du.username || 'user';
      const avatarUrl = du.avatar
        ? `https://cdn.discordapp.com/avatars/${discordId}/${du.avatar}.png?size=128`
        : null;
      const discordEmail = (du.email && du.verified) ? String(du.email) : null;

      const byDiscord = await env.DB.prepare('SELECT * FROM users WHERE discord_id=?').bind(discordId).first();

      // Link mode: attach this Discord identity to the logged-in account.
      if (linkUserId) {
        if (byDiscord && byDiscord.id !== linkUserId) {
          return redirectResponse(url.origin + '/account?error=' + encodeURIComponent('That Discord account is already linked to a different wiki account.'));
        }
        await env.DB.prepare(
          `UPDATE users SET discord_id=?, discord_username=?, avatar_url=COALESCE(avatar_url, ?) WHERE id=?`
        ).bind(discordId, du.username || discordName, avatarUrl, linkUserId).run();
        return redirectResponse(url.origin + '/account?linked=1');
      }

      // Existing Discord-linked account -> log in.
      if (byDiscord) {
        await env.DB.prepare(
          `UPDATE users SET discord_username=?, avatar_url=COALESCE(?, avatar_url), last_login=datetime('now') WHERE id=?`
        ).bind(du.username || discordName, avatarUrl, byDiscord.id).run();
        const t = await createSession(env, byDiscord.id, !!byDiscord.is_admin);
        return redirectResponse(url.origin + '/account', sessionCookie(t));
      }

      // Same verified email already on a verified account -> link + log in.
      if (discordEmail) {
        const byEmail = await env.DB.prepare(
          'SELECT * FROM users WHERE email IS NOT NULL AND lower(email)=lower(?)'
        ).bind(discordEmail).first();
        if (byEmail) {
          if (!byEmail.email_verified) {
            return loginErrorRedirect(url.origin, 'An account with your Discord email already exists but its email is unverified. Log in with your password, verify your email, then link Discord from your account page.');
          }
          await env.DB.prepare(
            `UPDATE users SET discord_id=?, discord_username=?, avatar_url=COALESCE(avatar_url, ?), last_login=datetime('now') WHERE id=?`
          ).bind(discordId, du.username || discordName, avatarUrl, byEmail.id).run();
          const t = await createSession(env, byEmail.id, !!byEmail.is_admin);
          return redirectResponse(url.origin + '/account?linked=1', sessionCookie(t));
        }
      }

      // Brand-new account from Discord. No password yet ('' = Discord-only).
      const username = await uniqueUsername(env, discordName);
      const ins = await env.DB.prepare(
        `INSERT INTO users (username, password_hash, email, is_admin, display_name, discord_id, discord_username, avatar_url, email_verified, last_login)
         VALUES (?, '', ?, 0, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(username, discordEmail, discordName, discordId, du.username || discordName, avatarUrl, discordEmail ? 1 : 0).run();
      const newId = ins.meta.last_row_id;
      await logActivity(env, { userId: newId }, 'signup', 'user', null, username);
      const t = await createSession(env, newId, false);
      return redirectResponse(url.origin + '/account?welcome=1', sessionCookie(t));
    }

    // ---------- ACCOUNT PAGE DATA ----------
    if (method === 'GET' && path === '/api/account') {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in' }, { status: 401 });
      const batch = await env.DB.batch([
        env.DB.prepare(`SELECT username, email, is_admin, display_name, bio, discord_id, discord_username, avatar_url, email_verified, password_hash, created_at, last_login FROM users WHERE id=?`).bind(sess.userId),
        env.DB.prepare(`SELECT slug, name, team, status, created_at, updated_at FROM characters WHERE owner_id=? ORDER BY updated_at DESC`).bind(sess.userId),
        env.DB.prepare(`SELECT slug, display_name AS name, status, created_at, updated_at FROM collections WHERE owner_id=? ORDER BY updated_at DESC`).bind(sess.userId),
        env.DB.prepare(`SELECT slug, name, status, created_at, updated_at FROM scripts WHERE owner_id=? ORDER BY updated_at DESC`).bind(sess.userId),
        env.DB.prepare(`SELECT ts, action, entity_type, entity_slug, entity_name FROM activity_log WHERE user_id=? ORDER BY ts DESC, id DESC LIMIT 50`).bind(sess.userId)
      ]);
      const u = batch[0].results[0];
      if (!u) return jsonResponse({ error: 'Not logged in' }, { status: 401, 'Set-Cookie': clearCookie() });
      return jsonResponse({
        profile: {
          username: u.username,
          displayName: u.display_name || u.username,
          bio: u.bio || '',
          email: u.email || null,
          emailVerified: !!u.email_verified,
          isAdmin: !!u.is_admin,
          discordLinked: !!u.discord_id,
          discordUsername: u.discord_username || null,
          avatarUrl: u.avatar_url || null,
          hasPassword: !!u.password_hash,
          createdAt: u.created_at,
          lastLogin: u.last_login
        },
        characters: batch[1].results,
        collections: batch[2].results,
        scripts: batch[3].results,
        recentEdits: batch[4].results
      });
    }

    // ---------- FETCH A PAGE FOR EDITING (drafts included for owner) ----------
    if (method === 'GET' && path === '/api/page') {
      const type = url.searchParams.get('type') || 'character';
      const slug = url.searchParams.get('slug') || '';
      if (!CONTENT[type]) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
      let row = await getEntityRow(env, type, slug);
      // Legacy collection rows have display-string PK slugs; resolve by id too.
      if (!row && type === 'collection') row = await findCollectionRow(env, slug);
      if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
      const sess = await getSession(env, request);
      const editable = canEditRow(sess, row);
      if (row.status === 'draft' && !editable) return jsonResponse({ error: 'Not found' }, { status: 404 });
      return jsonResponse({ data: JSON.parse(row.data), status: row.status || 'published', canEdit: editable });
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
        env.DB.prepare(`SELECT value FROM settings WHERE key='wiki_locked'`),
        env.DB.prepare(
          `SELECT 'collection' AS type, slug, display_name AS name FROM collections WHERE owner_id IS NULL
           UNION ALL SELECT 'script', slug, name FROM scripts WHERE owner_id IS NULL
           UNION ALL SELECT 'character', slug, name FROM characters WHERE owner_id IS NULL
           ORDER BY type, name LIMIT 200`)
      ]);

      const lockVal = batch[6].results[0];
      return jsonResponse({
        counts: batch[0].results[0],
        charactersByTeam: batch[1].results,
        recentEdits: batch[2].results,
        recentCreations: batch[3].results,
        recentActivity: batch[4].results,
        recentSignups: batch[5].results,
        locked: !!lockVal && lockVal.value === '1',
        unowned: batch[7].results
      });
    }

    // ---------- WRITES (logged-in users; ownership enforced) ----------
    if (method === 'POST' && path.startsWith('/api/')) {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in. Create an account or log in first.' }, { status: 401 });

      // Admin-only endpoints keep their old guard.
      const adminOnly = (path === '/api/lock' || path === '/api/seed' || path === '/api/backup' ||
                         path === '/api/admin/assign-owner');
      if (adminOnly && !sess.isAdmin) return jsonResponse({ error: 'Not authorized' }, { status: 403 });

      // Content writes are blocked while the wiki is locked (true freeze,
      // applies to admins too). Lock toggle + seed are intentionally exempt.
      const isContentWrite = ['/api/character', '/api/collection', '/api/script', '/api/publish', '/api/delete', '/api/upload'].includes(path);
      if (isContentWrite && await isWikiLocked(env)) {
        return jsonResponse({ error: 'The wiki is locked. Editing and page creation are temporarily disabled.' }, { status: 423 });
      }

      // ---- account settings ----
      if (path === '/api/account/profile') {
        const b = await request.json().catch(() => ({}));
        const displayName = String(b.displayName || '').trim().slice(0, 40) || null;
        const bio = String(b.bio || '').trim().slice(0, 500) || null;
        await env.DB.prepare('UPDATE users SET display_name=?, bio=? WHERE id=?')
          .bind(displayName, bio, sess.userId).run();
        return jsonResponse({ ok: true });
      }

      if (path === '/api/account/password') {
        const b = await request.json().catch(() => ({}));
        const newPassword = String(b.newPassword || '');
        if (newPassword.length < 8) return jsonResponse({ error: 'New password must be at least 8 characters.' }, { status: 400 });
        const u = await env.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind(sess.userId).first();
        if (u.password_hash) {
          const ok = await verifyPassword(String(b.currentPassword || ''), u.password_hash);
          if (!ok) return jsonResponse({ error: 'Current password is incorrect.' }, { status: 403 });
        }
        // (no current password on Discord-only accounts: they may set one freely)
        await env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?')
          .bind(await hashPassword(newPassword), sess.userId).run();
        return jsonResponse({ ok: true });
      }

      if (path === '/api/account/email') {
        const b = await request.json().catch(() => ({}));
        const email = String(b.email || '').trim();
        if (!EMAIL_RE.test(email) || email.length > 254) return jsonResponse({ error: 'Please enter a valid email address.' }, { status: 400 });
        const taken = await env.DB.prepare('SELECT 1 FROM users WHERE id<>? AND email IS NOT NULL AND lower(email)=lower(?)')
          .bind(sess.userId, email).first();
        if (taken) return jsonResponse({ error: 'That email is already in use by another account.' }, { status: 409 });
        await env.DB.prepare('UPDATE users SET email=?, email_verified=0 WHERE id=?')
          .bind(email, sess.userId).run();
        const u = await env.DB.prepare('SELECT id, username, display_name, email FROM users WHERE id=?').bind(sess.userId).first();
        ctx.waitUntil(sendVerificationEmail(env, url.origin, u));
        return jsonResponse({ ok: true, message: 'Email updated. Check your inbox for a verification link.' });
      }

      if (path === '/api/account/unlink-discord') {
        const u = await env.DB.prepare('SELECT password_hash, discord_id FROM users WHERE id=?').bind(sess.userId).first();
        if (!u.discord_id) return jsonResponse({ error: 'No Discord account is linked.' }, { status: 400 });
        if (!u.password_hash) return jsonResponse({ error: 'Set a password first so you can still log in after unlinking Discord.' }, { status: 400 });
        await env.DB.prepare('UPDATE users SET discord_id=NULL, discord_username=NULL WHERE id=?').bind(sess.userId).run();
        return jsonResponse({ ok: true });
      }

      // ---- image upload (ownership-checked) ----
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
        if (bytes.length > 8 * 1024 * 1024) {
          return jsonResponse({ error: 'Image is too large (8 MB max).' }, { status: 413 });
        }

        if (!sess.isAdmin) {
          // tokens/ is reserved for admin tooling.
          if (key.startsWith('tokens/')) return jsonResponse({ error: 'Not authorized for that upload path.' }, { status: 403 });
          // Character art follows art/{slug}.png — if that character exists,
          // only its owner may replace the art.
          if (key.startsWith('art/')) {
            const slug = key.slice(4).replace(/\.[a-z0-9]+$/i, '');
            const row = await getEntityRow(env, 'character', slug);
            if (row && !canEditRow(sess, row)) {
              return jsonResponse({ error: 'That art slot belongs to a character owned by another account.' }, { status: 403 });
            }
          }
          // Script images follow scripts/{slug}[-logo|-bg].{ext}; collection
          // images collections/{id}[-logo|-bg].{ext}. If that page exists,
          // only its owner may replace its images.
          if (key.startsWith('scripts/')) {
            const base = key.slice(8).replace(/\.[a-z0-9]+$/i, '').replace(/-(logo|bg)$/, '');
            const row = await getEntityRow(env, 'script', base);
            if (row && !canEditRow(sess, row)) {
              return jsonResponse({ error: 'That image slot belongs to a script owned by another account.' }, { status: 403 });
            }
          }
          if (key.startsWith('collections/')) {
            const base = key.slice(12).replace(/\.[a-z0-9]+$/i, '').replace(/-(logo|bg)$/, '');
            const row = await findCollectionRow(env, base);
            if (row && !canEditRow(sess, row)) {
              return jsonResponse({ error: 'That image slot belongs to a collection owned by another account.' }, { status: 403 });
            }
          }
          // Never allow silently replacing someone else's uploaded file.
          const existing = await env.ART.head(key).catch(() => null);
          if (existing) {
            const owner = existing.customMetadata && existing.customMetadata.owner;
            if (owner !== String(sess.userId)) {
              return jsonResponse({ error: 'A file already exists at that path and belongs to another account.' }, { status: 403 });
            }
          }
        }

        const ext = key.split('.').pop().toLowerCase();
        if (!contentType) contentType = EXT_CONTENT_TYPE[ext] || 'application/octet-stream';
        await env.ART.put(key, bytes, {
          httpMetadata: { contentType },
          customMetadata: { owner: String(sess.userId) }
        });
        return jsonResponse({ ok: true, path: '/assets/' + key });
      }

      // ---- content create / update ----
      if (path === '/api/character') {
        const c = await request.json();
        if (!c || !c.slug || !c.name || !c.team || !c.ability)
          return jsonResponse({ error: 'Missing required fields' }, { status: 400 });
        const existing = await getEntityRow(env, 'character', c.slug);
        if (existing && !canEditRow(sess, existing)) {
          return jsonResponse({ error: 'A character with that name already exists and belongs to another account. Pick a different name.' }, { status: 403 });
        }
        const status = c.status === 'draft' ? 'draft' : 'published';
        delete c.status;
        await env.DB.prepare(
          `INSERT INTO characters (slug,name,team,creator,owner_id,tags,appears_in,data,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             name=excluded.name, team=excluded.team, creator=excluded.creator,
             tags=excluded.tags, appears_in=excluded.appears_in,
             data=excluded.data, status=excluded.status, updated_at=datetime('now')`
        ).bind(c.slug, c.name, c.team, c.creator || null, sess.userId,
               c.tags || null, c.appearsIn || null, JSON.stringify(c), status).run();
        await logActivity(env, sess, existing ? 'update' : 'create', 'character', c.slug, c.name);
        return jsonResponse({ ok: true, slug: c.slug, status });
      }

      if (path === '/api/collection') {
        const c = await request.json();
        if (!c || (!c.slug && !c.id && !c.displayName)) {
          return jsonResponse({ error: 'Missing collection name' }, { status: 400 });
        }
        // Resolve the row this write targets: PK slug first, then kebab id
        // (legacy rows have display-string PK slugs, e.g. "The Academy").
        let existing = c.slug ? await getEntityRow(env, 'collection', c.slug) : null;
        if (!existing) existing = await findCollectionRow(env, c.id || c.slug);
        if (existing && !canEditRow(sess, existing)) {
          return jsonResponse({ error: 'That collection belongs to another account.' }, { status: 403 });
        }
        // Keep the existing PK for updates; new collections use the kebab id
        // as PK so the URL, id and PK all agree.
        const kebab = s => String(s || '').toLowerCase().normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
        c.id = kebab(c.id) || kebab(c.displayName) || kebab(c.slug);
        if (!c.id) return jsonResponse({ error: 'Could not derive a collection id from that name.' }, { status: 400 });
        const pkSlug = existing ? existing.slug : c.id;
        if (!existing) {
          // creating: the id must not collide with another collection's id
          const clash = await findCollectionRow(env, c.id);
          if (clash && clash.slug !== pkSlug) {
            return jsonResponse({ error: 'A collection with that name already exists.' }, { status: 409 });
          }
          c.slug = c.id;
        } else {
          c.slug = existing.slug;
        }
        if (!c.displayName) c.displayName = existing ? existing.name : c.slug;
        sanitizePageFields(c, 'collections/' + c.id);
        c.match = Array.isArray(c.match)
          ? c.match.slice(0, 30).map(s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean)
          : [];
        for (const k of ['include', 'exclude']) {
          c[k] = Array.isArray(c[k]) ? c[k].slice(0, 500).map(x => String(x).slice(0, 80)) : [];
        }
        const status = c.status === 'draft' ? 'draft' : 'published';
        delete c.status;
        await env.DB.prepare(
          `INSERT INTO collections (slug,display_name,owner_id,data,status,created_at,updated_at)
           VALUES (?,?,?,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             display_name=excluded.display_name, data=excluded.data, status=excluded.status, updated_at=datetime('now')`
        ).bind(pkSlug, c.displayName, sess.userId, JSON.stringify(c), status).run();
        await logActivity(env, sess, existing ? 'update' : 'create', 'collection', pkSlug, c.displayName);
        return jsonResponse({ ok: true, slug: pkSlug, id: c.id, status });
      }

      if (path === '/api/script') {
        const s = await request.json();
        if (!s || !s.slug) return jsonResponse({ error: 'Missing slug' }, { status: 400 });
        if (!/^[a-z0-9-]{1,80}$/.test(String(s.slug))) {
          return jsonResponse({ error: 'Invalid script slug.' }, { status: 400 });
        }
        const existing = await getEntityRow(env, 'script', s.slug);
        if (existing && !canEditRow(sess, existing)) {
          return jsonResponse({ error: 'That script belongs to another account.' }, { status: 403 });
        }
        sanitizePageFields(s, 'scripts/' + s.slug);
        s.characters = Array.isArray(s.characters)
          ? s.characters.slice(0, 100).map(x => String(x).slice(0, 80))
          : [];
        const status = s.status === 'draft' ? 'draft' : 'published';
        delete s.status;
        await env.DB.prepare(
          `INSERT INTO scripts (slug,name,author,owner_id,data,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             name=excluded.name, author=excluded.author, data=excluded.data, status=excluded.status, updated_at=datetime('now')`
        ).bind(s.slug, s.name || s.slug, s.author || null, sess.userId, JSON.stringify(s), status).run();
        await logActivity(env, sess, existing ? 'update' : 'create', 'script', s.slug, s.name || s.slug);
        return jsonResponse({ ok: true, slug: s.slug, status });
      }

      // ---- publish / unpublish a page ----
      if (path === '/api/publish') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || 'character');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        const row = await getEntityRow(env, type, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        if (!canEditRow(sess, row)) return jsonResponse({ error: 'That page belongs to another account.' }, { status: 403 });
        const status = b.status === 'draft' ? 'draft' : 'published';
        await env.DB.prepare(`UPDATE ${t.table} SET status=?, updated_at=datetime('now') WHERE slug=?`)
          .bind(status, row.slug).run();
        await logActivity(env, sess, status === 'published' ? 'publish' : 'unpublish', type, row.slug, row.name);
        return jsonResponse({ ok: true, slug: row.slug, status });
      }

      // ---- delete a page ----
      if (path === '/api/delete') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || 'character');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        const row = await getEntityRow(env, type, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        if (!canEditRow(sess, row)) return jsonResponse({ error: 'That page belongs to another account.' }, { status: 403 });
        await env.DB.prepare(`DELETE FROM ${t.table} WHERE slug=?`).bind(row.slug).run();
        await logActivity(env, sess, 'delete', type, row.slug, row.name);
        return jsonResponse({ ok: true });
      }

      // ---- admin: assign (or clear) a page's owner ----
      // Body: {type: 'character'|'collection'|'script', slug, username|null}.
      // Lets seeded pages (owner_id NULL) be claimed for their creators.
      if (path === '/api/admin/assign-owner') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        let row = await getEntityRow(env, type, String(b.slug || ''));
        if (!row && type === 'collection') row = await findCollectionRow(env, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        let ownerId = null;
        const uname = String(b.username || '').trim();
        if (uname) {
          const u = await env.DB.prepare('SELECT id, username FROM users WHERE lower(username)=lower(?)')
            .bind(uname).first();
          if (!u) return jsonResponse({ error: 'No user named "' + uname + '".' }, { status: 404 });
          ownerId = u.id;
        }
        await env.DB.prepare(`UPDATE ${t.table} SET owner_id=?, updated_at=datetime('now') WHERE slug=?`)
          .bind(ownerId, row.slug).run();
        await logActivity(env, sess, 'assign-owner', type, row.slug, row.name);
        return jsonResponse({ ok: true, slug: row.slug, owner: uname || null });
      }

      // ---- admin: wiki lock ----
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

      // ---- admin: run a D1 -> R2 backup right now ----
      if (path === '/api/backup') {
        try {
          const result = await runBackup(env);
          await logActivity(env, sess, 'backup', 'wiki', null, result.date);
          return jsonResponse({ ok: true, ...result });
        } catch (e) {
          return jsonResponse({ error: (e && e.message) || 'Backup failed.' }, { status: 500 });
        }
      }

      // ---- admin: one-time seed ----
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
  },

  // Nightly cron (see [triggers] in wrangler.toml): back up D1 to R2.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBackup(env));
  }
};
