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
 *     ?drafts=1               -> ADMINS ONLY: also includes draft rows, each
 *                                stamped with `status`. Non-admins asking for
 *                                it get the ordinary published-only feed.
 *
 *   -- auth --
 *   POST /api/signup          -> create an account (username/email/password)
 *   POST /api/login           -> log in (username, email, or the display name
 *                                the site shows you, + password)
 *   POST /api/logout          -> clears session
 *   GET  /api/me              -> who am I
 *   POST /api/forgot-password -> email a password-reset link
 *   POST /api/reset-password  -> set new password from a reset token
 *   GET  /api/verify-email    -> confirm email from the emailed link
 *   POST /api/resend-verification
 *   GET  /api/auth/discord    -> start Discord OAuth (sign in / sign up / link)
 *   GET  /api/auth/discord/callback
 *                              (both pin their redirect_uri to CANONICAL_ORIGIN
 *                               — never to the request's host; see the helpers)
 *
 *   -- account --
 *   GET  /api/account         -> profile + your pages + drafts + recent edits
 *   POST /api/account/profile -> update display name / bio
 *   POST /api/account/avatar  -> upload/remove your profile picture (R2)
 *   POST /api/account/password-> change (or set) password
 *   POST /api/account/email   -> change email (re-verifies)
 *   POST /api/account/unlink-discord
 *   GET  /api/contact         -> your own messages to the admins
 *   POST /api/contact         -> send a message to the admins (bug/suggestion/…)
 *   POST /api/report-broken-link -> the 404 page's "this looks like a mistake"
 *                                box; same inbox as /api/contact, but works
 *                                without an account (rate-limited per IP)
 *   GET  /api/announcement    -> current site-wide announcement (public)
 *   GET  /api/site-text       -> the site's rewritten system text, as a map
 *                                site.js applies in the browser (public,
 *                                empty unless an admin has edited something)
 *
 *   -- direct messages (user <-> user, incl. admins; /messages page) --
 *   GET  /api/messages        -> conversation list + unread counts + block list
 *   GET  /api/messages/thread -> one conversation (?with=username, ?before=id)
 *   POST /api/messages/send   -> send a DM ({to, body})
 *   POST /api/messages/block  -> block/unblock a user ({user, blocked})
 *   POST /api/messages/delete -> hide a whole conversation for yourself ({with})
 *   POST /api/messages/report -> report a conversation to the admins ({with, reason})
 *   GET  /api/admin/dm-reports -> reported conversations (?status=open|all)
 *   POST /api/admin/dm-report  -> resolve/reopen/delete one report
 *   GET  /api/admin/dm-thread  -> transcript of a REPORTED conversation (?a=&b=)
 *
 *   -- comments (character / collection / script / news pages) --
 *   GET  /api/comments        -> a page's comments (?type=&slug=; public)
 *   POST /api/comments        -> post a comment or reply ({parentId} to reply;
 *                                {agree:true} carries the first-time agreement)
 *   POST /api/comments/agree  -> record the one-time comment-terms agreement
 *   POST /api/comments/delete -> remove one (author, page owner, or admin)
 *   POST /api/comments/pin    -> pin/unpin a thread (page owner or admin)
 *   POST /api/comments/report -> report one to the admins
 *
 *   -- news (admin-written articles) --
 *   GET  /api/news            -> published articles (?limit=, admin ?drafts=1)
 *   GET  /api/news/item       -> one article (?slug=; drafts admin-only)
 *   GET  /news/{slug}         -> article page (server-side rendered, comments)
 *   POST /api/admin/news      -> create/update/delete an article
 *
 *   -- custom wiki pages (text-first pages under a script/collection) --
 *   GET  /api/wiki-pages      -> pages under one parent (?parentType=&parentSlug=)
 *                                or everything one author wrote (?author=)
 *   GET  /api/wiki-page       -> one page for editing (?slug=; drafts incl.)
 *   POST /api/wiki-page       -> create/update/delete one ({action:'delete'})
 *   GET  /p/{slug}            -> the page itself (SSR, noindex, comments).
 *                                Deliberately unlisted: no sitemap entry, no
 *                                search, no browse list — only the parent
 *                                script/collection page and its author's page
 *                                link to it.
 *
 *   -- content (any logged-in user; edits restricted to owner/admin) --
 *   GET  /api/page            -> fetch one page for editing (drafts incl.)
 *   GET  /api/slug-check      -> is this page's identity free? (?type=&name=&appearsIn=)
 *                                For a character that is the PK and the art slot,
 *                                NOT the URL — see CHARACTER ADDRESSES below.
 *                                returns {taken, mine, suggestion} so an editor
 *                                can pick a free URL before uploading art
 *   POST /api/character       -> create/update a character; {renameFrom} moves
 *                                a page to a new URL and 301s the old one
 *   POST /api/collection      -> create/update a collection
 *   POST /api/script          -> create/update a script
 *   POST /api/publish         -> flip a page between draft and published
 *   POST /api/delete          -> soft-delete a page you own (recoverable)
 *   POST /api/upload          -> image upload to R2 (ownership-checked)
 *   GET  /api/page-json       -> a script's or collection's export JSON as a
 *                                real downloadable file (?type=&slug=), which is
 *                                what the page's Download JSON button links to
 *
 *   -- importing a Bloodstar project (/bloodstar) --
 *   GET  /api/bloodstar       -> read a project on Bloodstar: fetches its
 *                                script.json AND its almanac.html and returns
 *                                one normalized bundle (meta, characters with
 *                                their almanac prose, jinxes, night order,
 *                                synopsis/overview/changelog). Login required
 *                                and the host is pinned to Bloodstar's own
 *                                hosts (bloodstar.clocktica.com, bloodstar.xyz).
 *   POST /api/bloodstar-art   -> copy one image from Bloodstar into an R2
 *                                slot without it passing through the browser.
 *                                Same permission check as /api/upload
 *                                (uploadSlotDenied), same size and type rules.
 *
 *   -- public pages & discovery --
 *   GET  /api/user            -> creator page data (?u=username or ?a=creator
 *                                name): owned + credited pages, drafts for the
 *                                owner/admins
 *   GET  /api/creators        -> every creator with counts + linked account
 *   GET  /api/jinxes          -> every jinx on the wiki as nodes + edges, for
 *                                the /jinxes index and its relationship graph
 *   POST /api/jinx            -> add/edit/remove one jinx; you need to own
 *                                (or admin) just one of the two characters
 *   GET  /api/admin/jinx-health -> admin: jinxes pointing at nothing, and
 *                                pairs where both sides wrote a rule
 *   GET  /u/{username}        -> creator page (serves profile.html)
 *   GET  /author?a={name}     -> same page; 302 to /u/{username} when the name
 *                                belongs to an account
 *   POST /api/admin/creator-alias -> admin: link a creator name to an account
 *   GET  /random              -> 302 to a random published character page
 *   GET  /sitemap.xml         -> built live from D1
 *   GET  /s/{slug}            -> script page (server-side rendered from D1)
 *   GET  /collection/{id}     -> collection page (server-side rendered from D1)
 *   GET  /script-view(.html)  -> 301 to /s/{slug} (legacy links)
 *   POST /api/admin/assign-owner -> admin: set/clear a page's owner account
 *
 *   -- admin --
 *   GET  /api/admin/dashboard -> dashboard data (incl. deleted + protected)
 *   GET  /api/admin/activity  -> full activity log (paginated + filterable)
 *   GET  /api/admin/report    -> activity report for the last ?days=N days
 *   GET  /api/admin/revisions -> version history for one page (?type=&slug=)
 *   GET  /api/page-history    -> a published page's edit log (public; ?type=&slug=)
 *   GET  /api/page-revision   -> one entry of it, field by field (?type=&slug=&id=)
 *   POST /api/page-rollback   -> put an earlier version back (owner or admin)
 *   POST /api/suggest         -> propose an edit to a page open to suggestions
 *   GET  /api/suggestions     -> a page's suggestions (?type=&slug=) or ?inbox=1
 *   POST /api/suggestion      -> approve / decline / withdraw one
 *   GET  /api/shared-pages    -> pages this account is an approved editor of
 *   GET  /api/account-lookup  -> does this username exist? (the editor picker)
 *   POST /api/admin/rollback  -> roll a page back to an earlier revision
 *   POST /api/admin/restore   -> admin: restore a soft-deleted page
 *   POST /api/admin/purge     -> admin: permanently delete a soft-deleted page
 *   GET  /api/admin/users     -> user list (?q= search) for the users panel
 *   GET  /api/admin/user-names -> every handle, for the dashboard type-ahead
 *   POST /api/admin/user      -> ban/unban/promote/demote/reset-link for a user
 *   GET  /api/admin/messages  -> contact-form inbox (?status=open|all)
 *   POST /api/admin/message   -> reply to / resolve / reopen / delete an inbox
 *                                message; {action:'reply', body} sends the
 *                                answer to its author as a direct message
 *   POST /api/admin/protect   -> protect/unprotect one page from edits
 *   POST /api/admin/announce  -> set/clear the site-wide announcement banner
 *   GET  /api/admin/site-text -> every saved system-text override, with who
 *                                changed it and when (/text-editor)
 *   POST /api/admin/site-text -> rewrite one of the site's own strings, or
 *                                revert it to whatever the source file says
 *   GET  /api/admin/orphans   -> R2 images no page references any more
 *   POST /api/admin/purge-images -> delete selected orphaned images
 *   GET  /api/admin/broken-refs  -> scripts/collections pointing at missing chars
 *   POST /api/admin/clean-refs   -> strip broken refs from one page
 *   GET  /api/admin/backups   -> list nightly R2 backups (dates + tables)
 *   GET  /api/admin/backup-file  -> download one backup table (?date=&table=)
 *   POST /api/admin/restore-page -> restore one page from a backup date
 *   GET  /api/admin/pages     -> page list for bulk actions
 *                                (?type=&q=&owner=&status=&collection=
 *                                 &flag=no-icon|partial|curata|no-owner)
 *   POST /api/admin/bulk      -> bulk publish/unpublish/delete/owner/tag/curata ops
 *   GET  /api/admin/analytics -> most-viewed pages for the last ?days=N days
 *   GET  /api/admin/discord-check -> is Discord sign-in actually working: asks
 *                                Discord whether the app credentials are still
 *                                valid, and prints the exact callback URL the
 *                                Developer Portal must have registered
 *   GET  /api/admin/comments  -> moderation queue (?view=reported|recent|removed)
 *   POST /api/admin/comment   -> remove/restore/resolve/purge one comment
 *   POST /api/admin/curata -> grant/remove Curata on one page
 *   POST /api/admin/collect-creator -> put every character by one creator into
 *                                a collection (creates it if needed)
 *   POST /api/admin/concepts-to-pages -> turn rules-construct characters into
 *                                wiki pages under a collection and retire them
 *   POST /api/admin/curata-owner -> grant Curata to every character one
 *                                account owns (?dryRun to count first)
 *   POST /api/admin/tags-open-owner -> open TAG editing on every untagged
 *                                character one account owns ({dryRun:true}
 *                                first; never touches a page that already
 *                                names a sharing mode)
 *   POST /api/admin/demote-incomplete -> sweep published characters that no
 *                                longer meet the publish bar into drafts
 *                                (alias: /api/admin/demote-no-icon)
 *   POST /api/admin/official-cleanup -> find pages that ARE official
 *                                characters (same name AND ability) and retire
 *                                them: script rosters are repointed at
 *                                'off-{id}', collections drop them, and the
 *                                pages are soft-deleted so they can be
 *                                restored. {dryRun:true} first. Pages that
 *                                only share a NAME are reported, never touched.
 *   POST /api/admin/cleanup-odyssey -> ONE-TIME: em dashes + gendered pronouns
 *                                      in the Odyssey almanacs. Remove after use.
 *   POST /api/admin/nest-urls -> give every character a nested /c/{set}/{character}
 *                                address ({dryRun:true} to preview; re-runnable)
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
 *   SITE_ORIGIN           -> the site's canonical origin, if it ever moves
 *                            off https://botchomebrew.wiki (optional)
 *   DISCORD_REDIRECT_URI  -> overrides the whole callback URL (optional; only
 *                            needed if it cannot be SITE_ORIGIN + the callback
 *                            path). Whatever this resolves to must be
 *                            registered in the Discord Developer Portal.
 *
 * Discord sign-in is checkable without a reader: GET /api/admin/discord-check
 * (admin) asks Discord whether the client id/secret pair is still valid and
 * prints the exact redirect URL the portal has to hold.
 */

// esbuild bundles render.js's CommonJS export into the Worker; no DOM here.
import Render from '../assets/render.js';
// Shared script/collection page renderer (also used by the publish pages in
// the browser). It receives render.js's exports through init().
import PageRender from '../assets/render-page.js';
PageRender.init(Render);
// Creator-symbol registry ("credit icons"), single source in creators.js.
// Injected so SSR /c/ pages show a creator's symbol next to their name.
import Creators from '../assets/creators.js';
Render.setCreators(Creators);
// Partial / Standard / Curata rules — shared with every browser page so
// the badges and filters agree with what the Worker serves.
import Classify from '../assets/classify.js';
// Lets render.js emit the Curata mark without importing classify.js
// itself (it is loaded standalone in the browser).
Render.setCurataMark(Classify.classBadgeHTML);
// Wiki text engine: the markdown-ish formatter + the text-first page layout,
// shared by /p/{slug} pages, news articles and the announcement banner.
import WikiRender from '../assets/render-wiki.js';
// News article renderer (also used by the /news index and the admin editor
// preview in the browser). It formats text through render-wiki.js.
import NewsRender from '../assets/render-news.js';
NewsRender.init(WikiRender);
// The character renderer formats one field (the pronunciation line) through
// the same engine, so **bold** there means what it means everywhere else.
Render.init(WikiRender);
// The prose this Worker prints into pages (the Partial banner, the draft
// bars). It lives in assets/ because /text-editor builds its catalogue by
// fetching the site's own files in the browser, and worker.js is not one of
// them — it is excluded from the asset upload. Put new server-rendered
// wording there, not inline here, or the owner cannot edit it.
import SYS from '../assets/system-text.js';
// The official roster, turned into wiki character objects (night positions
// merged in from night-order.json). Shared with script.html and
// publish-script.html so a script page, the builder and the night-order
// arranger all see the same official characters.
import OfficialRoles from '../assets/official-roles.js';

// Reading a Bloodstar project (script.json + almanac.html) into this wiki's
// shapes, for /bloodstar. Worker-only: it has no DOM, because Workers have no
// DOMParser, and worker/ is excluded from the asset upload so it costs the
// site nothing. See the header of that file for the almanac's shape.
import * as Bloodstar from './bloodstar.js';
// One-time text cleanup for the Odyssey almanacs, driving
// POST /api/admin/cleanup-odyssey (the "Clean up Odyssey text" dashboard card).
// Lives in migration/ (in .assetsignore) so it is never served as a static file.
// Delete this import, the route and the card once the cleanup has been run.
import OdysseyCleanup from '../migration/odyssey-cleanup.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const APP_NAME = 'BOTC Homebrew Wiki';

const R2_PREFIXES = ['art/', 'collections/', 'scripts/', 'tokens/', 'pages/', 'news/'];
// avatars/ is servable from R2 but NOT uploadable through the generic
// /api/upload — profile pictures only go through /api/account/avatar,
// which pins the key to the logged-in user's own slot.
const R2_SERVE_PREFIXES = R2_PREFIXES.concat(['avatars/']);
const EXT_CONTENT_TYPE = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml'
};

// What /api/upload will accept, and the extensions each type is allowed to be
// stored under. Deliberately NOT derived from EXT_CONTENT_TYPE: that map is the
// read side (it labels bytes already in the bucket, including legacy SVGs), and
// image/svg+xml must never be writable — an SVG is a script-execution format
// with an image extension, and these files are served from the site's origin.
const UPLOAD_CONTENT_TYPES = {
  'image/png':  { type: 'image/png',  exts: ['png'] },
  'image/jpeg': { type: 'image/jpeg', exts: ['jpg', 'jpeg'] },
  'image/webp': { type: 'image/webp', exts: ['webp'] },
  'image/gif':  { type: 'image/gif',  exts: ['gif'] }
};

// Content-type registry: maps API "type" to its table + display columns.
const CONTENT = {
  character:  { table: 'characters',  nameCol: 'name' },
  collection: { table: 'collections', nameCol: 'display_name' },
  script:     { table: 'scripts',     nameCol: 'name' }
};
// Every content type that can carry comments. `news` and `wikipage` are not
// in CONTENT (they have their own tables and handlers) but readers can comment
// on both.
const COMMENTABLE = ['character', 'collection', 'script', 'news', 'wikipage'];

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
// KV cannot be queried by value, so revoking "every session belonging to user
// N" needs an index we maintain ourselves: usess:{id} holds that account's
// live tokens. Without it, changing a password left every existing 30-day
// cookie valid — so a stolen session survived the exact thing a worried user
// would do about it.
const SESSION_TTL = 60 * 60 * 24 * 30;
// A cap, because this list is only ever read to revoke. An account with more
// live sessions than this has bigger problems, and the oldest simply age out
// on their own TTL as they always did.
const SESSION_INDEX_MAX = 40;

// How long a half-finished Discord sign-in stays valid. Ten minutes used to be
// enough for a desktop consent screen; on a phone the flow can hand off to the
// Discord app, ask for a password and a 2FA code, and come back well after
// that — and an expired state reads as "please try again" forever.
const OAUTH_STATE_TTL = 60 * 30;

async function indexSession(env, userId, token) {
  try {
    const key = 'usess:' + userId;
    const raw = await env.SESSIONS.get(key);
    let list = [];
    try { list = raw ? JSON.parse(raw) : []; } catch { list = []; }
    list.push(token);
    if (list.length > SESSION_INDEX_MAX) list = list.slice(-SESSION_INDEX_MAX);
    await env.SESSIONS.put(key, JSON.stringify(list), { expirationTtl: SESSION_TTL });
  } catch { /* an unindexed session is still a valid one; never fail a login */ }
}

// Drop every session this account has, optionally sparing the one making the
// request (so changing your own password does not log you out of the tab you
// changed it in).
async function revokeSessions(env, userId, keepToken) {
  try {
    const key = 'usess:' + userId;
    const raw = await env.SESSIONS.get(key);
    let list = [];
    try { list = raw ? JSON.parse(raw) : []; } catch { list = []; }
    for (const t of list) {
      if (keepToken && t === keepToken) continue;
      await env.SESSIONS.delete('sess:' + t).catch(() => {});
    }
    if (keepToken) await env.SESSIONS.put(key, JSON.stringify([keepToken]), { expirationTtl: SESSION_TTL });
    else await env.SESSIONS.delete(key).catch(() => {});
  } catch { /* best-effort: D1 re-checks bans on every write regardless */ }
}

async function createSession(env, userId, isAdmin) {
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  const session = JSON.stringify({ userId, isAdmin, created: Date.now() });
  // 30-day expiry
  await env.SESSIONS.put('sess:' + token, session, { expirationTtl: SESSION_TTL });
  await indexSession(env, userId, token);
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

// ---- the custom 404 page ----
// assetsOrNotFound() replaces a bare `env.ASSETS.fetch(request)`. A committed
// static file still wins (the legacy redirect stubs rely on that); only a 404
// from the assets binding swaps in /404.html, served AT the address that was
// asked for so the page can show it.
//
// Images, JSON and scripts keep the bare 404: an HTML page inside an <img> is
// waste, and fetch() callers want the status, not a document.
function wantsHTMLPage(request, path) {
  if (path.startsWith('/api/') || path.startsWith('/assets/')) return false;
  if (/\.(png|jpe?g|gif|webp|svg|ico|json|js|mjs|css|txt|xml|map|woff2?|ttf|otf)$/i.test(path)) return false;
  return (request.headers.get('Accept') || '').includes('text/html');
}

async function notFoundResponse(env, request, fallback) {
  const url = new URL(request.url);
  if (!wantsHTMLPage(request, url.pathname)) return fallback || new Response('Not found', { status: 404 });
  try {
    // A bare GET, deliberately: forwarding the caller's headers would carry
    // their If-None-Match along and could turn this into a 304 with no body.
    const page = await env.ASSETS.fetch(new Request(url.origin + '/404.html'));
    if (page.ok) {
      return new Response(await page.text(), {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }
  } catch { /* fall through to whatever the assets binding said */ }
  return fallback || new Response('Not found', { status: 404 });
}

// The drop-in replacement for `return env.ASSETS.fetch(request)` on any path
// that might not exist.
async function assetsOrNotFound(env, request) {
  const res = await env.ASSETS.fetch(request);
  if (res.status !== 404) return res;
  return notFoundResponse(env, request, res);
}

// ---- basic rate limiting (KV counter; best-effort) ----
// `opts.sess` switches the bucket from the caller's IP to their account. Use it
// for anything only a logged-in user can do: an IP bucket is the wrong shape
// there in both directions — one account rotating IPs is unlimited, while a
// school or a household behind one NAT punishes everybody on it. Signup, login
// and password reset stay on IP, because there is no account to key on yet.
//
// Still best-effort by design: KV is eventually consistent, so a tight
// concurrent burst can overshoot the limit. That is fine at these thresholds —
// the job is to stop a flood, not to be an exact quota.
async function rateLimited(env, request, bucket, limit, windowSec, opts = {}) {
  const identity = opts.sess && opts.sess.userId
    ? 'u' + opts.sess.userId
    : (request.headers.get('CF-Connecting-IP') || 'unknown');
  const key = `rl:${bucket}:${identity}`;
  const cur = parseInt((await env.SESSIONS.get(key)) || '0', 10);
  if (cur >= limit) return true;
  await env.SESSIONS.put(key, String(cur + 1), { expirationTtl: windowSec });
  return false;
}

// Every 429 the site sends should say when to come back; none of them did.
function tooManyResponse(message, retryAfterSec) {
  return jsonResponse({ error: message }, {
    status: 429,
    'Retry-After': String(retryAfterSec)
  });
}

// Per-account write limits. Generous enough that no real contributor will
// notice, but low enough that one script cannot fill R2 or the characters
// table overnight.
//
// The first numbers here (60 uploads, 40 characters an hour) were set by
// guessing at what a "big" import looks like, and the guess was far too small.
// A homebrew collection on this wiki is routinely 30–40 characters and the
// largest are 110–155, and mass-upload.html spends TWO uploads per character
// when the source JSON carries alt art. So a perfectly ordinary 30-character
// import used its whole upload allowance on the last row, and anything over 40
// characters died partway through with every remaining row going red. That is
// not a flood — that is the tool being used exactly as intended. Size these off
// the biggest real collection (~155 characters, ~310 uploads) with headroom, so
// one sitting imports one collection.
//
// The per-image cap (8 MB, and mass-upload re-encodes to 600 px first) is what
// actually bounds R2, not this counter.
const WRITE_LIMITS = {
  upload:     { bucket: 'upload',     limit: 400, window: 3600, msg: 'You have uploaded a lot of images in the last hour. Take a short break and try again.' },
  character:  { bucket: 'wchar',      limit: 200, window: 3600, msg: 'You have saved a lot of characters in the last hour. Take a short break and try again.' },
  collection: { bucket: 'wcoll',      limit: 40,  window: 3600, msg: 'You have saved a lot of collections in the last hour. Take a short break and try again.' },
  script:     { bucket: 'wscript',    limit: 40,  window: 3600, msg: 'You have saved a lot of scripts in the last hour. Take a short break and try again.' },
  wikipage:   { bucket: 'wpage',      limit: 40,  window: 3600, msg: 'You have saved a lot of pages in the last hour. Take a short break and try again.' },
  // Importing as drafts and then publishing them from the account page is one
  // workflow, so this has to clear the same bar the character limit does.
  publish:    { bucket: 'wpublish',   limit: 200, window: 3600, msg: 'You have published or deleted a lot of pages in the last hour. Take a short break and try again.' }
};

/* The permission half of /api/upload, on its own so more than one route can
   ask it. An image slot is named after the page it belongs to, so who may
   write to a key is a question about that page — and it has to be answered
   the same way whichever route the bytes arrived through. /api/bloodstar-art
   copies art straight from Bloodstar into R2 without it ever passing through
   the browser, and a second copy of these rules there would be a second copy
   to keep in step.
   Returns a Response to refuse with, or null when the upload may go ahead. */
async function uploadSlotDenied(env, sess, key) {
  if (sess.isAdmin) return null;
  /* Set when this upload is aimed at the image slot of a page this
     session may actually edit — its owner, or an approved editor the
     owner named. It switches off the catch-all "somebody else's file
     is already here" check further down, which is about slots with no
     page behind them: once the page has said yes, whoever uploaded the
     previous file is not a second opinion. Approved editing needs this
     or a shared character can never get its icon, which is the one
     thing that keeps it out of drafts. */
  let ownedSlot = false;
  // tokens/ is reserved for admin tooling; news/ for the news editor,
  // which is admin-only anyway.
  if (key.startsWith('tokens/') || key.startsWith('news/')) {
    return jsonResponse({ error: 'Not authorized for that upload path.' }, { status: 403 });
  }
  // Wiki-page images follow pages/{page-slug}-*.{ext}. If that page
  // exists, only its owner may put images in its slot.
  if (key.startsWith('pages/')) {
    await ensurePagesTable(env);
    const base = key.slice(6).replace(/\.[a-z0-9]+$/i, '');
    // Longest matching slug wins: "my-page-header.png" belongs to the
    // page "my-page", not to a page that happens to be called "my".
    const row = await env.DB.prepare(
      "SELECT slug, owner_id FROM pages WHERE slug=? OR ? LIKE slug || '-%' ORDER BY length(slug) DESC"
    ).bind(base, base).first().catch(() => null);
    if (row && !canEditRow(sess, row)) {
      return jsonResponse({ error: 'That image slot belongs to a page owned by another account.' }, { status: 403 });
    }
  }
  // Character art follows art/{slug}.png, with the second and third icons
  // (a traveller's good and evil tokens) at art/{slug}-alt.png and
  // art/{slug}-alt2.png. If that character exists, only its owner may
  // replace the art.
  if (key.startsWith('art/')) {
    const named = key.slice(4).replace(/\.[a-z0-9]+$/i, '');
    let slug = named;
    let row = await getEntityRow(env, 'character', slug);
    /* An -alt key names no row of its own, so the whole branch below used
       to be skipped for it: no ownership, no protection check, and only the
       "somebody else's file is here" catch-all left guarding it. That is
       why an approved editor — or an owner assigned through the dashboard,
       whose R2 objects still carry the importing admin's `owner` — could
       replace a character's main art and got a 403 on its alternates.
       Fall back to the base identity, but ONLY when the key named no row:
       a character genuinely called "Foo Alt" has the identity `foo-alt`
       and matches on the first lookup, so it keeps its own permissions.
       A single hardcoded suffix, never the longest-prefix match `pages/`
       uses — character art is uploaded BEFORE the row exists, so a prefix
       rule would refuse every new character whose name merely starts with
       an existing one's ("Scarlet Woman" blocked by "Scarlet"). */
    if (!row && /-alt2?$/.test(named)) {
      slug = named.replace(/-alt2?$/, '');
      row = await getEntityRow(env, 'character', slug);
    }
    if (row && await canEditPage(env, sess, 'character', row)) ownedSlot = true;
    else if (row && !canEditRow(sess, row)) {
      // Almost always a name clash on a brand-new character: the art
      // slot is named after the character's identity, which is derived
      // from its name, and that one is already someone else's page.
      // Say so, so the fix (a different name) is obvious.
      return jsonResponse({ error: 'The art slot for "' + slug + '"' + (slug === named ? '' : ' (its alternate art)') + ' already belongs to a character on another account. Give your character a different name and save again.' }, { status: 403 });
    }
    if (row && await isProtected(env, 'character', row.slug)) {
      return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
    }
  }
  // Script images follow scripts/{slug}[-logo|-bg].{ext}; collection
  // images collections/{id}[-logo|-bg].{ext}. If that page exists,
  // only its owner may replace its images.
  if (key.startsWith('scripts/')) {
    const base = key.slice(8).replace(/\.[a-z0-9]+$/i, '').replace(/-(logo|bg)$/, '');
    const row = await getEntityRow(env, 'script', base);
    if (row && await canEditPage(env, sess, 'script', row)) ownedSlot = true;
    else if (row && !canEditRow(sess, row)) {
      return jsonResponse({ error: 'That image slot belongs to a script owned by another account.' }, { status: 403 });
    }
    if (row && await isProtected(env, 'script', row.slug)) {
      return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
    }
  }
  if (key.startsWith('collections/')) {
    const base = key.slice(12).replace(/\.[a-z0-9]+$/i, '').replace(/-(logo|bg)$/, '');
    const row = await findCollectionRow(env, base);
    if (row && await canEditPage(env, sess, 'collection', row)) ownedSlot = true;
    else if (row && !canEditRow(sess, row)) {
      return jsonResponse({ error: 'That image slot belongs to a collection owned by another account.' }, { status: 403 });
    }
    if (row && await isProtected(env, 'collection', row.slug)) {
      return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
    }
  }
  // Never allow silently replacing someone else's uploaded file —
  // unless the page that owns this slot has already said yes above.
  const existing = ownedSlot ? null : await env.ART.head(key).catch(() => null);
  if (existing) {
    const owner = existing.customMetadata && existing.customMetadata.owner;
    if (owner !== String(sess.userId)) {
      return jsonResponse({ error: 'A file already exists at that path and belongs to another account.' }, { status: 403 });
    }
  }
  return null;
}

// Admins are exempt: they run the bulk tools, and locking an admin out mid
// cleanup is worse than the flood the limit is guarding against.
async function writeLimited(env, request, sess, kind) {
  if (!sess || sess.isAdmin) return null;
  const r = WRITE_LIMITS[kind];
  if (!r) return null;
  if (await rateLimited(env, request, r.bucket, r.limit, r.window, { sess })) {
    return tooManyResponse(r.msg, r.window);
  }
  return null;
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

// ---- accented Latin letters -> their plain letters ----
// A fada (á é í ó ú) is a LETTER, not decoration: "Tir-far-thóinn" has to fold
// to "tir-far-thoinn", never to "tir-far-th-inn". Every slug helper in this
// file already does this; the account code was the one place that skipped it
// and dropped the letter on the floor.
//
// NFD splits an accented letter into its base letter plus a combining mark, so
// deleting the marks keeps the letter — that covers the fadas, and every other
// accent, umlaut, tilde, cedilla and ring with them. The few below have no
// decomposition at all (NFD leaves them whole), so they have to be named.
const LATIN_EXTRAS = {
  'ø': 'o', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ł': 'l', 'ħ': 'h',
  'ı': 'i', 'ŧ': 't', 'ŋ': 'n', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'ẞ': 'ss'
};
function foldLatin(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[øđðþłħıŧŋæœßẞ]/gi, ch => {
      const out = LATIN_EXTRAS[ch.toLowerCase()] || LATIN_EXTRAS[ch] || ch;
      // Keep the case that was typed: Ø -> O, Æ -> Ae.
      return ch === ch.toLowerCase() ? out : out.charAt(0).toUpperCase() + out.slice(1);
    });
}
// ---- usernames ----
// A username is spelled with the letters the person's name is spelled with:
// "Tir-far-thóinn" keeps its fada, and so does @tir-far-thóinn. The account
// code used to be ASCII-only, which turned the ó into a hyphen and produced
// @tir-far-th-inn. Letting the letters through takes two things that SQL
// cannot do for us:
//
//   1. NORMALISATION. "ó" is either one code point (U+00F3) or "o" plus a
//      combining accent (U+0301) — identical on screen, different strings, and
//      Apple keyboards hand over the second form. Stored names go through NFC
//      so one spelling is one account.
//   2. CASE AND CONFUSABILITY. D1's SQLite has no ICU, so lower() folds ASCII
//      and nothing else: lower('Ó') is 'Ó'. Comparing handles in SQL would let
//      "Tir-far-thÓinn" and "tir-far-thóinn" be two accounts with one name.
//
// So identity is a JS-computed key, stored in users.username_key: accents
// folded away, then lower-cased. It is the UNIQUE column and the one every
// lookup matches on, while users.username keeps the spelling that gets shown.
// Folding it into the key does three jobs at once — the case fold SQLite
// cannot do, "type it with or without the accent and you still find the
// account", and a block on registering the near-identical @tir-far-thoinn
// next to @tir-far-thóinn.
function normUsername(s) {
  return String(s == null ? '' : s).normalize('NFC').trim();
}
function usernameKey(s) {
  return foldLatin(s).normalize('NFC').trim().toLowerCase();
}

// ---- validation ----
// Letters (any script), numbers, hyphen, underscore; 3–20; not starting with a
// separator. \p{M} rides along for the scripts whose marks NFC does not
// compose away.
const USERNAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}_-]{2,19}$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// One name, one script. A fada is somebody's name; a lone Cyrillic "е" inside
// an otherwise Latin handle is somebody else's name being borrowed, and the
// key above cannot fold what it cannot recognise as the same letter. A wholly
// Greek or wholly Han username is fine — it is the mixture that is a costume.
function mixesScripts(name) {
  const s = String(name || '');
  if (!/\p{Script=Latin}/u.test(s)) return false;
  return /[\p{L}\p{M}]/u.test(
    s.replace(/[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/gu, '')
  );
}

function validSignup(username, email, password) {
  if (!USERNAME_RE.test(username || '')) {
    return 'Username must be 3–20 characters: letters (accents welcome), numbers, hyphens or underscores.';
  }
  if (mixesScripts(username)) {
    return 'Username mixes letters from two different alphabets. Please use one alphabet.';
  }
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return 'Please enter a valid email address.';
  }
  if (!password || password.length < 8 || password.length > 200) {
    return 'Password must be at least 8 characters.';
  }
  return null;
}

// users.username_key: added lazily, like users.banned and users.profile_json —
// no manual migrations, ever. The backfill runs usernameKey() in JS over the
// unkeyed rows rather than leaning on SQLite's lower(): lower() is right only
// for ASCII handles, and the whole point of this column is that handles are no
// longer ASCII. The users table is small and this runs once per fresh column.
let _unameKeyReady = false;
async function ensureUsernameKey(env) {
  if (_unameKeyReady) return true;
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN username_key TEXT').run(); }
  catch { /* already there */ }
  try {
    const { results } = await env.DB.prepare(
      'SELECT id, username FROM users WHERE username_key IS NULL'
    ).all();
    for (const r of results || []) {
      // Per row: a key that collides with one already in the table would throw
      // against the UNIQUE index below, and one unkeyable row must not leave
      // the rest of the table unkeyed.
      await env.DB.prepare('UPDATE users SET username_key=? WHERE id=?')
        .bind(usernameKey(r.username), r.id).run().catch(() => {});
    }
    // UNIQUE is the real guard against two signups racing onto one key. It can
    // only fail if live data already holds a collision, which is why it comes
    // last: the lookups above work either way, they just lose the race guard.
    await env.DB.prepare(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_key ON users(username_key)'
    ).run().catch(() => {});
    _unameKeyReady = true;
  } catch { /* try again on the next request rather than 500 this one */ }
  return _unameKeyReady;
}

// The one way to turn a typed handle into a row. `cols` is always an internal
// literal, never anything a caller sent. If the key column could not be added
// this degrades to the old ASCII comparison instead of failing every login.
async function selectUserByName(env, cols, name, extraWhere) {
  const ready = await ensureUsernameKey(env);
  const where = ready ? 'username_key = ?1' : 'lower(username) = lower(?1)';
  const sql = `SELECT ${cols} FROM users WHERE ${where}${extraWhere ? ' ' + extraWhere : ''}`;
  return env.DB.prepare(sql).bind(ready ? usernameKey(name) : normUsername(name))
    .first().catch(() => null);
}

async function findUserByLogin(env, identifier) {
  const id = normUsername(identifier);
  if (!id) return null;
  // Handle first, then email. Two queries where there used to be one, because
  // the handle is now matched on the folded key and the email is not.
  const byName = await selectUserByName(env, '*', id);
  if (byName) return byName;
  const byEmail = await env.DB.prepare(
    'SELECT * FROM users WHERE email IS NOT NULL AND lower(email) = lower(?)'
  ).bind(id).first().catch(() => null);
  if (byEmail) return byEmail;
  // Last: the name the SITE shows them. See findUserByShownName below.
  return findUserByShownName(env, id);
}

// A Discord signup is shown its display name everywhere (@scape on the account
// page, "Cellscape" on every comment), so that is the name people type to log
// in. Display name and Discord handle both work here.
//
// The order in findUserByLogin above is the safety argument: username, then
// email, then this. A display name can never shadow somebody's handle or
// email, and it only counts when EXACTLY ONE account has it, so two members
// called "Alex" match neither. The password check still applies.
async function findUserByShownName(env, id) {
  const key = usernameKey(id);
  if (!key) return null;
  // Matched in JS, folded exactly as a handle is: SQLite has no ICU, so
  // lower() would fold "Cellscape" and leave "Céline" alone. Only runs when
  // nothing else matched, over a table of tens of rows.
  const { results } = await env.DB.prepare(
    `SELECT id, display_name, discord_username FROM users
      WHERE (display_name IS NOT NULL AND display_name <> '')
         OR (discord_username IS NOT NULL AND discord_username <> '')`
  ).all().catch(() => ({ results: [] }));
  const hits = new Set();
  for (const r of results || []) {
    if (usernameKey(r.display_name) === key || usernameKey(r.discord_username) === key) hits.add(r.id);
  }
  if (hits.size !== 1) return null;
  return env.DB.prepare('SELECT * FROM users WHERE id=?')
    .bind([...hits][0]).first().catch(() => null);
}

// Is this handle taken — or close enough to an existing one to read as it?
// Both questions are the same question once the key has the accents folded out
// of it, which is the point of keying it that way.
async function usernameTaken(env, name) {
  return !!(await selectUserByName(env, 'id', name));
}

// ---- wiki lock (global freeze flag, stored in D1 settings) ----
async function isWikiLocked(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key='wiki_locked'").first();
    return !!row && row.value === '1';
  } catch { return false; }
}

// Actions that change what /characters.json, /collections.json and
// /scripts.json would return. Hanging the feed-cache bump off logActivity
// rather than off ~18 individual write handlers means a new content action
// gets correct cache invalidation for free, just by logging itself like
// everything else does. Comment/DM/report/login actions are absent on purpose:
// they never appear in a feed, so bumping for them would throw away a
// perfectly good cache every time somebody posted a comment.
const FEED_CHANGING_ACTIONS = new Set([
  'create', 'update', 'delete', 'rename', 'publish', 'unpublish',
  'curata', 'uncurata', 'rollback', 'restore', 'restore-backup',
  'assign-owner', 'protect', 'unprotect', 'purge',
  // Approving a suggestion writes the page; 'suggest' itself changes nothing.
  'suggestion-approve'
]);

// ---- activity log helper ----
async function logActivity(env, sess, action, entityType, slug, name) {
  // Bulk actions arrive as 'bulk-publish', 'bulk-delete', ...
  if (FEED_CHANGING_ACTIONS.has(action) || String(action || '').startsWith('bulk-')) {
    await bumpContentVersion(env);
  }
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

// ---- page revisions (version history for rollback) ----
// The table is created lazily by the Worker itself, so no manual D1
// migration is ever needed. Every content save snapshots the version it is
// about to replace; the newest 20 revisions per page are kept.
// Deep enough that a page opened to public editing keeps a usable trail, not
// just the last handful of saves.
const REVISIONS_KEEP = 50;
let _revisionsReady = false;
async function ensureRevisionsTable(env) {
  if (_revisionsReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS revisions (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       entity_type TEXT NOT NULL,
       slug        TEXT NOT NULL,
       name        TEXT,
       status      TEXT,
       data        TEXT NOT NULL,
       edited_by   TEXT,
       ts          TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_revisions_entity ON revisions(entity_type, slug, id)'
  ).run();
  _revisionsReady = true;
}

/* The "what changed" column of a wiki history. Compares the top-level keys of
   two stored versions, which is the granularity a page is edited at. An
   unlabelled key falls back to its own name rather than being dropped, so a
   field added later still shows as changed instead of reading as no change. */
const FIELD_LABELS = {
  name: 'name', team: 'team', creator: 'creator', ability: 'ability',
  tags: 'tags', lede: 'flavour line', quote: 'flavour quote',
  summaryBullets: 'summary', howToRun: 'how to run', examples: 'examples',
  tips: 'tips', bluffing: 'bluffing notes', fighting: 'fighting notes',
  callout: 'how-to-run note', art: 'icon', image: 'icon', imageAlt: 'alternate art',
  artAlt: 'alternate art', imageAlt2: 'evil art', artAlt2: 'evil art',
  jinxes: 'jinxes', reminders: 'reminders',
  remindersGlobal: 'global reminders', firstNight: 'first-night order',
  otherNight: 'other-nights order', firstNightReminder: 'first-night reminder',
  otherNightReminder: 'other-nights reminder', setup: 'setup flag',
  special: 'special properties', customBoxes: 'side boxes', customJson: 'custom JSON',
  appearsIn: 'appears in', pronunciation: 'pronunciation', ipa: 'IPA',
  respelling: 'respelling', translatedBy: 'translator', iconBy: 'icon credit',
  edition: 'edition', publicEdit: 'who may edit',
  // scripts + collections
  displayName: 'name', author: 'author', description: 'description',
  tagline: 'tagline', version: 'version', difficulty: 'difficulty',
  synopsis: 'synopsis', gameplay: 'gameplay', strategyGood: 'good strategy',
  strategyEvil: 'evil strategy', characters: 'roster', logo: 'logo',
  header: 'header image', theme: 'appearance', match: 'membership rules',
  include: 'members added', exclude: 'members removed', order: 'roster order',
  nightOrder: 'night order', jinxEdits: 'script jinxes', bootlegger: 'house rules',
  almanac: 'almanac link', hideTitle: 'app title setting',
  // wiki pages
  title: 'title', subtitle: 'subtitle', blurb: 'blurb', body: 'page text',
  images: 'images', boxes: 'side boxes', infobox: 'fact box', toc: 'contents box'
};
const DIFF_VALUE_MAX = 1200;   // per side, per field
const DIFF_LABEL_MAX = 6;

/* diffFieldLabels with the values kept, so a reader can judge the edit.
   Flattened to text: a list becomes one line per entry, anything else its
   JSON, both capped. */
function diffFieldValues(beforeJSON, afterJSON) {
  let a, b;
  try { a = JSON.parse(beforeJSON) || {}; } catch { a = {}; }
  try { b = JSON.parse(afterJSON) || {}; } catch { b = {}; }
  const flat = v => {
    if (v == null) return '';
    if (typeof v === 'string') return v.slice(0, DIFF_VALUE_MAX);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v) && v.every(x => typeof x === 'string')) {
      return v.join('\n').slice(0, DIFF_VALUE_MAX);
    }
    try { return JSON.stringify(v, null, 1).slice(0, DIFF_VALUE_MAX); } catch { return ''; }
  };
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of keys) {
    if (k === 'slug' || k === 'page' || k === 'id') continue;
    const x = a[k] === undefined ? null : a[k];
    const y = b[k] === undefined ? null : b[k];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    out.push({ field: k, label: FIELD_LABELS[k] || k, before: flat(x), after: flat(y) });
  }
  out.sort((p, q) => p.label.localeCompare(q.label));
  return out.slice(0, 40);
}
function diffFieldLabels(beforeJSON, afterJSON) {
  let a, b;
  try { a = JSON.parse(beforeJSON) || {}; } catch { a = {}; }
  try { b = JSON.parse(afterJSON) || {}; } catch { b = {}; }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of keys) {
    if (k === 'slug' || k === 'page' || k === 'id') continue;
    const x = a[k] === undefined ? null : a[k];
    const y = b[k] === undefined ? null : b[k];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    out.push(FIELD_LABELS[k] || k);
  }
  out.sort();
  if (out.length > DIFF_LABEL_MAX) {
    const extra = out.length - DIFF_LABEL_MAX;
    return out.slice(0, DIFF_LABEL_MAX).concat(['and ' + extra + ' more']);
  }
  return out;
}

// Snapshot an existing row before it gets overwritten. `edited_by` records
// who made the edit that replaced this version. Never blocks the save.
async function saveRevision(env, sess, type, row) {
  // Drafts have no history: they are saved over constantly while being
  // written and nobody wants those versions back, so a page's history starts
  // at the version that was published. What is snapshotted is the version
  // being REPLACED, so taking a published page to draft still records it.
  if ((row.status || 'published') !== 'published') return;
  try {
    await ensureRevisionsTable(env);
    let by = null;
    try {
      const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
      by = u ? u.username : null;
    } catch { /* non-fatal */ }
    await env.DB.prepare(
      'INSERT INTO revisions (entity_type, slug, name, status, data, edited_by) VALUES (?,?,?,?,?,?)'
    ).bind(type, row.slug, row.name || null, row.status || 'published', row.data, by).run();
    await env.DB.prepare(
      `DELETE FROM revisions WHERE entity_type=? AND slug=? AND id NOT IN (
         SELECT id FROM revisions WHERE entity_type=? AND slug=? ORDER BY id DESC LIMIT ${REVISIONS_KEEP})`
    ).bind(type, row.slug, type, row.slug).run();
  } catch { /* history must never break a write */ }
}

/* ---- suggested edits ----
   A page set to `publicEdit: 'suggest'` takes proposed versions instead of
   direct edits. A suggestion is the whole page as the suggester would have it,
   the same object the editor posts to save, kept apart from the row until the
   owner approves it. Approving is a normal save, snapshotted into the history
   first, so it can be rolled back like anything else.

   `base_updated_at` is the version the suggester worked from, so the review
   page can flag one written against an older copy. */
let _suggestReady = false;
async function ensureSuggestTable(env) {
  if (_suggestReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS suggestions (
       id              INTEGER PRIMARY KEY AUTOINCREMENT,
       entity_type     TEXT NOT NULL,
       slug            TEXT NOT NULL,
       user_id         INTEGER,
       username        TEXT,
       note            TEXT,
       data            TEXT NOT NULL,
       base_updated_at TEXT,
       status          TEXT NOT NULL DEFAULT 'open',
       reply           TEXT,
       decided_by      TEXT,
       decided_at      TEXT,
       ts              TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_suggestions_page ON suggestions(entity_type, slug, status)'
  ).run();
  _suggestReady = true;
}

const SUGGEST_MAX_OPEN_PER_PAGE = 50;   // per suggester, per page: a queue, not a firehose
const SUGGEST_NOTE_MAX = 600;

// ---- more lazily-created tables/columns (no manual migrations ever) ----
let _viewsReady = false;
async function ensureViewsTable(env) {
  if (_viewsReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS page_views (
       entity_type TEXT NOT NULL,
       slug        TEXT NOT NULL,
       day         TEXT NOT NULL,
       n           INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (entity_type, slug, day)
     )`
  ).run();
  _viewsReady = true;
}

let _messagesReady = false;
async function ensureMessagesTable(env) {
  if (_messagesReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS messages (
       id       INTEGER PRIMARY KEY AUTOINCREMENT,
       ts       TEXT NOT NULL DEFAULT (datetime('now')),
       user_id  INTEGER,
       username TEXT,
       category TEXT,
       body     TEXT NOT NULL,
       status   TEXT NOT NULL DEFAULT 'open'
     )`
  ).run();
  // An admin's answer to a contact message is DELIVERED as a direct message —
  // that is the channel the site already has, with an unread count and the
  // mail flag on "My Account", and it lets the person write back. These three
  // columns are only the dashboard's record that it happened, so an admin can
  // see at a glance which messages have been answered and what was said
  // without opening the thread. Lazily ALTERed, like every other column added
  // after the fact (see users.banned).
  for (const col of ['last_reply TEXT', 'replied_at TEXT', 'replied_by TEXT']) {
    try { await env.DB.prepare('ALTER TABLE messages ADD COLUMN ' + col).run(); }
    catch { /* already there */ }
  }
  _messagesReady = true;
}

// ---- direct messages (user <-> user DMs, tables created lazily) ----
// `dms` is one row per message; a "conversation" is just every row between a
// pair of users. Each side can hide a conversation for themselves only
// (sender_deleted / recipient_deleted); rows hidden by BOTH sides are purged.
// `dm_blocks` stores per-user block lists (admins bypass blocks so the
// admin <-> user channel always works).
let _dmReady = false;
async function ensureDmTables(env) {
  if (_dmReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS dms (
       id                INTEGER PRIMARY KEY AUTOINCREMENT,
       ts                TEXT NOT NULL DEFAULT (datetime('now')),
       sender_id         INTEGER NOT NULL,
       recipient_id      INTEGER NOT NULL,
       body              TEXT NOT NULL,
       read_at           TEXT,
       sender_deleted    INTEGER NOT NULL DEFAULT 0,
       recipient_deleted INTEGER NOT NULL DEFAULT 0
     )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_dms_recipient ON dms(recipient_id, id)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_dms_sender ON dms(sender_id, id)').run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS dm_blocks (
       user_id    INTEGER NOT NULL,
       blocked_id INTEGER NOT NULL,
       ts         TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY (user_id, blocked_id)
     )`
  ).run();
  // A report unlocks that one conversation for admin review — admins can
  // never read DMs that nobody reported.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS dm_reports (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       ts          TEXT NOT NULL DEFAULT (datetime('now')),
       reporter_id INTEGER NOT NULL,
       reported_id INTEGER NOT NULL,
       reason      TEXT,
       status      TEXT NOT NULL DEFAULT 'open'
     )`
  ).run();
  // dm_reports is created here, so schema.sql cannot index it. It had none,
  // and the admin DM queue filters on exactly this column.
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_dm_reports_status ON dm_reports(status)"
  ).run();
  _dmReady = true;
}

// ---- comments (character / collection / script / news pages) ----
// One flat thread per page — no nesting, which keeps the mobile layout
// readable and the moderation model simple. Removing a comment sets
// status='removed' rather than deleting the row, so an admin can undo a
// mistaken removal from the dashboard.
const COMMENT_MAX = 2000;
// Bumping this re-prompts everyone with the "be respectful" agreement.
const COMMENT_TERMS_VERSION = '1';
let _commentsReady = false;
async function ensureCommentTables(env) {
  if (_commentsReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS comments (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       ts          TEXT NOT NULL DEFAULT (datetime('now')),
       entity_type TEXT NOT NULL,
       slug        TEXT NOT NULL,
       user_id     INTEGER NOT NULL,
       body        TEXT NOT NULL,
       status      TEXT NOT NULL DEFAULT 'visible',
       removed_by  TEXT,
       removed_at  TEXT
     )`
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_comments_page ON comments(entity_type, slug, id)'
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS comment_reports (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       ts          TEXT NOT NULL DEFAULT (datetime('now')),
       comment_id  INTEGER NOT NULL,
       reporter_id INTEGER NOT NULL,
       reason      TEXT,
       status      TEXT NOT NULL DEFAULT 'open'
     )`
  ).run();
  // These two belong here rather than in migration/schema.sql: both tables are
  // created lazily by this function, so schema.sql cannot index them — it does
  // not create them and the script would fail on a fresh database.
  // comment_reports had no indexes at all, and it is exactly what the
  // moderation queue reads under load.
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_comment_reports_st ON comment_reports(status, comment_id)"
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_comments_status_id ON comments(status, id DESC)'
  ).run();
  // Which version of the comment terms this account has agreed to.
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN comment_terms TEXT').run(); }
  catch { /* already there */ }
  // Threading + pinning, added after the table shipped flat — lazily ALTERed
  // like users.banned so there is still nothing to migrate by hand.
  // parent_id is NULL for a top-level comment and never points at another
  // reply: threads are exactly one level deep (see the flattening in
  // POST /api/comments), which keeps them readable on a phone.
  try { await env.DB.prepare('ALTER TABLE comments ADD COLUMN parent_id INTEGER').run(); }
  catch { /* already there */ }
  try { await env.DB.prepare('ALTER TABLE comments ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0').run(); }
  catch { /* already there */ }
  _commentsReady = true;
}

// Removing a top-level comment has to take its replies with it, or the page
// shows answers to a question nobody can see. The replies get status
// 'hidden' rather than 'removed' so restoring the parent brings back exactly
// those, and never a reply an admin removed on its own merits.
async function removeCommentCascade(env, row, by) {
  await env.DB.prepare(
    "UPDATE comments SET status='removed', pinned=0, removed_by=?, removed_at=datetime('now') WHERE id=?"
  ).bind(by, row.id).run();
  if (!row.parent_id) {
    await env.DB.prepare(
      "UPDATE comments SET status='hidden' WHERE parent_id=? AND status='visible'"
    ).bind(row.id).run();
  }
}
async function restoreCommentCascade(env, row) {
  await env.DB.prepare(
    "UPDATE comments SET status='visible', removed_by=NULL, removed_at=NULL WHERE id=?"
  ).bind(row.id).run();
  if (!row.parent_id) {
    await env.DB.prepare(
      "UPDATE comments SET status='visible' WHERE parent_id=? AND status='hidden'"
    ).bind(row.id).run();
  }
}

// ---- news articles (admin-written, /news + /news/{slug}) ----
// Same hybrid shape as the content tables: a few indexed columns plus the
// whole article as JSON in `data`, so new article fields never need a
// migration. Created lazily on first use like revisions/dms.
let _newsReady = false;
async function ensureNewsTable(env) {
  if (_newsReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS news (
       slug         TEXT PRIMARY KEY,
       title        TEXT NOT NULL,
       owner_id     INTEGER,
       data         TEXT NOT NULL,
       status       TEXT NOT NULL DEFAULT 'draft',
       created_at   TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
       published_at TEXT
     )`
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_news_status ON news(status, published_at)'
  ).run();
  _newsReady = true;
}

// ---- system text overrides (the /text-editor admin page) ----
// Rewritten wording for the site's own copy — the strings baked into the HTML
// pages, assets/*.js and assets/system-text.js, NOT anything anyone wrote in
// an editor. Only the strings that were actually changed are stored, so this
// table is normally tiny (and usually empty). `original` is matched against
// the page text in the browser, so it holds exactly what the source file
// holds; `scope` is '*' for site-wide or a page path like '/tools'.
const SITE_TEXT_MAX = 4000;      // per string, original and replacement alike
const SITE_TEXT_ROWS = 2000;     // a ceiling on how many overrides can exist
let _siteTextReady = false;
async function ensureSiteTextTable(env) {
  if (_siteTextReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS site_text (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       scope       TEXT NOT NULL DEFAULT '*',
       source      TEXT,
       original    TEXT NOT NULL,
       replacement TEXT NOT NULL,
       updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
       updated_by  TEXT
     )`
  ).run();
  await env.DB.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_site_text_key ON site_text(scope, original)'
  ).run();
  _siteTextReady = true;
}

// The public map. Every page on the site asks for this, so it is held in
// memory to absorb bursts — but only for a few seconds. A save clears the
// cache in the isolate that handled it and NOT in any other, so this window
// is exactly how long an edit can take to reach a reader. Keep it short: the
// whole point of the text editor is that a change shows up straight away, and
// the read behind it is one indexed query against a table with a handful of
// rows in it.
const SITE_TEXT_CACHE_MS = 5000;
let _siteTextCache = null;
async function siteTextItems(env) {
  if (_siteTextCache && (Date.now() - _siteTextCache.at) < SITE_TEXT_CACHE_MS) return _siteTextCache.items;
  let items = [];
  try {
    await ensureSiteTextTable(env);
    const rows = await env.DB.prepare(
      'SELECT scope, original, replacement FROM site_text ORDER BY length(original) DESC'
    ).all();
    items = (rows.results || []).map(r => ({ o: r.original, r: r.replacement, s: r.scope || '*' }));
  } catch { items = []; }
  _siteTextCache = { at: Date.now(), items };
  return items;
}

// ---- custom wiki pages (text-first pages hanging off a script/collection) ----
// A page belongs to exactly one script or collection and is reachable ONLY
// from that parent page and from its author's page — never from search, the
// homepage, the browse lists or the sitemap. Same hybrid shape as everything
// else: indexed columns for the lookups plus the whole page as JSON in `data`.
let _pagesReady = false;
async function ensurePagesTable(env) {
  if (_pagesReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS pages (
       slug        TEXT PRIMARY KEY,
       title       TEXT NOT NULL,
       parent_type TEXT NOT NULL,
       parent_slug TEXT NOT NULL,
       author      TEXT,
       owner_id    INTEGER,
       data        TEXT NOT NULL,
       status      TEXT NOT NULL DEFAULT 'draft',
       created_at  TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_type, parent_slug, status)'
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_pages_owner ON pages(owner_id)'
  ).run();
  _pagesReady = true;
}

// The parent script/collection row a wiki page hangs off, resolved the same
// way the SSR routes resolve it (collections may be addressed by kebab id).
async function wikiParentRow(env, type, key) {
  if (type === 'collection') {
    const row = await findCollectionRow(env, key);
    if (!row) return null;
    const d = parseData(row);
    return { type, slug: row.slug, key: d.id || row.slug, name: row.name || d.displayName || row.slug, ownerId: row.owner_id, status: row.status };
  }
  if (type !== 'script') return null;
  const row = await getEntityRow(env, 'script', key);
  if (!row) return null;
  return { type, slug: row.slug, key: row.slug, name: row.name || row.slug, ownerId: row.owner_id, status: row.status };
}

// Name -> slug map so [[Snake Charmer]] in page text becomes a real link.
// Only the indexed columns are read, so this stays cheap even at 1000 rows.
// [[Character Name]] -> the path segment render-wiki builds `c/{value}` from,
// so the value is the ADDRESS. Both the identity and the name are keys, so a
// writer can type either and still get a link.
async function loadCharLinks(env) {
  const map = {};
  try {
    await ensureUrlSlugColumn(env);
    const { results } = await env.DB.prepare(
      "SELECT slug, url_slug, name FROM characters WHERE status='published'"
    ).all();
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    for (const r of results || []) {
      const addr = charAddress(r);
      if (r.slug) map[norm(r.slug)] = addr;
      if (r.name) map[norm(r.name)] = addr;
    }
  } catch { /* links just fall back to token pills */ }
  return map;
}

// Custom side boxes — the {title, content} widget shared by character,
// script, collection, wiki and news pages. Text only; the renderer escapes it.
const BOX_MAX = 24;
function sanitizeBoxes(boxes) {
  if (!Array.isArray(boxes)) return [];
  return boxes.slice(0, BOX_MAX).map(b => ({
    title: String((b && b.title) || '').slice(0, 120),
    content: String((b && b.content) || '').slice(0, 4000)
  })).filter(b => b.title.trim() || b.content.trim());
}

// Jinxes on a character. Everything else a user can post arrives sanitized;
// this one used to be stored verbatim, so a malformed blob could sit in the
// row forever. Keep the five fields the renderer reads, cap them, and drop
// anything that names nobody. `mirrored`/`mirroredFrom` are deliberately NOT
// kept: those are added on read, and a client must never be able to fake one.
const JINX_MAX = 60;
function sanitizeJinxes(jinxes) {
  if (!Array.isArray(jinxes)) return [];
  return jinxes.slice(0, JINX_MAX).map(j => {
    const o = {
      name: String((j && j.name) || '').slice(0, 120).trim(),
      align: (j && j.align) === 'evil' ? 'evil' : 'good',
      text: String((j && (j.text || j.reason)) || '').slice(0, 2000)
    };
    // `slug` points at a page on this wiki, `id` at an official character.
    const slug = String((j && j.slug) || '');
    if (/^[a-z0-9-]{1,80}$/.test(slug)) o.slug = slug;
    const id = String((j && j.id) || '');
    if (/^[a-z0-9_-]{1,80}$/.test(id)) o.id = id;
    return o;
  }).filter(j => j.name || j.slug || j.id);
}

// The fact box on a wiki page / news article: a title, an image and rows.
function sanitizeInfobox(info) {
  if (!info || typeof info !== 'object') return null;
  const out = {
    title: String(info.title || '').slice(0, 80),
    image: typeof info.image === 'string' ? info.image.slice(0, 300) : '',
    rows: Array.isArray(info.rows)
      ? info.rows.slice(0, 20).map(r => ({
          label: String((r && r.label) || '').slice(0, 60),
          value: String((r && r.value) || '').slice(0, 300)
        })).filter(r => r.label.trim() || r.value.trim())
      : []
  };
  if (out.image && !WikiRender.safeImg(out.image, '')) out.image = '';
  if (!out.title && !out.image && !out.rows.length) return null;
  return out;
}

// Pages a parent script/collection carries. Drafts are only ever included
// for someone allowed to see them (the owner, or an admin).
async function listWikiPages(env, parentType, parentSlug, opts = {}) {
  await ensurePagesTable(env);
  const where = opts.includeDrafts
    ? "status IN ('published','draft')"
    : "status='published'";
  const { results } = await env.DB.prepare(
    `SELECT slug, title, status, author, data, updated_at FROM pages
     WHERE parent_type=? AND parent_slug=? AND ${where}
     ORDER BY status='draft', created_at`
  ).bind(parentType, parentSlug).all().catch(() => ({ results: [] }));
  return (results || []).map(r => {
    const d = parseData(r);
    return {
      slug: r.slug, title: r.title, status: r.status,
      author: r.author || d.author || null,
      blurb: d.blurb || WikiRender.autoSummary(d.body, 140),
      updatedAt: r.updated_at
    };
  });
}

// Find the page a comment is aimed at and work out who may moderate it.
// Returns null when the page doesn't exist or isn't publicly visible.
async function commentTarget(env, type, slug) {
  if (!COMMENTABLE.includes(type) || !slug) return null;
  if (type === 'wikipage') {
    await ensurePagesTable(env);
    const row = await env.DB.prepare('SELECT slug, title AS name, status, owner_id, data FROM pages WHERE slug=?')
      .bind(slug).first().catch(() => null);
    if (!row || row.status !== 'published') return null;
    if (parseData(row).comments === false) return null;
    return { slug: row.slug, name: row.name, ownerId: row.owner_id, type, path: '/p/' + row.slug };
  }
  if (type === 'news') {
    await ensureNewsTable(env);
    const row = await env.DB.prepare('SELECT slug, title AS name, status, owner_id FROM news WHERE slug=?')
      .bind(slug).first().catch(() => null);
    if (!row || row.status !== 'published') return null;
    return { slug: row.slug, name: row.name, ownerId: row.owner_id, type, path: '/news/' + row.slug };
  }
  let row = await getEntityRow(env, type, slug);
  if (!row && type === 'collection') row = await findCollectionRow(env, slug);
  if (!row || row.status !== 'published') return null;
  // Collection URLs use the kebab id from the JSON, never the PK slug —
  // legacy rows have display-string slugs like "The Academy".
  const path = type === 'character' ? '/c/' + charAddress(row)
    : type === 'script' ? '/s/' + row.slug
    : '/collection/' + (parseData(row).id || row.slug);
  return { slug: row.slug, name: row.name, ownerId: row.owner_id, type, path };
}

// ---- comment notifications ----
// Someone commenting on your page (or answering your comment) lands in your
// message inbox, so it rides the notification the site already has: the unread
// count on /api/me and the mail flag site.js puts on "My Account".
//
// The row is a real DM from the commenter, so you can just reply to them — but
// it is inserted with sender_deleted=1, which keeps it out of the COMMENTER's
// own conversation list. They wrote a comment, not a message, and shouldn't
// see one in their sent mail.
async function notifyComment(env, opts) {
  // opts: {fromId, target, body, origin, parentAuthorId}
  try {
    const { fromId, target, body, origin } = opts;
    const seen = new Set([fromId]);
    const to = [];
    // The page's owner, and whoever wrote the comment being answered.
    for (const id of [target.ownerId, opts.parentAuthorId]) {
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      to.push(id);
    }
    if (!to.length) return;
    await ensureDmTables(env);
    const quote = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    const link = (origin || '') + target.path + '#sec-comments';
    for (const id of to) {
      // A block means they don't want to hear from this person at all.
      const blocked = await env.DB.prepare(
        'SELECT 1 FROM dm_blocks WHERE user_id=? AND blocked_id=?'
      ).bind(id, fromId).first().catch(() => null);
      if (blocked) continue;
      const what = id === opts.parentAuthorId && id !== target.ownerId
        ? 'replied to your comment on'
        : 'commented on';
      const text = what + ' \u201c' + (target.name || target.slug) + '\u201d:\n\n\u201c' +
        quote + '\u201d\n\n' + link;
      await env.DB.prepare(
        'INSERT INTO dms (sender_id, recipient_id, body, sender_deleted) VALUES (?,?,?,1)'
      ).bind(fromId, id, text).run();
    }
  } catch { /* a failed notification must never fail the comment */ }
}

async function findUserByUsername(env, username) {
  if (!username) return null;
  return selectUserByName(env, 'id, username, display_name, avatar_url, is_admin', username);
}

let _banReady = false;
async function ensureBanColumn(env) {
  if (_banReady) return;
  try {
    await env.DB.prepare('ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0').run();
  } catch { /* column already exists */ }
  _banReady = true;
}

// Extra profile bits (links + pinned pages) live in one JSON column rather than
// a column each — the same hybrid design the content tables use, so adding a
// field later never needs a migration. Created lazily like the ban column.
let _profileColReady = false;
async function ensureProfileColumn(env) {
  if (_profileColReady) return;
  try {
    await env.DB.prepare('ALTER TABLE users ADD COLUMN profile_json TEXT').run();
  } catch { /* column already exists */ }
  _profileColReady = true;
}

const PROFILE_LINK_KEYS = ['website', 'discord', 'bluesky', 'other'];
const PROFILE_URL_RE = /^https?:\/\/[^\s<>"']{3,300}$/i;
// How many of their own pages somebody may pin to the top of their creator
// page. The strip is a grid that wraps, so the number is a matter of how much
// of the page it is fair to spend before the characters start — not a layout
// constraint. Raised from 3; account.html disables the remaining checkboxes at
// the same number, so keep the two in step.
const PROFILE_PINS_MAX = 10;
// Validate what a user typed into their profile settings. Links are http(s)
// only (Discord is a handle, not a URL); pinned pages are checked against what
// the account actually owns by the caller, not here.
function sanitizeProfileExtra(input) {
  const out = { links: {}, pinned: [] };
  const links = (input && typeof input.links === 'object' && input.links) || {};
  for (const k of PROFILE_LINK_KEYS) {
    let v = String(links[k] == null ? '' : links[k]).trim().slice(0, 300);
    if (!v) continue;
    if (k === 'discord') {
      // A handle, not a link: strip a leading @ and keep it plain text.
      v = v.replace(/^@+/, '').slice(0, 40);
      if (v) out.links.discord = v;
      continue;
    }
    if (PROFILE_URL_RE.test(v)) out.links[k] = v;
  }
  const pinned = Array.isArray(input && input.pinned) ? input.pinned : [];
  for (const p of pinned.slice(0, PROFILE_PINS_MAX * 4)) {
    const type = String((p && p.type) || '');
    const slug = String((p && p.slug) || '').slice(0, 80);
    if (!CONTENT[type] || !slug) continue;
    if (out.pinned.some(x => x.type === type && x.slug === slug)) continue;
    out.pinned.push({ type, slug });
    if (out.pinned.length >= PROFILE_PINS_MAX) break;
  }
  return out;
}
function parseProfileExtra(row) {
  let x = null;
  try { x = row && row.profile_json ? JSON.parse(row.profile_json) : null; } catch { x = null; }
  return {
    links: (x && x.links && typeof x.links === 'object') ? x.links : {},
    pinned: Array.isArray(x && x.pinned) ? x.pinned : []
  };
}

// Fresh admin/ban flags from D1 — session cookies cache isAdmin for 30 days,
// but bans and demotions must apply immediately, not when the cookie expires.
async function getAccountFlags(env, userId) {
  try {
    return await env.DB.prepare('SELECT is_admin, banned FROM users WHERE id=?').bind(userId).first();
  } catch {
    // banned column not created yet
    const r = await env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(userId).first().catch(() => null);
    return r ? { is_admin: r.is_admin, banned: 0 } : null;
  }
}

// Admin gate for GET endpoints: session must exist AND still be admin in D1.
async function adminSession(env, request) {
  const sess = await getSession(env, request);
  if (!sess || !sess.isAdmin) return null;
  const flags = await getAccountFlags(env, sess.userId);
  if (!flags || !flags.is_admin) return null;
  return sess;
}

// ---- per-page protection (admin page lock, stored in settings) ----
function protectKey(type, slug) { return 'protected:' + type + ':' + slug; }
async function isProtected(env, type, slug) {
  try {
    const r = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(protectKey(type, slug)).first();
    return !!r && r.value === '1';
  } catch { return false; }
}
const PROTECTED_MSG = 'This page has been protected by an admin and cannot be edited right now.';

// ---- creator identity: which free-text "Creator" names belong to an account ----
// A page's Creator field is free text ("Hystrex"); an account is a row in users.
// Half the wiki was bulk-imported with a creator string and no account at all,
// so the two can never be the same thing — but the creator page and the profile
// page are one page now (/u/{username}, /author?a=Name), and it needs to know
// when a name and an account are the same person.
//
// A name is linked to an account when EITHER:
//   1. proof by ownership — the account already owns a page credited to that
//      name. Publishing under a name is the proof, so registering the username
//      "Hystrex" is not enough to inherit Hystrex's forty characters.
//   2. an admin said so — a settings row, key creator_alias:{lower(name)}, value
//      = the username (an empty value pins the name as deliberately unlinked).
//      This is what covers bulk-imported pages, which have owner_id NULL and so
//      can never prove anything. The override always wins.
// Nothing here is stored on the pages themselves, so it all stays correct as
// pages change hands.
function creatorAliasKey(name) {
  return 'creator_alias:' + String(name || '').trim().toLowerCase();
}
function normCreator(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

// A credit can name several people — "Taiyi (太一), Saki" — and each of them
// gets their own creator page, so matching one name against the whole column
// has to compare a single comma-separated segment at a time. Normalising the
// spaces around the commas lets instr() do exact segment matching; instr and
// not LIKE, because a name is free text and may contain % or _.
function creditMatchSQL(col) {
  return `instr(',' || replace(replace(lower(trim(${col})), ' ,', ','), ', ', ',') || ',', ',' || ? || ',') > 0`;
}
// The same test against a list of names: one bind per name.
function creditAnySQL(col, n) {
  const one = creditMatchSQL(col);
  return '(' + new Array(n).fill(one).join(' OR ') + ')';
}
// Credit string -> the individual names in it, lower-cased.
function creditNames(s) {
  return Creators.splitCreators(s).map(normCreator).filter(Boolean);
}
// How a name is actually spelled on the pages that credit it, so an unclaimed
// creator page shows "Ma'ayan" rather than whatever casing the link carried.
function creditSpelling(name, ...rowSets) {
  const want = normCreator(name);
  if (!want) return '';
  for (const rows of rowSets) {
    for (const r of rows || []) {
      const d = parseData(r);
      for (const n of Creators.splitCreators(d.creator || d.author)) {
        if (normCreator(n) === want) return n.trim();
      }
    }
  }
  return '';
}

// A creator name -> the user row that owns it, or null when nobody does.
async function resolveCreatorAccount(env, name) {
  const key = normCreator(name);
  if (!key) return null;
  try {
    const alias = await env.DB.prepare('SELECT value FROM settings WHERE key=?')
      .bind(creatorAliasKey(key)).first();
    if (alias) {
      // An alias row with an empty value means "this name has no account" —
      // an admin's way of overruling a wrong ownership match.
      if (!alias.value) return null;
      return await selectUserByName(
        env, 'id, username, display_name, bio, avatar_url, created_at', alias.value
      );
    }
  } catch { /* settings table unreachable -> fall through to ownership */ }
  // Proof by ownership: whoever owns the most PUBLISHED pages credited to this
  // name. Published matters — a draft is invisible to everyone but its owner,
  // so counting drafts would let anyone claim any name by saving an unpublished
  // page credited to it. Ties break on the lowest user id; an admin alias is
  // how you settle a genuine clash between two people using the same handle.
  try {
    const hit = await env.DB.prepare(
      `SELECT owner_id, COUNT(*) AS n FROM characters
        WHERE owner_id IS NOT NULL AND status='published' AND ${creditMatchSQL('creator')}
        GROUP BY owner_id ORDER BY n DESC, owner_id ASC LIMIT 1`
    ).bind(key).first();
    let ownerId = hit && hit.owner_id;
    if (!ownerId) {
      const s = await env.DB.prepare(
        `SELECT owner_id, COUNT(*) AS n FROM scripts
          WHERE owner_id IS NOT NULL AND status='published' AND ${creditMatchSQL('author')}
          GROUP BY owner_id ORDER BY n DESC, owner_id ASC LIMIT 1`
      ).bind(key).first();
      ownerId = s && s.owner_id;
    }
    if (!ownerId) return null;
    return await env.DB.prepare(
      'SELECT id, username, display_name, bio, avatar_url, created_at FROM users WHERE id=?'
    ).bind(ownerId).first();
  } catch { return null; }
}

// An account -> every creator name it has published under (proof by ownership),
// plus any name an admin has pointed at it. Lower-cased for comparison; the
// display spelling comes off the pages themselves.
async function creatorNamesFor(env, userId, username) {
  const names = new Set();
  try {
    // Published only, for the same reason resolveCreatorAccount insists on it:
    // a draft nobody else can see must not be able to claim a name.
    const [chars, scripts] = await Promise.all([
      env.DB.prepare(`SELECT DISTINCT creator AS n FROM characters WHERE owner_id=? AND status='published'`).bind(userId).all(),
      env.DB.prepare(`SELECT DISTINCT author AS n FROM scripts WHERE owner_id=? AND status='published'`).bind(userId).all()
    ]);
    // Split each credit: co-authoring a page claims the name you were credited
    // under, not the whole "Taiyi (太一), Saki" string.
    for (const r of [...(chars.results || []), ...(scripts.results || [])]) {
      for (const n of creditNames(r.n)) names.add(n);
    }
  } catch { /* leave whatever we got */ }
  try {
    const { results } = await env.DB.prepare(
      `SELECT key, value FROM settings WHERE key LIKE 'creator_alias:%'`
    ).all();
    for (const r of results || []) {
      const n = String(r.key).slice('creator_alias:'.length);
      if (!n) continue;
      // The alias is the last word on a name, in both directions: it grants the
      // name to the account it points at, and takes it off everyone else — an
      // empty value ("nobody") and a different username both un-link it here,
      // even from an account that owns published pages under it. Without this,
      // reassigning a shared handle would leave it claimed twice.
      if (normCreator(r.value) === normCreator(username)) names.add(n);
      else names.delete(n);
    }
  } catch { /* no aliases set */ }
  return [...names];
}

// ---- page-view counter (analytics; bots filtered, 180-day retention) ----
const BOT_UA_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|discord|whatsapp|telegram|curl|wget|python|java|httpclient|headless|lighthouse|pingdom|uptime/i;
async function bumpView(env, request, type, slug) {
  try {
    const ua = request.headers.get('User-Agent') || '';
    if (!ua || BOT_UA_RE.test(ua)) return;
    await ensureViewsTable(env);
    await env.DB.prepare(
      `INSERT INTO page_views (entity_type, slug, day, n) VALUES (?,?,date('now'),1)
       ON CONFLICT(entity_type, slug, day) DO UPDATE SET n = n + 1`
    ).bind(type, slug).run();
  } catch { /* analytics must never break a page */ }
}

// ---- ownership: may this session edit this row? ----
function canEditRow(sess, row) {
  if (!sess) return false;
  if (sess.isAdmin) return true;
  return !!row.owner_id && row.owner_id === sess.userId;
}

/* ---- who may edit a page ----
   `canEditRow` above is ownership, and it still governs everything that
   belongs to the creator: renaming, publishing, deleting, rolling back, and
   the public-editing setting itself.

   On top of that a creator may open a page up, stored on its data as
   `publicEdit`. editPermission() answers what THIS session may do to THIS row:

     'owner'    everything (the owner, or an admin)
     'approved' the page's content, for an account the owner named by hand
     'all'      the page's content, but none of the owner's own settings
     'tags'     the tags and nothing else (characters only)
     ''         nothing

   Never open, whatever the setting says: a draft, an admin-protected page,
   and a page whose owner never opted in. 'approved' is the one exception to
   the draft half of that — see editPermission below. */
const PUBLIC_EDIT_MODES = { all: 1, tags: 1, suggest: 1, approved: 1 };
function publicEditMode(d) {
  const v = d && d.publicEdit;
  return (typeof v === 'string' && PUBLIC_EDIT_MODES[v]) ? v : '';
}
function sanitizePublicEdit(v) {
  return (typeof v === 'string' && PUBLIC_EDIT_MODES[v]) ? v : '';
}

/* ---- approved editing: the accounts the owner named ----
   `publicEdit: 'approved'` opens a page to a list rather than to everyone.
   The list lives on the page's data as `editors`, one `{id, username}` per
   account:

     - the **id** is the authority. It is what every permission check reads,
       it costs no lookup (a session already carries `userId`), and it keeps
       working when somebody changes their handle.
     - the **username** is only what the owner's editor shows back, so the
       list reads as names rather than numbers.

   A client may post either form — the pairs it read back, or the bare names
   the owner typed into the box. Both go through sanitizeEditors(), which
   resolves every entry against `users` and drops what it cannot find, so a
   typo can never become a permission. */
const PAGE_EDITORS_MAX = 20;

function approvedEditors(d) {
  return (Array.isArray(d && d.editors) ? d.editors : []).filter(e => e && typeof e === 'object');
}
function isApprovedEditor(sess, d) {
  if (!sess || sess.userId == null) return false;
  return approvedEditors(d).some(e => Number(e.id) === Number(sess.userId));
}

/* Returns { list, unknown }: the resolved editors, and the names no account
   answered to. The caller reports `unknown` back to the owner — silently
   dropping a name would leave them believing they had shared the page. */
async function sanitizeEditors(env, v, ownerId) {
  const list = [], unknown = [], seen = new Set();
  if (!Array.isArray(v)) return { list, unknown };
  for (const raw of v.slice(0, PAGE_EDITORS_MAX * 2)) {
    const name = typeof raw === 'string' ? raw
      : (raw && typeof raw === 'object' ? String(raw.username || '') : '');
    if (!name.trim()) continue;
    const u = await selectUserByName(env, 'id, username', name).catch(() => null);
    if (!u) { if (unknown.length < PAGE_EDITORS_MAX) unknown.push(normUsername(name)); continue; }
    // The owner is not a guest on their own page, and an account listed twice
    // (once by name, once by pair) is one editor.
    if (ownerId != null && Number(u.id) === Number(ownerId)) continue;
    if (seen.has(Number(u.id))) continue;
    seen.add(Number(u.id));
    list.push({ id: Number(u.id), username: String(u.username) });
    if (list.length >= PAGE_EDITORS_MAX) break;
  }
  return { list, unknown };
}

/* Being named as an editor is news, so it arrives the way every other
   notification on the wiki does: a `dms` row that rides the unread count on
   /api/me and the mail flag site.js puts on "My Account". sender_deleted=1
   keeps it out of the owner's own conversation list — they shared a page,
   they did not start a conversation. */
async function notifyEditorsAdded(env, opts) {
  try {
    const { fromId, added, name, path, origin } = opts;
    if (!added || !added.length) return;
    await ensureDmTables(env);
    const from = await env.DB.prepare('SELECT username FROM users WHERE id=?')
      .bind(fromId).first().catch(() => null);
    const who = from && from.username ? '@' + from.username : 'Someone';
    for (const e of added) {
      if (e.id == null || Number(e.id) === Number(fromId)) continue;
      const text = who + ' added you as an editor of \u201c' + (name || 'a page') + '\u201d.' +
        ' You can now edit it exactly as they would \u2014 publishing, deleting and the editor' +
        ' list itself stay with them.' +
        (path ? '\n\n' + (origin || '') + path : '');
      await env.DB.prepare(
        'INSERT INTO dms (sender_id, recipient_id, body, sender_deleted) VALUES (?,?,?,1)'
      ).bind(fromId, e.id, text).run();
    }
  } catch { /* a notification must never break a save */ }
}

/* ---- approved editing, waterfalled from a script or a collection ----
   Sharing a script or a collection with somebody is almost never a request to
   share only that one page: the roster IS the work, and an editor who can fix
   the script's synopsis but not a typo in any of its characters has been given
   the smaller half. So being an approved editor of a script or a collection
   carries down to the character pages it lists.

   With one boundary, and it is the important part: it reaches only characters
   owned by the SAME account as the parent page. A collection can list anybody's
   characters — that is what makes collections useful — so without this rule,
   naming an editor on a collection would hand them edit rights over other
   people's pages, which is not the owner's to give. Their own characters in
   their own collection is exactly what they meant to share.

   The scan is the whole point of the cache: it asks for the few script and
   collection rows that name any editor at all (almost always none), keyed on
   the content version so a change to a roster or an editor list invalidates
   it, exactly like curataCollections above. */
let _sharedParentCache = null;
async function sharedParentPages(env) {
  const version = await contentVersion(env);
  if (_sharedParentCache && _sharedParentCache.version === version) return _sharedParentCache.rows;
  const rows = [];
  try {
    for (const type of ['collection', 'script']) {
      const { results } = await env.DB.prepare(
        `SELECT slug, owner_id, data FROM ${CONTENT[type].table}
         WHERE status IS NOT 'deleted' AND owner_id IS NOT NULL AND data LIKE ?`
      ).bind('%"editors"%').all();
      for (const r of results || []) {
        const d = parseData(r);
        // The list only means anything in the mode that reads it.
        if (publicEditMode(d) !== 'approved') continue;
        const editors = approvedEditors(d)
          .map(e => Number(e.id)).filter(n => Number.isFinite(n));
        if (!editors.length) continue;
        rows.push({ type, slug: r.slug, ownerId: Number(r.owner_id), editors, data: d });
      }
    }
  } catch {
    // Never cache a failed read: the next request should try again rather
    // than treat "the query broke" as "nothing is shared" for a whole
    // content version.
    return [];
  }
  _sharedParentCache = { version, rows };
  return rows;
}

/* Does this script/collection list this character? A script says so outright;
   a collection is resolved by the one membership rule (match[]/include[]/
   exclude[]) rather than a second copy of it — passing the single character in
   as the whole corpus asks "is this one a member" with the same code the page
   itself renders through. */
function parentListsCharacter(parent, charRow, charData) {
  if (parent.type === 'script') {
    return (parent.data.characters || []).some(x => String(x) === charRow.slug);
  }
  const probe = { slug: charRow.slug, appearsIn: charData.appearsIn || '' };
  return PageRender.resolveCollectionMembers(parent.data, [probe]).length > 0;
}

/* The script or collection that shares this character with this session, or
   null. Returning the parent rather than a boolean is what lets the editor say
   WHERE the permission came from — "you were made an editor of this page" is
   a confusing thing to read on a page nobody named you on. */
async function waterfallParent(env, sess, charRow) {
  if (!sess || sess.userId == null || !charRow) return null;
  // An unowned page (most of the bulk-imported wiki) belongs to no creator, so
  // there is nobody whose sharing could reach it.
  if (charRow.owner_id == null) return null;
  if ((charRow.status || 'published') === 'deleted') return null;
  const parents = await sharedParentPages(env);
  if (!parents.length) return null;
  const d = parseData(charRow);
  for (const p of parents) {
    if (p.ownerId !== Number(charRow.owner_id)) continue;
    if (!p.editors.includes(Number(sess.userId))) continue;
    if (!parentListsCharacter(p, charRow, d)) continue;
    // An admin-protected page is nobody's to share, the same as everywhere.
    if (await isProtected(env, 'character', charRow.slug)) return null;
    return p;
  }
  return null;
}

async function waterfallEditor(env, sess, charRow) {
  return !!(await waterfallParent(env, sess, charRow));
}

/* ---- assigning a script or collection carries its characters with it ----

   Handing somebody a set and not its pages hands them the half that is not
   the work: the roster IS the work, and the wiki was seeded with whole
   collections whose characters all came across unowned. The dashboard's way
   of doing this was to filter the page list to "this collection, owner none"
   and bulk-assign, which is two tools and a step everybody forgets.

   It claims two kinds of page and no others: one that belongs to NOBODY, and
   one owned by an ADMIN account. The second is what makes this useful rather
   than theoretical — most of this wiki arrived by bulk import and the import
   account owns it, so "unowned only" moved nothing at all on the sets people
   actually want to hand over (the 50 Festival of Lanterns characters were all
   owned by `admin`). An admin's ownership of a character is almost always
   that artifact, and an admin can take it back with the same click.

   A page owned by an ordinary member is never touched. A collection can list
   anybody's characters (`include[]` takes any slug on the wiki), so a rule
   that reassigned every member would let one admin action move a stranger's
   pages to another account — which is not an ownership question, it is taking
   somebody's work away. Those are counted and reported instead (`held`), and
   moving them on purpose is still one filter and a bulk action away.

   Clearing an owner never cascades either: it would orphan every character of
   the set, and the reason to clear one is almost always that the parent was
   assigned wrongly. */
const OWNER_WATERFALL_MAX = 1000;

/* The characters a script or collection holds. A script says so outright (an
   `off-` slug is an official character and has no page here); a collection is
   resolved by the one membership rule rather than a second copy of it. */
async function rosterCharacterSlugs(env, type, row, cache) {
  if (type === 'script') {
    const d = parseData(row);
    return (Array.isArray(d.characters) ? d.characters : [])
      .map(x => String(x || '')).filter(x => x && !x.startsWith('off-'));
  }
  if (type === 'collection') {
    // Membership is matched, not stored, so it needs every character — but
    // only two columns, and only once per request: a bulk assignment over
    // fifty collections would otherwise read the table fifty times.
    if (!cache || !cache.chars) {
      const { results } = await env.DB.prepare(
        "SELECT slug, appears_in AS appearsIn FROM characters WHERE status IS NOT 'deleted'"
      ).all().catch(() => ({ results: [] }));
      if (!cache) return PageRender.resolveCollectionMembers(parseData(row), results || [])
        .map(c => c.slug).filter(Boolean);
      cache.chars = results || [];
    }
    return PageRender.resolveCollectionMembers(parseData(row), cache.chars)
      .map(c => c.slug).filter(Boolean);
  }
  return [];
}

/* The admin accounts. Shares the per-request cache the roster scan uses, so a
   bulk assignment asks once. An empty list is the safe answer on failure: the
   claim then only takes unowned pages. */
async function adminUserIds(env, cache) {
  if (cache && cache.admins) return cache.admins;
  let ids = [];
  try {
    const { results } = await env.DB.prepare(
      'SELECT id FROM users WHERE COALESCE(is_admin,0)=1'
    ).all();
    ids = (results || []).map(r => Number(r.id)).filter(Number.isFinite);
  } catch { ids = []; }
  if (cache) cache.admins = ids;
  return ids;
}

/* Returns {claimed, held}: how many characters this assignment picked up, and
   how many were left with the members who own them. */
async function waterfallOwner(env, sess, type, row, ownerId, cache) {
  const out = { claimed: 0, held: 0 };
  if (ownerId == null) return out;
  if (type !== 'script' && type !== 'collection') return out;
  const slugs = [...new Set(await rosterCharacterSlugs(env, type, row, cache))].slice(0, OWNER_WATERFALL_MAX);
  if (!slugs.length) return out;
  // The admin accounts, whose ownership of a character page is the bulk
  // import's leftovers. Read once (there are a handful), and if the read fails
  // the claim falls back to unowned-only — the safe half of the rule.
  const admins = await adminUserIds(env, cache);
  const adminQ = admins.length ? admins.map(() => '?').join(',') : '';
  for (let i = 0; i < slugs.length; i += 100) {
    const chunk = slugs.slice(i, i + 100);
    const q = chunk.map(() => '?').join(',');
    try {
      // Counted BEFORE the update, or the ones just claimed would count as
      // somebody else's. "Held" is a page belonging to a member: an admin's is
      // about to be claimed, so it is not left behind and must not be reported
      // as though it were.
      const held = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM characters
         WHERE slug IN (${q}) AND status IS NOT 'deleted'
           AND owner_id IS NOT NULL AND owner_id != ?` +
        (adminQ ? ` AND owner_id NOT IN (${adminQ})` : '')
      ).bind(...chunk, ownerId, ...admins).first();
      out.held += (held && held.n) || 0;
      const res = await env.DB.prepare(
        `UPDATE characters SET owner_id=?, updated_at=datetime('now')
         WHERE slug IN (${q}) AND status IS NOT 'deleted'
           AND (owner_id IS NULL` + (adminQ ? ` OR owner_id IN (${adminQ})` : '') + `)`
      ).bind(ownerId, ...chunk, ...admins).run();
      out.claimed += (res && res.meta && res.meta.changes) || 0;
    } catch { /* one bad chunk must not lose the assignment itself */ }
  }
  if (out.claimed) {
    await logActivity(env, sess, 'assign-owner', 'character', null,
      out.claimed + ' character page' + (out.claimed === 1 ? '' : 's') +
      ' with ' + type + ' ' + row.slug);
  }
  return out;
}

/* A ceiling the owner's own saves never needed. A page is a few kilobytes of
   text, so nothing legitimate comes near this; it stops somebody parking a
   megabyte in a row they do not own. */
const PUBLIC_EDIT_MAX_BYTES = 120000;
const SUGGEST_INSTEAD = 'This page takes suggestions rather than direct edits. Send yours for the creator to approve.';
const PUBLIC_EDIT_TAGS_MAX = 400;
function publicEditTooBig(o) {
  try { return JSON.stringify(o).length > PUBLIC_EDIT_MAX_BYTES; } catch { return true; }
}

async function editPermission(env, sess, type, row) {
  if (!sess || !row) return '';
  if (canEditRow(sess, row)) return 'owner';
  if ((row.status || 'published') === 'deleted') return '';
  const d = parseData(row);
  const mode = publicEditMode(d);
  /* Approved editors are named one account at a time, so they reach a DRAFT
     too — a collaborator is most use before the page goes live, and there is
     no stranger here to hide it from. They still cannot publish it: the save
     handlers carry the stored status forward for everyone but the owner, so
     what goes live stays the creator's call. */
  if (mode === 'approved' && isApprovedEditor(sess, d)) {
    if (await isProtected(env, type, row.slug)) return '';
    return 'approved';
  }
  /* Named on the script or collection this character is part of, rather than
     on the character itself. Same permission, for the same reason: it is the
     page's owner who named them. Checked here so it applies to a page that
     opted into nothing of its own — which is most of them. */
  if (type === 'character' && await waterfallEditor(env, sess, row)) return 'approved';
  if (!mode) return '';
  if (mode === 'approved') return '';    // named editing, and this is not one of the names
  if ((row.status || 'published') !== 'published') return '';
  if (mode === 'tags' && type !== 'character') return '';
  if (await isProtected(env, type, row.slug)) return '';
  return mode;
}

/* Ownership, or an approved editor the owner named. This is the gate on
   everything an approved editor has to be able to SEE: a draft page they were
   invited to work on, and the Edit button that takes them into it. It is
   deliberately not `canEditRow` — that still means ownership, and still
   governs publishing, deleting, renaming and the editor list itself. */
async function canEditPage(env, sess, type, row) {
  if (canEditRow(sess, row)) return true;
  if (!sess || !row) return false;
  const d = parseData(row);
  if (publicEditMode(d) === 'approved' && isApprovedEditor(sess, d)) {
    if ((row.status || 'published') === 'deleted') return false;
    return !(await isProtected(env, type, row.slug));
  }
  // ...or named on the script/collection this character belongs to. Being here
  // is what lets a shared roster's character pages be SEEN as drafts and take
  // an art upload, not just be saved.
  if (type === 'character') return waterfallEditor(env, sess, row);
  return false;
}

/* 'suggest' is not write access: it is permission to PROPOSE a version
   (POST /api/suggest). Every save handler asks this before writing, so a mode
   that is not a writing mode can never be mistaken for one. */
function permCanWrite(perm) {
  return perm === 'owner' || perm === 'approved' || perm === 'all' || perm === 'tags';
}

/* Telling a suggester what happened, through the same DM row as every other
   notification, so it lands where they already look. */
async function notifySuggestionAnswer(env, sug, row, verdict, reply, fromId, origin) {
  try {
    if (sug.user_id == null || sug.user_id === fromId) return;
    await ensureDmTables(env);
    const text = 'Your suggested edit to \u201c' + (row.name || sug.slug) + '\u201d was ' + verdict + '.' +
      (reply ? '\n\n\u201c' + reply + '\u201d' : '') +
      '\n\n' + (origin || '') + '/suggestions?type=' + encodeURIComponent(sug.entity_type) +
      '&slug=' + encodeURIComponent(sug.slug);
    await env.DB.prepare(
      'INSERT INTO dms (sender_id, recipient_id, body, sender_deleted) VALUES (?,?,?,1)'
    ).bind(fromId, sug.user_id, text).run();
  } catch { /* a notification must never break a decision */ }
}

// A page edited by somebody who does not own it: tell the owner through the
// notification the site already has (the unread count on /api/me, the mail
// flag on "My Account"). sender_deleted=1 keeps it out of the editor's own
// conversation list: they edited a page, they did not send a message.
async function notifyPageEdit(env, opts) {
  try {
    const { fromId, ownerId, what, name, path, origin } = opts;
    if (ownerId == null || ownerId === fromId) return;
    await ensureDmTables(env);
    const blocked = await env.DB.prepare(
      'SELECT 1 FROM dm_blocks WHERE user_id=? AND blocked_id=?'
    ).bind(ownerId, fromId).first().catch(() => null);
    if (blocked) return;
    const text = what + ' \u201c' + (name || '') + '\u201d, which you have open for edits.\n\n' +
      (origin || '') + path + '\n\nEvery change is listed at ' + (origin || '') + '/history?type=' +
      encodeURIComponent(opts.type) + '&slug=' + encodeURIComponent(opts.slug) +
      ', where you can put back any earlier version.';
    await env.DB.prepare(
      'INSERT INTO dms (sender_id, recipient_id, body, sender_deleted) VALUES (?,?,?,1)'
    ).bind(fromId, ownerId, text).run();
  } catch { /* a notification must never break a save */ }
}

async function getEntityRow(env, type, slug) {
  const t = CONTENT[type];
  if (!t || !slug) return null;
  // updated_at rides along for the edit-conflict check: the editors send it
  // back as baseUpdatedAt, and a save whose base no longer matches the stored
  // row is rejected rather than silently overwriting somebody else's work.
  // Characters also carry url_slug, so anything holding a row can build a link
  // to it without a second query (charAddress).
  let addr = '';
  if (type === 'character') {
    await ensureUrlSlugColumn(env);
    addr = ', url_slug';
  }
  return env.DB.prepare(
    `SELECT slug, ${t.nameCol} AS name, owner_id, status, data, created_at, updated_at${addr} FROM ${t.table} WHERE slug=?`
  ).bind(slug).first().catch(() => null);
}

// ---- history: resolving a page of any revisable type ----
// `revisions` rows are written for wiki pages too (saveRevision is called on
// every /api/wiki-page save), but both the read and the rollback route gated
// on CONTENT[type] — which holds only character/collection/script — so that
// history accumulated in D1 and was reachable by nobody, including admins,
// while publish-page.html told people deletion could not be undone.
const REVISABLE = { character: 1, collection: 1, script: 1, wikipage: 1 };

async function revisableRow(env, type, slug) {
  if (type === 'wikipage') {
    await ensurePagesTable(env);
    const row = await env.DB.prepare(
      'SELECT slug, title AS name, owner_id, status, data, created_at, updated_at FROM pages WHERE slug=?'
    ).bind(slug).first().catch(() => null);
    return row || null;
  }
  if (!CONTENT[type]) return null;
  let row = await getEntityRow(env, type, slug);
  if (!row && type === 'collection') row = await findCollectionRow(env, slug);
  return row || null;
}

// Writes a revision's data back onto its row. Split out because rollback and
// the owner-facing version of it are the same operation with different gates.
async function applyRollback(env, type, row, d) {
  if (type === 'character') {
    if (!d.name || !d.team) throw new Error('That revision is missing required fields.');
    await env.DB.prepare(
      `UPDATE characters SET name=?, team=?, creator=?, tags=?, appears_in=?, data=?, updated_at=datetime('now') WHERE slug=?`
    ).bind(d.name, d.team, d.creator || null, d.tags || null, d.appearsIn || null, JSON.stringify(d), row.slug).run();
  } else if (type === 'collection') {
    await env.DB.prepare(
      `UPDATE collections SET display_name=?, data=?, updated_at=datetime('now') WHERE slug=?`
    ).bind(d.displayName || row.name || row.slug, JSON.stringify(d), row.slug).run();
  } else if (type === 'wikipage') {
    await env.DB.prepare(
      `UPDATE pages SET title=?, data=?, updated_at=datetime('now') WHERE slug=?`
    ).bind(d.title || row.name || row.slug, JSON.stringify(d), row.slug).run();
  } else {
    await env.DB.prepare(
      `UPDATE scripts SET name=?, author=?, data=?, updated_at=datetime('now') WHERE slug=?`
    ).bind(d.name || row.slug, d.author || null, JSON.stringify(d), row.slug).run();
  }
}

// ---- edit conflicts ----
// Every content write is a blind whole-document upsert, and the editors post
// back the entire object they loaded. So an admin (or a second tab) that
// opened a page an hour ago and pressed Save reverted every field the owner
// had changed since — silently, with no warning to either of them and no
// notification afterwards.
//
// The fix is one comparison: the editor sends the updated_at it loaded, and a
// save whose base no longer matches the stored row is refused. Deliberately
// permissive in one direction — a client that sends no baseUpdatedAt at all
// is allowed through, because /api/character is a public-ish endpoint used by
// Icon Forge, Grimforge and mass-upload, and breaking those to protect
// against a rare race would be the worse trade.
// Always call through checkEditConflict(), which also strips the field: `body`
// is spread wholesale into the stored JSON blob, so leaving baseUpdatedAt on it
// would persist a stale timestamp inside every page's data forever.
function editConflict(existing, body) {
  if (!existing) return null;                       // creating, nothing to clobber
  const base = body && body.baseUpdatedAt;
  if (!base) return null;                           // caller opted out (see above)
  const current = existing.updated_at;
  if (!current || String(base) === String(current)) return null;
  return jsonResponse({
    error: 'Somebody else saved changes to this page while you had it open. ' +
           'Reload the editor to get their version — your unsaved changes are still ' +
           'in this tab, so copy anything you need before reloading.',
    conflict: true,
    savedAt: current
  }, { status: 409 });
}

function checkEditConflict(existing, body) {
  const res = editConflict(existing, body);
  if (body && typeof body === 'object') delete body.baseUpdatedAt;
  return res;
}

// ---- renaming a page (old URL keeps working) ----
// A character's URL is built from its name, so renaming one has to move the
// page. Every old link — bookmarks, Discord posts, the official wiki's forum
// threads — must keep working, so the slug it used to live at is remembered
// here and 301s to the new one.
let _redirectsReady = false;
async function ensureRedirectsTable(env) {
  if (_redirectsReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS redirects (
       entity_type TEXT NOT NULL,
       from_slug   TEXT NOT NULL,
       to_slug     TEXT NOT NULL,
       created_at  TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY (entity_type, from_slug)
     )`
  ).run();
  _redirectsReady = true;
}

// Read side: never creates the table (a wiki that has never renamed anything
// has none), never throws — a missing redirect is just a 404 like before.
async function lookupRedirect(env, type, slug) {
  if (!slug) return null;
  try {
    const r = await env.DB.prepare(
      'SELECT to_slug FROM redirects WHERE entity_type=? AND from_slug=?'
    ).bind(type, slug).first();
    return r ? r.to_slug : null;
  } catch { return null; }
}

// Move one R2 object. Returns false when there was nothing there (art that
// still lives in the committed assets/art/ folder, for instance).
async function moveR2Object(env, fromKey, toKey) {
  if (!env.ART) return false;
  const obj = await env.ART.get(fromKey).catch(() => null);
  if (!obj) return false;
  const body = await obj.arrayBuffer();
  await env.ART.put(toKey, body, {
    httpMetadata: obj.httpMetadata,
    customMetadata: obj.customMetadata
  });
  await env.ART.delete(fromKey).catch(() => { /* the copy is what matters */ });
  return true;
}

// Rewrite art paths that carry the old slug: 'art/old.png',
// 'art/old-alt.png', 'art/old-alt2.png' and the absolute image URLs built
// from them. Anchored on the character's own slug so 'art/oldest.png' is
// never touched.
function retargetArtPaths(obj, from, to) {
  const re = new RegExp('art/' + from + '(?=[-.])', 'g');
  for (const k of ['art', 'image', 'artAlt', 'imageAlt', 'artAlt2', 'imageAlt2']) {
    if (typeof obj[k] === 'string') obj[k] = obj[k].replace(re, 'art/' + to);
  }
}

// ===================== CHARACTER ADDRESSES =====================
//
// A character has an IDENTITY and an ADDRESS, and they are two different
// strings:
//
//   identity  characters.slug (the PK)   witcher-odyssey    never changes
//   address   characters.url_slug        odyssey/witcher    free to change
//
// Everything that points AT a character points at the identity — comments,
// page_views, revisions, activity_log, script rosters, collection
// include/exclude, profile pins, the art objects in R2. So renaming a page is
// an address change and nothing else, which is why renameCharacter() below is
// a few lines instead of the twelve-target migration it used to be, and why a
// new feature can store a character reference without registering itself
// anywhere.
//
// The two namespaces cannot collide, because an address always carries a slash
// and an identity never does. /c/{one-segment} is therefore always an identity
// (or a flat address from before nesting) and 301s to the canonical
// /c/{set}/{name}; no redirect row is needed to keep the old flat URLs alive,
// the primary key itself does that.
//
// Old ADDRESSES are remembered in `redirects` and always point at the
// IDENTITY, never at another address — so a page that moves twice needs no
// chain rewriting: every address it ever had still resolves through the row to
// wherever it lives now.

const CHAR_ADDR_FALLBACK = 'misc';

function kebab(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 80);
}

let _urlSlugReady = false;
async function ensureUrlSlugColumn(env) {
  if (_urlSlugReady) return;
  // Lazily ALTERed, the same way users.banned and users.username_key are:
  // there are no manual migrations on this project.
  try { await env.DB.prepare('ALTER TABLE characters ADD COLUMN url_slug TEXT').run(); }
  catch { /* already there */ }
  try {
    await env.DB.prepare(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_characters_url_slug ON characters(url_slug)'
    ).run();
  } catch { /* index exists; NULLs are distinct in SQLite so unset rows are fine */ }
  _urlSlugReady = true;
}

// The address a character should be read at. Falls back to the identity for a
// row the backfill has not reached, so a half-finished migration can never
// 404 a page — the worst case is a page still answering on its old flat URL.
function charAddress(row) {
  if (!row) return '';
  return String(row.url_slug || row.slug || '');
}

// character identity -> the script whose roster lists it. First script wins,
// so a character on two scripts is filed under the one that was created first.
// Cached on content_version like the collection maps beside it.
let _scriptRosterCache = null;
async function scriptRosterMap(env) {
  const version = await contentVersion(env);
  if (_scriptRosterCache && _scriptRosterCache.version === version) return _scriptRosterCache.map;
  const map = new Map();
  try {
    const { results } = await env.DB.prepare(
      "SELECT slug, data FROM scripts WHERE status='published' ORDER BY created_at, slug"
    ).all();
    for (const r of results || []) {
      const q = kebab(r.slug);
      if (!q) continue;
      let d = {};
      try { d = JSON.parse(r.data); } catch { continue; }
      for (const s of (Array.isArray(d.characters) ? d.characters : [])) {
        // Official roles ride along in a roster as `off-` ids; they are not
        // wiki pages and have no address to give.
        if (typeof s === 'string' && !s.startsWith('off-') && !map.has(s)) map.set(s, q);
      }
    }
  } catch { /* no scripts, or no status column yet */ }
  _scriptRosterCache = { version, map };
  return map;
}

// Scripts, matched the loose way findCollectionRow matches collections, so
// "The Princess' Requiem" finds the-princess-requiem.
async function findScriptRowLoose(env, key) {
  if (!key) return null;
  const hit = await env.DB.prepare('SELECT slug, data FROM scripts WHERE slug=?')
    .bind(kebab(key)).first().catch(() => null);
  if (hit) return hit;
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const nkey = norm(key);
  if (!nkey) return null;
  const { results } = await env.DB.prepare('SELECT slug, data FROM scripts')
    .all().catch(() => ({ results: [] }));
  for (const row of results || []) {
    if (norm(row.slug) === nkey) return row;
    try {
      const d = JSON.parse(row.data);
      if (d && (norm(d.name) === nkey || norm(d.displayName) === nkey || norm(d.id) === nkey)) return row;
    } catch { /* skip bad rows */ }
  }
  return null;
}

// The set segment of a character's address, in the order the wiki reads:
//
//   1. a collection it appears in       odyssey/witcher
//   2. a script it appears in           fall-of-rome/actor
//   3. the set named in "Appears in" even when this wiki has no page for it —
//      "Trouble Homebrewing" is a real set that nobody registered, and its 36
//      characters read far better under it than scattered under six authors
//   4. the author                       gobinator/archer
//   5. their account, then `misc` for a page with none of the above
//
// Collections beat scripts outright for the 22 characters that name both.
// Steps 1 and 2 match loosely (case, punctuation and apostrophes are ignored)
// because `appears_in` is free text that people typed: "Tales from Tir-Far's
// Archive" has to find tales-from-tir-fars-archive, or a whole collection
// would land in step 3 under a near-miss of its own name.
async function characterQualifier(env, entry, ownerId) {
  const segs = String((entry && entry.appearsIn) || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  for (const s of segs) {
    const row = await findCollectionRow(env, s);
    if (row) {
      const d = parseData(row);
      const q = kebab((d && d.id) || row.slug);
      if (q) return q;
    }
  }
  for (const s of segs) {
    const row = await findScriptRowLoose(env, s);
    if (row) {
      const q = kebab(row.slug);
      if (q) return q;
    }
  }
  if (segs.length) {
    const q = kebab(segs[0]);
    if (q) return q;
  }
  // No "Appears in" of its own — but a collection may list it by hand, which
  // is exactly what the page itself shows in that row (applyCollectionAppearsIn).
  // The address agrees with the page rather than contradicting it.
  if (entry && entry.slug) {
    try {
      for (const coll of await includeCollections(env)) {
        if (coll.include.includes(entry.slug)) {
          const q = kebab(coll.id);
          if (q) return q;
        }
      }
    } catch { /* fall through to the script rosters */ }
    // Then a script that lists it. The Blood on the TARDIS cast is the case
    // this catches: thirty characters with no "Appears in" of their own that
    // plainly belong to one script, and would otherwise be filed under the
    // account that happens to own them.
    try {
      const q = (await scriptRosterMap(env)).get(String(entry.slug));
      if (q) return q;
    } catch { /* fall through to the author */ }
  }
  // A credit can name several people ("Taiyi (太一), Saki"); the first is the
  // one the address is filed under, same as everywhere else on the wiki.
  const cred = creditNames((entry && entry.creator) || '')[0];
  if (cred) {
    const q = kebab(cred);
    if (q) return q;
  }
  if (ownerId) {
    try {
      const u = await env.DB.prepare('SELECT username FROM users WHERE id=?')
        .bind(ownerId).first();
      const q = kebab(u && u.username);
      if (q) return q;
    } catch { /* fall through */ }
  }
  return CHAR_ADDR_FALLBACK;
}

// The first free address under `qualifier`. Two characters with the same name
// in the same set get `.../carpenter` and `.../carpenter-2` — there is nothing
// left to tell them apart by, and it is 60 pages across the whole wiki.
async function freeCharAddress(env, qualifier, base, exceptUid) {
  await ensureUrlSlugColumn(env);
  const q = kebab(qualifier) || CHAR_ADDR_FALLBACK;
  const name = kebab(base) || 'character';
  const first = q + '/' + name;
  const taken = new Set();
  try {
    const { results } = await env.DB.prepare(
      'SELECT url_slug FROM characters WHERE slug<>? AND (url_slug=? OR url_slug LIKE ?)'
    ).bind(String(exceptUid || ''), first, first + '-%').all();
    for (const r of results || []) if (r.url_slug) taken.add(String(r.url_slug));
  } catch { /* column not there yet: nothing is taken */ }
  try {
    const { results } = await env.DB.prepare(
      "SELECT from_slug, to_slug FROM redirects WHERE entity_type='character' AND (from_slug=? OR from_slug LIKE ?)"
    ).bind(first, first + '-%').all();
    for (const r of results || []) {
      // An address this same page used to live at is not in the way: moving
      // back onto it just undoes the redirect.
      if (exceptUid && String(r.to_slug) === String(exceptUid)) continue;
      if (r.from_slug) taken.add(String(r.from_slug));
    }
  } catch { /* nothing has ever moved */ }
  if (!taken.has(first)) return first;
  for (let i = 2; i < 500; i++) {
    const candidate = first + '-' + i;
    if (!taken.has(candidate)) return candidate;
  }
  return first + '-' + Date.now().toString(36);
}

// The address a character's current name and set ask for. `current` is the
// address it already has, if any.
async function characterAddress(env, uid, entry, ownerId, current) {
  const q = kebab(await characterQualifier(env, entry, ownerId)) || CHAR_ADDR_FALLBACK;
  const name = kebab((entry && entry.name) || uid) || 'character';
  const first = q + '/' + name;
  // Already filed under the right set under the right name — including as a
  // numbered duplicate. Keep it. Recomputing the address on every save is what
  // makes a rename automatic, but a save that changed neither the name nor the
  // set must not shuffle the page onto a different URL just because a sibling
  // moved away and freed up the unnumbered form.
  if (current === first) return current;
  if (current && current.startsWith(first + '-') && /^\d+$/.test(current.slice(first.length + 1))) {
    return current;
  }
  return freeCharAddress(env, q, name, uid);
}

// Move a character to a new address, remembering the old one. This is the
// whole of what renaming does now: one UPDATE and one redirect row. Nothing
// else in the database, and nothing in R2, is touched.
async function setCharAddress(env, uid, address) {
  await ensureUrlSlugColumn(env);
  const prev = await env.DB.prepare('SELECT url_slug FROM characters WHERE slug=?')
    .bind(uid).first().catch(() => null);
  const from = prev && prev.url_slug ? String(prev.url_slug) : '';
  if (from === address) return false;
  await env.DB.prepare('UPDATE characters SET url_slug=? WHERE slug=?')
    .bind(address, uid).run();
  if (from) {
    await ensureRedirectsTable(env);
    await env.DB.prepare(
      `INSERT INTO redirects (entity_type, from_slug, to_slug) VALUES ('character',?,?)
       ON CONFLICT(entity_type, from_slug) DO UPDATE SET to_slug=excluded.to_slug`
    ).bind(from, uid).run();
  }
  // An address that is a live page again must stop being a redirect.
  try {
    await env.DB.prepare(
      "DELETE FROM redirects WHERE entity_type='character' AND from_slug=?"
    ).bind(address).run();
  } catch { /* no redirects table yet */ }
  return true;
}

// Resolve whatever followed /c/ to a character row, and say where that page
// should canonically be read. Callers 301 when the reader arrived elsewhere.
async function resolveCharacterPath(env, key) {
  if (!key) return null;
  await ensureUrlSlugColumn(env);
  const cols = 'slug, url_slug, data, status, owner_id';
  const bySlug = async v => env.DB.prepare(`SELECT ${cols} FROM characters WHERE slug=?`)
    .bind(v).first().catch(() => null);
  const byAddr = async v => env.DB.prepare(`SELECT ${cols} FROM characters WHERE url_slug=?`)
    .bind(v).first().catch(() => null);

  let row = key.includes('/') ? await byAddr(key) : (await bySlug(key)) || (await byAddr(key));
  if (!row) {
    // An address this page used to live at. Redirect rows written since the
    // split hold the identity; the 39 written before it hold what was then
    // the new slug, which IS the identity — but try both, cheaply.
    const moved = await lookupRedirect(env, 'character', key);
    if (moved) row = (await bySlug(moved)) || (await byAddr(moved));
  }
  if (!row) return null;
  return { row, canonical: charAddress(row) };
}

// Move a character from one slug to another, taking everything that points at
// it along: comments, view counts, revisions, the activity log, admin page
// protection, its art in R2, and the slug lists inside scripts, collections
// and profile pins. Callers must have checked ownership and that `to` is free.
// Reports whether the art actually moved — art that is not in R2 (the
// bulk-imported pages point at committed files) keeps its old path.
//
// NOTE: identities do not move any more — an ordinary rename is an address
// change (setCharAddress) and never comes through here. This is kept for the
// one case that still moves a primary key: an admin deliberately re-keying a
// row. Everything it does is still correct, it is simply no longer on the
// path a creator's rename takes.
async function renameCharacter(env, from, to) {
  let artMoved = false;
  await env.DB.prepare('UPDATE characters SET slug=? WHERE slug=?').bind(to, from).run();

  // Per-page satellite tables. Each is optional (created on first use), and a
  // missing one must not strand a rename that already moved the page.
  const moves = [
    ['UPDATE comments SET slug=? WHERE entity_type=? AND slug=?', ['character']],
    ['UPDATE OR REPLACE page_views SET slug=? WHERE entity_type=? AND slug=?', ['character']],
    ['UPDATE revisions SET slug=? WHERE entity_type=? AND slug=?', ['character']],
    ['UPDATE activity_log SET entity_slug=? WHERE entity_type=? AND entity_slug=?', ['character']]
  ];
  for (const [sql, extra] of moves) {
    try { await env.DB.prepare(sql).bind(to, ...extra, from).run(); }
    catch { /* table not created yet, or column absent on an old row set */ }
  }
  // Admin page protection follows the page.
  try {
    await env.DB.prepare('UPDATE OR REPLACE settings SET key=? WHERE key=?')
      .bind(protectKey('character', to), protectKey('character', from)).run();
  } catch { /* not protected */ }

  // Art: move the R2 objects so /assets/art/{new}.png resolves, then point
  // the stored paths at them. Art that is not in R2 (committed files) stays
  // where it is and keeps its old path.
  const d = await env.DB.prepare('SELECT data FROM characters WHERE slug=?').bind(to).first().catch(() => null);
  let entry = d ? parseData(d) : null;
  if (entry) {
    // The editors always write .png, but an imported page may carry another
    // extension, so try what the row actually points at as well.
    const keys = new Set(['art/' + from + '.png',
      'art/' + from + '-alt.png', 'art/' + from + '-alt2.png']);
    /* Any suffixed art file, not just the two the editors write.
       retargetArtPaths below rewrites 'art/{from}' before ANY '-' or '.',
       so a stored path this loop failed to move was rewritten to a file
       that had not moved: a legacy row pointing at 'art/vampire-good.png'
       came out of a rename pointing at 'art/{new}-good.png', which does
       not exist. Move whatever the row actually names. */
    for (const k of ['art', 'artAlt', 'artAlt2']) {
      const v = typeof entry[k] === 'string'
        ? entry[k].replace(/^\/+/, '').replace(/^assets\//, '') : '';
      if (v.startsWith('art/' + from + '.') || v.startsWith('art/' + from + '-')) keys.add(v);
    }
    for (const key of keys) {
      if (await moveR2Object(env, key, key.replace('art/' + from, 'art/' + to))) artMoved = true;
    }
    entry.slug = to;
    entry.page = 'c/' + to + '.html';
    if (artMoved) retargetArtPaths(entry, from, to);
    await env.DB.prepare('UPDATE characters SET data=? WHERE slug=?')
      .bind(JSON.stringify(entry), to).run();
  }

  // Scripts list their roster by slug; collections keep manual include/exclude
  // slug lists. Rewrite the ones that named this page, or it silently drops
  // out of every script it was on.
  await rewriteSlugRefs(env, from, to);
  await rewriteProfilePins(env, from, to);

  // Remember the old address. Renaming A->B->C leaves both A and B pointing
  // at C rather than a chain, and a slug that is now a live page again can no
  // longer be a redirect.
  await ensureRedirectsTable(env);
  await env.DB.prepare(
    `INSERT INTO redirects (entity_type, from_slug, to_slug) VALUES ('character',?,?)
     ON CONFLICT(entity_type, from_slug) DO UPDATE SET to_slug=excluded.to_slug`
  ).bind(from, to).run();
  await env.DB.prepare(
    "UPDATE redirects SET to_slug=? WHERE entity_type='character' AND to_slug=?"
  ).bind(to, from).run();
  await env.DB.prepare(
    "DELETE FROM redirects WHERE entity_type='character' AND from_slug=?"
  ).bind(to).run();
  return { artMoved };
}

// Rewrite a character slug wherever another page stores it as a reference.
async function rewriteSlugRefs(env, from, to) {
  const swap = list => {
    if (!Array.isArray(list)) return { list, changed: false };
    let changed = false;
    const out = list.map(x => {
      if (String(x) !== from) return x;
      changed = true;
      return to;
    });
    return { list: out, changed };
  };
  try {
    const { results } = await env.DB.prepare(
      "SELECT slug, data FROM scripts WHERE data LIKE ?"
    ).bind('%"' + from + '"%').all();
    for (const row of results || []) {
      const d = parseData(row);
      const r = swap(d.characters);
      if (!r.changed) continue;
      d.characters = r.list;
      await env.DB.prepare('UPDATE scripts SET data=? WHERE slug=?')
        .bind(JSON.stringify(d), row.slug).run();
    }
  } catch { /* leave scripts alone rather than fail the rename */ }
  try {
    const { results } = await env.DB.prepare(
      "SELECT slug, data FROM collections WHERE data LIKE ?"
    ).bind('%"' + from + '"%').all();
    for (const row of results || []) {
      const d = parseData(row);
      let changed = false;
      for (const k of ['include', 'exclude']) {
        const r = swap(d[k]);
        if (r.changed) { d[k] = r.list; changed = true; }
      }
      if (!changed) continue;
      await env.DB.prepare('UPDATE collections SET data=? WHERE slug=?')
        .bind(JSON.stringify(d), row.slug).run();
    }
  } catch { /* same */ }
}

// Pinned pages on a creator profile are {type, slug} pairs.
async function rewriteProfilePins(env, from, to) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT id, profile_json FROM users WHERE profile_json LIKE ?'
    ).bind('%"' + from + '"%').all();
    for (const u of results || []) {
      const extra = parseProfileExtra(u);
      let changed = false;
      for (const p of extra.pinned) {
        if (p && p.type === 'character' && p.slug === from) { p.slug = to; changed = true; }
      }
      if (!changed) continue;
      await env.DB.prepare('UPDATE users SET profile_json=? WHERE id=?')
        .bind(JSON.stringify(extra), u.id).run();
    }
  } catch { /* pins are cosmetic; never fail a rename over them */ }
}

// ---- Curata inheritance ----
// A Curata collection lends the status to every character in it: awarding
// it to "Ravenswood Chronicle" marks all of Ravenswood's characters too, so
// the Curata filter on All Characters shows them. Inherited status is
// never written back to the character row — it is derived on read, so
// removing Curata from the collection takes it off the characters with
// it, and a character keeps its own flag if it was given one directly.
// `curataFrom` records which collection lent it, for the tooltip.
// The set of Curata collections, memoised per isolate against the content
// version. This used to be a full `collections` scan on EVERY /c/, /s/ and
// /collection/ view — a whole table read to answer a question whose answer
// changes only when an admin toggles the mark.
let _curataCollCache = null;
async function curataCollections(env) {
  const version = await contentVersion(env);
  if (_curataCollCache && _curataCollCache.version === version) return _curataCollCache.rows;
  let rows = [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT data FROM collections WHERE status='published'"
    ).all();
    rows = (results || []).map(parseData).filter(d => d && d.curata);
  } catch { rows = []; }
  _curataCollCache = { version, rows };
  return rows;
}

async function applyCollectionCurata(env, chars) {
  const colls = await curataCollections(env);
  if (!colls.length) return chars;
  for (const coll of colls) {
    const name = coll.displayName || coll.id || coll.slug || 'a collection';
    for (const c of PageRender.resolveCollectionMembers(coll, chars)) {
      if (c.curata) continue;              // its own flag wins
      // ...and the creator's refusal wins over both. A character whose owner
      // opted out is not lent the mark by the collection either, or the
      // opt-out would only work on pages no collection happened to cover.
      if (c.curataOptOut) continue;
      c.curata = true;
      c.curataFrom = name;
      c.classification = 'curata';
    }
  }
  return chars;
}

/* ---- "Appears in", derived from collection membership ----
   A collection lists members either by matching their own `appearsIn` text or
   by hand in `include[]`. The hand-listed half left the character page saying
   nothing about the collection it is in. This fills that on READ: a character
   with no `appearsIn` of its own picks up the collections that list it, in a
   separate `appearsInFrom` field.

   Separate on purpose. Writing it into `appearsIn` would feed the match rule
   that resolves membership in the first place, so one collection could start
   swallowing another's characters. Nothing is stored, so dropping a character
   from a collection takes the line off its page. */
let _inclCollCache = null;
async function includeCollections(env) {
  const version = await contentVersion(env);
  if (_inclCollCache && _inclCollCache.version === version) return _inclCollCache.rows;
  let rows = [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT data FROM collections WHERE status='published'"
    ).all();
    rows = (results || []).map(parseData)
      .filter(d => d && Array.isArray(d.include) && d.include.length)
      .map(d => ({
        name: d.displayName || d.id || d.slug || '',
        id: d.id || d.slug || '',
        include: d.include
      }))
      .filter(c => c.name && c.id);
  } catch { rows = []; }
  _inclCollCache = { version, rows };
  return rows;
}

const APPEARS_IN_MAX = 3;   // a character in more collections than this lists the first few
async function applyCollectionAppearsIn(env, chars) {
  const colls = await includeCollections(env);
  if (!colls.length) return chars;
  const bySlug = new Map();
  for (const coll of colls) {
    for (const slug of coll.include) {
      if (typeof slug !== 'string') continue;
      const list = bySlug.get(slug);
      if (!list) { bySlug.set(slug, [coll]); continue; }
      if (list.length < APPEARS_IN_MAX && !list.some(c => c.id === coll.id)) list.push(coll);
    }
  }
  for (const c of chars) {
    if (!c || (c.appearsIn && String(c.appearsIn).trim())) continue;
    const hit = bySlug.get(c.slug);
    if (hit) c.appearsInFrom = hit.map(x => ({ name: x.name, id: x.id }));
  }
  return chars;
}

// Curata was called Starlight until the rename, and rows written before it
// carry the flag under the old key. Folding the old key into the new one on
// READ is what makes the rename need no D1 migration: every reader sees
// `curata`, and the next save of a row writes the new key and drops the old
// one, so the database migrates itself a page at a time. Revision snapshots
// and R2 backups predate the rename too and are restored through the same
// path, so this has to stay even once every live row has been rewritten.
// Anything that parses a row's `data` itself must call this — parseData()
// does, and so does every raw JSON.parse of a `data` column below.
function foldLegacyCurata(d) {
  if (d && d.starlight !== undefined) {
    if (d.starlight && d.curata === undefined) d.curata = true;
    delete d.starlight;
  }
  return d;
}

// A row's `data` blob, or {} if the row is missing or the JSON is corrupt.
function parseData(row) {
  if (!row || !row.data) return {};
  try { return foldLegacyCurata(JSON.parse(row.data)); } catch { return {}; }
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

// A script's hand-arranged night order: {first: [slug], other: [slug]}, each
// list a set of roster slugs. Returns null when there is nothing worth
// storing, so an unarranged script keeps no key at all and sorts by the
// characters' own night numbers, exactly as it always did.
function sanitizeNightOrder(o) {
  if (!o || typeof o !== 'object') return null;
  const list = v => Array.isArray(v)
    ? [...new Set(v.slice(0, 200).map(x => String(x).slice(0, 80)).filter(Boolean))]
    : [];
  const out = { first: list(o.first), other: list(o.other) };
  if (!out.first.length) delete out.first;
  if (!out.other.length) delete out.other;
  return (out.first || out.other) ? out : null;
}

// A script's own jinx edits: {off: ["slugA|slugB"], add: [{a, b, text}]}.
// Nothing is written back to the characters: this is one script's view of the
// rules between them (see scriptJinxes in render-page.js).
function sanitizeJinxEdits(o) {
  if (!o || typeof o !== 'object') return null;
  const slug = v => String(v || '').slice(0, 80);
  const off = Array.isArray(o.off)
    ? [...new Set(o.off.slice(0, 200).map(k => String(k).slice(0, 165)).filter(k => k.includes('|')))]
    : [];
  const add = Array.isArray(o.add)
    ? o.add.slice(0, 100).map(j => ({
        a: slug(j && j.a), b: slug(j && j.b),
        text: String((j && j.text) || '').slice(0, 300)
      })).filter(j => j.a && j.b && j.a !== j.b)
    : [];
  const out = {};
  if (off.length) out.off = off;
  if (add.length) out.add = add;
  return (out.off || out.add) ? out : null;
}

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
  // Custom side boxes, same widget as the character editor's.
  if (o.customBoxes != null) {
    const boxes = sanitizeBoxes(o.customBoxes);
    if (boxes.length) o.customBoxes = boxes; else delete o.customBoxes;
  }
  const theme = PageRender.sanitizeTheme(o.theme, themeBase);
  if (theme) o.theme = theme; else delete o.theme;
}

// ---- validation for wiki pages (/p/{slug}) and news articles ----
// Same idea as sanitizePageFields: cap every text field, constrain images to
// the page's own R2 area, and run boxes/infobox/theme through the shared
// sanitizers. `imgBase` is the folder a page may put its own images in.
const WIKI_FIELD_CAPS = {
  title: 160, subtitle: 200, blurb: 300, author: 80, body: 60000
};
function sanitizeWikiFields(o, imgBase, themeBase) {
  for (const k of Object.keys(WIKI_FIELD_CAPS)) {
    if (o[k] != null) o[k] = String(o[k]).slice(0, WIKI_FIELD_CAPS[k]);
  }
  if (o.body != null) o.body = String(o.body).replace(/\r\n/g, '\n');
  // The banner sits in this page's own image slot, or nowhere.
  if (o.header != null) {
    const h = String(o.header);
    const ok = h === '' || (h.indexOf(imgBase) === 0 && h.indexOf('..') === -1 &&
      /^[a-z0-9/._ -]+\.(png|jpe?g|webp)$/i.test(h));
    o.header = ok ? h : '';
  }
  // Images the author uploaded for this page, so the editor can list them
  // again. Only this page's own slots, never someone else's.
  o.images = Array.isArray(o.images)
    ? o.images.slice(0, 40).map(x => String(x))
        .filter(s => s.indexOf(imgBase) === 0 && s.indexOf('..') === -1 &&
                     /^[a-z0-9/._ -]+\.(png|jpe?g|webp)$/i.test(s))
    : [];
  o.boxes = sanitizeBoxes(o.boxes);
  const info = sanitizeInfobox(o.infobox);
  if (info) o.infobox = info; else delete o.infobox;
  o.toc = o.toc !== false;
  o.comments = o.comments !== false;
  const theme = PageRender.sanitizeTheme(o.theme, themeBase);
  if (theme) o.theme = theme; else delete o.theme;
}

// ---- content version: the cache key for the JSON feeds ----
// The feeds used to be built from a full table scan on EVERY request and sent
// `no-store`, while all 17 client call sites added `?_=' + Date.now()` — so
// nothing cached anywhere, ever, and a homepage load meant reading every
// published row out of D1. D1 is a single Durable Object, so that is the first
// thing to queue up and fail under real traffic.
//
// A counter in `settings` fixes it: every content write bumps it, the feed
// caches under a key containing it, and a bump therefore invalidates by simply
// not matching any more. Old entries fall out on their own TTL.
// `max-age=0` so the BROWSER always revalidates: the owner reviews edits on the
// live site, and a page that waits a minute to show his own save is worse than
// the bandwidth is worth. Revalidation is nearly free — the Worker compares one
// ETag (a single indexed settings lookup) and returns an empty 304 without ever
// touching the content tables.
// `s-maxage=300` is the half that matters: the EDGE holds the built feed for
// five minutes, so the expensive full-table read is amortised across every
// visitor in that colo rather than paid per request. A content write bumps the
// version, which changes the cache key, so an edit is visible immediately
// regardless of the 300.
const FEED_CACHE_CONTROL = 'public, max-age=0, s-maxage=300, must-revalidate';
const CONTENT_VERSION_KEY = 'content_version';
const CONTENT_VERSION_CACHE_MS = 5000;
let _contentVersionCache = null;

async function contentVersion(env) {
  if (_contentVersionCache && (Date.now() - _contentVersionCache.at) < CONTENT_VERSION_CACHE_MS) {
    return _contentVersionCache.v;
  }
  let v = '0';
  try {
    const r = await env.DB.prepare('SELECT value FROM settings WHERE key=?')
      .bind(CONTENT_VERSION_KEY).first();
    if (r && r.value) v = String(r.value);
  } catch { /* settings unavailable -> behave as version 0 */ }
  _contentVersionCache = { at: Date.now(), v };
  return v;
}

// Called after anything that changes what the feeds would return. Never allowed
// to break the write it follows — a missed bump costs at most CACHE_TTL of
// staleness, a thrown error would cost the user their save.
async function bumpContentVersion(env) {
  try {
    await env.DB.prepare(
      `INSERT INTO settings (key,value) VALUES (?, '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(settings.value AS INTEGER) + 1 AS TEXT)`
    ).bind(CONTENT_VERSION_KEY).run();
  } catch { /* stale feed is survivable; a failed save is not */ }
  _contentVersionCache = null;
}

// ---- the almanac half of a character, dropped from the card feed ----
// These are the fields ONLY assets/render.js draws, i.e. only the server-rendered
// /c/ page ever needs them — and they are ~79% of characters.json's bytes
// (summaryBullets alone is 19%). Every browse/tag/team/search page was
// downloading all of it to draw thumbnails.
//
// This is deliberately an EXCLUDE list rather than an include list. An include
// list silently drops any field added later, and the consumers are spread over
// 17 files — assets/token-tool.js alone needs `reminders`, `remindersGlobal`,
// `setup`, `firstNight` and `otherNight`, none of which look like "card" fields.
// Excluding is fail-safe: a new field ships to everyone until it is proven big.
// Measured on the live corpus (606 published): dropping these takes
// characters.json from 465 KB gzipped to 154 KB — 38% of the full feed.
//
// NOT dropped, deliberately: firstNightReminder, otherNightReminder, jinxes,
// quote and flavor. They look like almanac prose, but buildSchema() in
// assets/render.js needs every one of them to emit official-schema JSON, and
// three client pages export that (all-characters.html's "Collection JSON",
// script.html and script-view.html). Dropping them would silently produce
// incomplete script JSON — the worst kind of breakage, because it looks fine.
// Removing them too would get the feed to 21% / 68 KB; that needs those three
// pages to lazily fetch ?fields=full when the reader actually opens the JSON
// box, which is the follow-up to this change.
//
// Also NOT dropped, and easy to mistake for card noise: artAlt/imageAlt and
// artAlt2/imageAlt2, a character's second and third icons (a traveller's good
// and evil tokens). assets/token-tool.js reads THIS feed and prints one token
// per version, and the card renderers fall back through them, so dropping them
// would silently print a traveller's evil token as its good one. The list used
// to carry a misspelled 'altArt', which matched no field anywhere in the repo
// and so was the only reason these survived at all — the real names are here
// on purpose now.
const CARD_DROP_FIELDS = new Set([
  'summaryBullets', 'tips', 'examples', 'howToRun', 'bluffing', 'fighting',
  'customBoxes', 'callout', 'pronunciation', 'ipa', 'respelling', 'custom'
]);

// ---- build the three JSON files from D1 (published pages only) ----
// `opts.includeDrafts` adds draft rows and stamps each row's `status`, for the
// admin-only ?drafts=1 form of the JSON feeds. Soft-deleted rows are never
// included either way — recovery is the dashboard's job.
// `opts.fields === 'card'` drops CARD_DROP_FIELDS. Characters only: collections
// and scripts are a few KB in total, so trimming them buys nothing and would
// risk the roster fields that /s/ and the script builder read.
async function buildPublicJSON(env, table, opts = {}) {
  const drafts = !!opts.includeDrafts;
  const cardOnly = opts.fields === 'card' && table === 'characters';
  const chars = table === 'characters';
  const where = drafts ? "status IN ('published','draft')" : "status='published'";
  // Characters carry their identity and their address from the row itself, so
  // every consumer gets both without either being able to drift: `slug` is the
  // PK (what references are keyed on) and `page` is built from `url_slug`
  // (what links go to). Twelve pages already link through `page`, which is why
  // this one line is most of the frontend's share of nesting.
  if (chars) await ensureUrlSlugColumn(env);
  const cols = chars ? 'data, status, slug, url_slug' : 'data, status';
  let results;
  try {
    ({ results } = await env.DB.prepare(`SELECT ${cols} FROM ${table} WHERE ${where}`).all());
  } catch {
    // status column not migrated yet -> serve everything (legacy behaviour)
    ({ results } = await env.DB.prepare(`SELECT data FROM ${table}`).all());
  }
  const type = table === 'characters' ? 'character'
    : table === 'collections' ? 'collection' : 'script';
  const out = results.map(r => {
    const d = foldLegacyCurata(JSON.parse(r.data));
    // Only the admin feed carries status; the public one must never imply
    // that unpublished pages exist.
    if (drafts) d.status = r.status || 'published';
    // The approved-editor list is the creator's own administration, not page
    // content, and it stores account ids. Nothing public reads it — the
    // editors load their page through /api/page — so it never goes on the
    // wire. `publicEdit` stays: it is one word and it gives nothing away.
    // Nothing renders it any more — a page's edit status moved out of the
    // reader's info box and onto its editing page — but the feed is a public
    // API, so dropping a field from it is a separate decision.
    delete d.editors;
    if (chars && r.slug) {
      d.slug = String(r.slug);
      // The address, derived on every read. The stored `page` is whatever some
      // editor wrote there years ago and is never trusted for a character.
      d.page = 'c/' + (r.url_slug ? String(r.url_slug) : String(r.slug));
    }
    // clean URLs: stored page paths end in .html, but the site serves them
    // extensionless now — strip it so every consumer links the clean form
    if (typeof d.page === 'string') d.page = d.page.replace(/\.html$/, '');
    // Partial/Standard/Curata is derived here rather than stored, so a
    // page re-classifies itself the moment its owner adds a tag or a line of
    // almanac text. `curata` is the only stored half (admin-set).
    // Classify.isCurata is the one answer, so a page whose creator opted out
    // (curataOptOut) leaves the feed with no mark at all rather than with a
    // flag every reader would have to re-check.
    if (Classify.isCurata(d)) d.curata = true; else delete d.curata;
    // NOTE: classify BEFORE trimming. Classify.classifyPage reads exactly the
    // prose fields the card feed drops (summaryBullets, howToRun, examples,
    // tips ...), so trimming first would flag every finished page as Partial.
    const cls = Classify.classifyPage(d, type);
    // Standard is the default everywhere, so the full feed leaves it off the
    // wire. The CARD feed cannot: the fields Classify reads are about to be
    // deleted, so a reader recomputing a trimmed row would call every
    // finished page Partial. Stamping 'standard' is what tells it not to
    // (Classify.isPartial trusts an explicit stamp over recomputing).
    if (cls !== 'standard') d.classification = cls;
    else if (cardOnly) d.classification = 'standard';
    else delete d.classification;
    if (cardOnly) for (const k of CARD_DROP_FIELDS) delete d[k];
    return d;
  });
  // Characters pick up Curata from any Curata collection they belong to,
  // and an "Appears in" from any collection that lists them by hand.
  if (table === 'characters') {
    await applyCollectionCurata(env, out);
    await applyCollectionAppearsIn(env, out);
  }
  return out;
}

// ---- D1 -> R2 backup (nightly cron + POST /api/backup) ----
// Dumps every content table to backups/{YYYY-MM-DD}/{table}.json in the ART
// bucket. backups/ is not in R2_PREFIXES, so the files are never publicly
// servable through /assets/. Keeps 30 days of snapshots.
// Read a backed-up table back in, across however many parts it was written to.
// Anything reading a backup MUST go through this rather than fetching
// `{table}.json` directly: that file is only the FIRST chunk once a table
// grows past BACKUP_CHUNK rows, so a direct read would quietly return a
// prefix of the table and report "not found" for anything after it.
async function readBackupTable(env, date, table) {
  if (!env.ART) return null;
  const first = await env.ART.get(`backups/${date}/${table}.json`);
  if (!first) return null;
  let rows;
  try { rows = await first.json(); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  for (let part = 1; ; part++) {
    const obj = await env.ART.get(`backups/${date}/${table}.part${part}.json`);
    if (!obj) break;
    try {
      const more = await obj.json();
      if (Array.isArray(more)) rows = rows.concat(more);
    } catch { break; }
  }
  return rows;
}

// Rows per backup part. Small enough that a chunk of the widest table
// (characters, ~3 KB of JSON per row) is a few MB rather than a few hundred.
const BACKUP_CHUNK = 2000;

async function runBackup(env) {
  if (!env.ART) throw new Error('R2 bucket (ART binding) is not configured.');
  const stamp = new Date().toISOString().slice(0, 10);
  const tables = ['characters', 'collections', 'scripts', 'pages', 'news', 'users', 'activity_log', 'settings', 'revisions', 'messages', 'page_views', 'dms', 'dm_blocks', 'dm_reports', 'comments', 'comment_reports'];
  const saved = {};
  const failed = {};
  for (const t of tables) {
    try {
      // Paged by rowid rather than SELECT *. The whole table used to be
      // materialised in the isolate and then stringified — two copies in a
      // 128 MB budget. `revisions` is the one that breaks first: 20 kept per
      // page means ~100k rows at a few KB each once the wiki has a few
      // thousand characters, which cannot be read into a Worker at all.
      let after = 0;
      let part = 0;
      let rows = 0;
      for (;;) {
        const { results } = await env.DB.prepare(
          `SELECT rowid AS _rid, * FROM ${t} WHERE rowid > ? ORDER BY rowid LIMIT ${BACKUP_CHUNK}`
        ).bind(after).all();
        const batch = results || [];
        if (!batch.length) break;
        after = batch[batch.length - 1]._rid;
        for (const r of batch) delete r._rid;
        const name = part === 0
          ? `backups/${stamp}/${t}.json`
          : `backups/${stamp}/${t}.part${part}.json`;
        await env.ART.put(name, JSON.stringify(batch), {
          httpMetadata: { contentType: 'application/json' }
        });
        rows += batch.length;
        part++;
        if (batch.length < BACKUP_CHUNK) break;
      }
      saved[t] = rows;
    } catch (e) {
      // A failure here used to be recorded as "skipped" and returned inside a
      // successful-looking result, so a backup that had silently stopped
      // working looked exactly like one that was fine. Record it as a failure,
      // and let the caller decide how loudly to say so.
      const msg = (e && e.message) || 'error';
      saved[t] = 0;
      failed[t] = msg;
      console.error(`[backup] ${stamp} ${t} FAILED: ${msg}`);
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
  const failedTables = Object.keys(failed);
  // Recorded in settings so the dashboard can show it. A cron backup runs
  // inside ctx.waitUntil() with nobody reading the return value, so without
  // this a broken nightly backup is invisible until the day it is needed.
  try {
    await env.DB.prepare(
      `INSERT INTO settings (key,value) VALUES ('last_backup',?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    ).bind(JSON.stringify({
      date: stamp, at: new Date().toISOString(),
      ok: failedTables.length === 0, failed
    })).run();
  } catch { /* the backup itself matters more than the bookkeeping */ }
  return { date: stamp, saved, failed, ok: failedTables.length === 0 };
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

function redirectResponse(location, cookie, extraHeaders) {
  const headers = new Headers({ Location: location });
  if (cookie) headers.append('Set-Cookie', cookie);
  for (const [k, v] of Object.entries(extraHeaders || {})) headers.set(k, v);
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
  // o: {title, desc, canonicalUrl, ogImage, ogCard, body, bodyClass,
  //     bodyStyle, mainClass, mainStyle, bootstrap, scripts[], draftBanner,
  //     noindex, root}
  // `root` is how far up the site root is from this page's URL. Every path in
  // the shell is relative, and all of /s/, /collection/, /news/ and /p/ sit
  // one level deep, so it defaults to '../'. Character addresses are nested
  // (/c/{set}/{character}) and pass '../../' — without it the stylesheet, the
  // logo and every nav link on a character page resolve inside /c/.
  // `noindex` keeps a page out of search engines — used by the custom wiki
  // pages, which are reachable only from their parent page and their author's.
  // The nav row is identical on every page (built into the shell below);
  // site.js appends Tools + the Account/Login button, and moves the
  // Edit button to the end of the row on editable pages.
  const R = o.root || '../';
  const bodyAttrs = (o.bodyClass ? ' class="' + attr(o.bodyClass) + '"' : '') +
    (o.bodyStyle ? ' style="' + attr(o.bodyStyle) + '"' : '');
  const mainAttrs = ' class="wrap' + (o.mainClass ? ' ' + attr(o.mainClass) : '') + '"' +
    (o.mainStyle ? ' style="' + attr(o.mainStyle) + '"' : '');
  return `<!DOCTYPE html>
<html lang="en" class="redesign-on">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${attr(o.title)} — BOTC HomeBrew Wiki</title>
<meta name="description" content="${attr(o.desc)}">
${o.noindex ? '<meta name="robots" content="noindex, nofollow">\n' : ''}<link rel="canonical" href="${attr(o.canonicalUrl)}">
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
<link rel="icon" type="image/png" sizes="64x64" href="${R}assets/favicon.png">
<link rel="apple-touch-icon" href="${R}assets/favicon.png">
<link rel="stylesheet" href="${R}assets/styles.css">
<link rel="stylesheet" href="${R}assets/header-redesign.css">
</head>
<body${bodyAttrs}>
${o.draftBanner || ''}
  <header class="topbar">
    <div class="brand-group">
      <a class="brand" href="${R}">
        <img class="brand-skull" src="${R}assets/logo_skull.png" alt="">
        <img class="brand-header-text" src="${R}assets/headertext.png" alt="BOTC HomeBrew Wiki">
      </a>
      <img class="topbar-badge" src="${R}assets/ccc-parchment.png" alt="Community Created Content">
      <a class="edit-link" id="edit-btn" style="display:none" href="#">&#9998; Edit</a>
    </div>
    <nav class="crumb" aria-label="Primary">
      <a href="${R}all-characters">All Characters</a>
      <a href="${R}scripts">Scripts</a>
      <a href="${R}all-collections">Collections</a>
      <a href="${R}script">Script Builder</a>
    </nav>
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
  <a href="${R}">Home</a>
  <a href="${R}all-characters">All Characters</a>
  <a href="${R}scripts">Scripts</a>
  <a href="${R}all-collections">Collections</a>
  <a href="${R}script">Script Builder</a>
</nav>

  <main${mainAttrs} id="content">${o.body}</main>

  <p class="foot">Fan-made content for <em>Blood on the Clocktower</em> &middot; Not affiliated with The Pandemonium Institute</p>

  <script>${o.bootstrap || ''}</script>
${(o.scripts || []).map(s => '  <script src="' + R + 'assets/' + s + '"></script>').join('\n')}
</body>
</html>`;
}

// The "this page is Partial" nudge. Only ever rendered for someone who can
// edit the page (owner or admin) — a reader has no use for it, and the wiki
// does not advertise which pages its authors haven't finished.
// Dismissal lives in the reader's own localStorage, so the server cannot know
// about it. This runs inline, immediately after the notice, purely so a banner
// the owner already closed never paints — putting it in site.js (which loads at
// the end of the body) would flash it on every visit, which is the exact
// annoyance the close button exists to remove. The click handler, and the
// writing of this key, stay in site.js where behaviour belongs.
const PARTIAL_PREHIDE =
  '<script>(function(){try{' +
  'var n=document.currentScript&&document.currentScript.previousElementSibling;' +
  'if(!n||!n.classList.contains("page-notice-partial"))return;' +
  'var m=JSON.parse(localStorage.getItem("botc_partial_dismissed")||"{}");' +
  'if(m[n.getAttribute("data-partial-slug")]===n.getAttribute("data-partial-sig"))n.remove();' +
  '}catch(e){}})();<\/script>';

function partialNoticeHTML(d, root) {
  const R = root || '../';
  const bits = Classify.missingBits(d);
  const missing = Classify.listPhrase(bits);
  // data-partial-sig is what is still outstanding. Dismissal is remembered
  // against it, so closing the notice silences THIS gap — fill part of it in
  // and the notice comes back for whatever is left, the same way a new
  // announcement reappears after the old one was dismissed.
  return '<div class="page-notice page-notice-partial" role="status"' +
    ' data-partial-slug="' + attr(d.slug) + '"' +
    ' data-partial-sig="' + attr(bits.join('|')) + '">' +
    '<strong>' + SYS.partialLabel + '</strong> ' + SYS.partialBody +
    (missing ? ' ' + SYS.partialFix.replace('{missing}', escapeHtml(missing)) : '') +
    ' <a href="' + R + 'edit?c=' + attr(d.slug) + '">' + SYS.partialEdit + '</a>' +
    '<button type="button" class="page-notice-close" aria-label="' +
    attr(SYS.partialDismiss) + '">&times;</button>' +
    '</div>' + PARTIAL_PREHIDE;
}

// The creator page is one static file (profile.html) served under two paths:
// /u/{username} and /author?a=Name. It reads the key off location itself.
async function serveProfileShell(env, request, url) {
  const res = await env.ASSETS.fetch(new Request(url.origin + '/profile.html'));
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' }
  });
}

function renderCharacterPage(d, origin, isDraft, showPartialNotice) {
  const name = d.name || 'Character';
  // The lede takes the wiki's link and colour marks now, and a search result
  // or a Discord unfurl has nowhere to render one — so the description is the
  // same sentence with the syntax taken back out. (The ability is escaped on
  // the page and carries no marks, so this costs it nothing.)
  const desc = WikiRender.plainText((d.ability || d.lede || '').trim());
  // d.page is the address the /c/ route resolved; d.slug is the identity and
  // is only the address for a row the backfill has not reached.
  const pageUrl = origin + '/' + String(d.page || ('c/' + d.slug)).replace(/^\//, '');
  // Every path in the shell and the body is relative, and a nested address
  // (/c/{set}/{character}) is one level deeper than the flat one this page
  // used to have. Count the depth off the address rather than assuming it.
  const depth = String(d.page || ('c/' + d.slug)).replace(/^\//, '').split('/').length - 1;
  const root = '../'.repeat(Math.max(1, depth));
  const imgRaw = Array.isArray(d.image) ? d.image[0] : d.image;
  const img = imgRaw || (origin + '/assets/' + (d.art || ''));
  // bulk-imported characters may only have a remote image URL, no local art.
  // The art path is relative like everything else in the page, so it has to use
  // the SAME computed root: a hardcoded '../' pointed a nested address at
  // /c/{set}/assets/art/... and every icon on the wiki broke the moment the
  // backfill nested the URLs.
  const artSrc = d.art ? root + 'assets/' + d.art : (imgRaw || '');
  // Stamped here too (not just in characters.json) so the Curata mark in
  // the info box is right on a page reached directly.
  d.classification = Classify.classifyCharacter(d);
  const body = Render.renderCharacter(d, artSrc, root);
  const draftBanner = (isDraft
    ? '<div style="background:#7a5c18;color:#f7ecd0;text-align:center;padding:10px 16px;font-family:\'TradeGothicLT\',\'Libre Franklin\',sans-serif;letter-spacing:.04em">' + SYS.draftPage + ' <a href="' + root + 'edit?c=' + attr(d.slug) + '" style="color:#ffe9ad">' + SYS.draftEditorLink + '</a>.</div>'
    : '') + (showPartialNotice ? partialNoticeHTML(d, root) : '');
  return pageShell({
    title: name, desc, canonicalUrl: pageUrl, ogImage: img, ogCard: 'summary',
    body, draftBanner, root,
    bootstrap: `window.SSR = true; window.LINK_ROOT = ${JSON.stringify(root)}; window.CHAR_SLUG = ${JSON.stringify(d.slug)};` +
      ` window.PAGE_TYPE = 'character'; window.PAGE_SLUG = ${JSON.stringify(d.slug)};`,
    scripts: ['render.js', 'tags.js', 'charpage.js', 'comments.js', 'site.js']
  });
}

// ---- official BotC roles (assets/roles.json), for script rosters that
// include imported official characters ('off-' slugs). Cached per isolate.
// Wake positions come from assets/night-order.json; roles.json has none, which
// is why an official character used to be missing from a script page's Night
// Order box. Both are fetched as static assets rather than imported, so
// neither rides in the Worker bundle, and a night-order.json that fails to
// load costs the positions and nothing else.
let _officialRolesCache = null;
async function loadOfficialRoles(env, origin) {
  if (_officialRolesCache) return _officialRolesCache;
  try {
    const [rolesRes, nightRes] = await Promise.all([
      env.ASSETS.fetch(new Request(origin + '/assets/roles.json')),
      env.ASSETS.fetch(new Request(origin + '/assets/night-order.json')).catch(() => null)
    ]);
    const roles = await rolesRes.json();
    let night = null;
    try { night = nightRes ? await nightRes.json() : null; } catch { night = null; }
    // The non-character steps of the night (dusk, minion info, demon info,
    // dawn): what an exported script needs to write a night sequence the
    // official app can follow. Without them the export leaves the sequence
    // out rather than publish one those steps are missing from.
    if (night && night.meta) PageRender.setNightMeta(night.meta);
    _officialRolesCache = OfficialRoles.buildOfficialRoles(roles, night);
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

// Map of slugId(id/name) -> official display name. Jinx names are typed by
// hand, so the wiki holds "leviathan" and "plaguedoctor" where it means
// Leviathan and Plague Doctor; resolveJinxTarget() uses this to print the
// real name whenever the target turns out to be an official character.
let _officialNameMapCache = null;
async function officialNameMap(env, origin) {
  if (_officialNameMapCache) return _officialNameMapCache;
  const m = {};
  for (const r of await loadOfficialRoles(env, origin)) {
    if (!r.name) continue;
    m[Render.slugId(r.id)] = r.name;
    m[Render.slugId(r.name)] = r.name;
  }
  _officialNameMapCache = m;
  return m;
}

// The two registries [[Character Name]] resolves through, set together
// because the ORDER between them is the rule: an official character beats a
// homebrew page of the same name (see setOfficialNames in render-wiki.js).
// Setting the char links without the roster would quietly send [[Imp]] to
// whichever homebrew Imp this wiki happens to hold, so they go in one call.
// The /c/ route is the exception and does not need it: Render.setOfficialNames
// forwards into the engine, and that route already calls it for the jinx box.
async function setWikiTextRegistries(env, origin, links) {
  WikiRender.setCharLinks(links);
  WikiRender.setOfficialNames(await officialNameMap(env, origin).catch(() => ({})));
}

// Jinxes between two OFFICIAL characters (assets/official-jinxes.json). An
// opt-in layer on /jinxes rather than part of the default picture: the
// homebrew map reads fine without them. Cached per isolate.
let _officialJinxCache = null;
async function loadOfficialJinxes(env, origin) {
  if (_officialJinxCache) return _officialJinxCache;
  try {
    const res = await env.ASSETS.fetch(new Request(origin + '/assets/official-jinxes.json'));
    const doc = await res.json();
    _officialJinxCache = Array.isArray(doc && doc.jinxes) ? doc.jinxes : [];
  } catch {
    _officialJinxCache = [];
  }
  return _officialJinxCache;
}

// ---- the jinx index ----------------------------------------------------
// Every jinx on the wiki as one edge list, plus the character rows needed to
// draw them. Two callers, neither of which can afford its own table scan: a
// /c/ page needs the jinxes OTHER characters declare with it (a jinx is stored
// on one side only), and /jinxes draws the whole graph.
//
// Cached like the JSON feeds: in-isolate and in caches.default, under a key
// carrying contentVersion(), which logActivity() bumps on every content write.
// Cold cost is one card-feed read.
let _jinxIndexCache = null;      // { version, index }
async function jinxIndex(env, ctx) {
  const version = await contentVersion(env);
  if (_jinxIndexCache && _jinxIndexCache.version === version) return _jinxIndexCache.index;

  const cacheKey = new Request(`https://feed.internal/jinx-index.json?v=${version}`, { method: 'GET' });
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) {
      const index = await hit.json();
      _jinxIndexCache = { version, index };
      return index;
    }
  } catch { /* cache miss is not an error */ }

  const rows = await buildPublicJSON(env, 'characters', { fields: 'card' });
  const index = buildJinxIndex(rows);
  _jinxIndexCache = { version, index };
  try {
    const stored = new Response(JSON.stringify(index), {
      headers: { ...JSON_HEADERS, 'Cache-Control': FEED_CACHE_CONTROL }
    });
    if (ctx) ctx.waitUntil(caches.default.put(cacheKey, stored).catch(() => {}));
  } catch { /* the in-isolate copy is enough */ }
  return index;
}

// The jinx list a /c/ page shows: its own, plus every jinx another character
// declares with it, pointed back the other way. A mirrored entry carries
// `mirrored` so the renderer can say which page stores (and so owns) it.
// A pair both sides declare is shown once, and the character's own entry wins.
function mergeMirroredJinxes(d, slug, jx) {
  const own = Array.isArray(d.jinxes) ? d.jinxes.filter(j => j && (j.name || j.id || j.slug)) : [];
  const inbound = (jx.bySlug && jx.bySlug[slug]) || [];
  if (!inbound.length) return own;

  // What this page already points at, so a mutual jinx is not listed twice.
  const claimed = new Set();
  for (const j of own) {
    const k = (j.slug && Render.normJinxId(j.slug)) ||
      Render.normJinxId(j.id || Render.slugId(j.name || ''));
    if (k) claimed.add(k);
  }

  const out = own.slice();
  for (const e of inbound) {
    const other = jx.rows[e.from];
    if (!other) continue;
    if (claimed.has(Render.normJinxId(other.slug)) ||
        claimed.has(Render.normJinxId(other.name))) continue;
    out.push({
      slug: other.slug, name: other.name, align: e.align, text: e.text,
      mirrored: true, mirroredFrom: { slug: other.slug, name: other.name, page: other.page || '' }
    });
  }
  return out;
}

// Pure, so it can be reasoned about (and tested) without a database.
// `chars` -> { chars: {key: row}, bySlug: {slug: [edge]}, edges: [edge] }.
function buildJinxIndex(chars) {
  // Keyed by identity, by name and by set (Render.jinxCharIndex owns that
  // order — the set-qualified keys are what tells two homebrew characters of
  // the same name apart, and they claim only what is still free). The compact
  // row is all a jinx list needs; carrying the whole character would put the
  // entire corpus in the cache entry.
  const bySlugRow = {};
  const { byKey } = Render.jinxCharIndex(chars, c => (bySlugRow[c.slug] = {
    slug: c.slug, name: c.name || c.slug, team: c.team || '',
    art: c.art || '', image: typeof c.image === 'string' ? c.image : '',
    creator: c.creator || '',
    // The address. `slug` stays the identity, which is what edges and
    // the mirroring are keyed on; this is only ever used to build a link.
    page: typeof c.page === 'string' ? c.page : ''
  }));

  const edges = [];
  const bySlug = {};                // slug -> edges where it is the TARGET
  const seen = new Set();
  for (const c of chars || []) {
    if (!c || !c.slug || !Array.isArray(c.jinxes)) continue;
    for (const j of c.jinxes) {
      if (!j || !(j.name || j.id || j.slug)) continue;
      // The keys this entry names its target by, most specific first: the id
      // as written, then the name qualified by a set THIS character is filed
      // under, then the bare name (Render.jinxLookupKeys). An explicit slug
      // from the picker skips all of it.
      const picked = Render.normJinxId(j.slug || '');
      let key = picked && byKey[picked] ? picked : '';
      if (!key) {
        for (const k of Render.jinxLookupKeys(j, c)) {
          if (byKey[k]) { key = k; break; }
        }
      }
      // Nothing on the wiki answers to it (an official character, a draft, a
      // typo): the edge still records what it was pointing at.
      if (!key) key = Render.normJinxId(j.id || Render.slugId(j.name || ''));
      const target = byKey[key];
      // A page jinxed with itself is a data slip, not a relationship.
      if (target && target.slug === c.slug) continue;
      const text = j.text || j.reason || '';
      // One edge per unordered pair per rule text, matching findScriptJinxes.
      const pairKey = [c.slug, target ? target.slug : key].sort().join('|') + '|' + text;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      const edge = {
        from: c.slug,
        to: target ? target.slug : '',
        key,
        name: j.name || '',
        id: j.id || '',
        align: j.align === 'evil' ? 'evil' : 'good',
        text
      };
      edges.push(edge);
      if (target) {
        (bySlug[target.slug] = bySlug[target.slug] || []).push(edge);
      }
    }
  }
  return { chars: byKey, rows: bySlugRow, bySlug, edges };
}

// ---- character data for the SSR script/collection pages ----
// These pages used to call buildPublicJSON(env, 'characters') outright, which
// meant every single /s/ and /collection/ view read and parsed the ENTIRE
// characters table — a twelve-character script paying for five thousand rows —
// plus a second full scan of collections for Curata. Three fixes:
//
//  1. A script only ever needs its own roster, so fetch exactly those slugs.
//  2. A collection genuinely has to look at every character (membership is
//     matched on `appearsIn`, not stored), but it only needs card fields, and
//     the result is memoised per isolate against the content version.
//  3. The [[Character Name]] link map needs every name, but only name+slug —
//     never the data blob. That is its own cheap, separately cached query.

let _cardCharsCache = null;
async function cachedCardChars(env) {
  const version = await contentVersion(env);
  if (_cardCharsCache && _cardCharsCache.version === version) return _cardCharsCache.rows;
  const rows = await buildPublicJSON(env, 'characters', { fields: 'card' });
  _cardCharsCache = { version, rows };
  return rows;
}

let _charLinkCache = null;
async function cachedCharLinkMap(env) {
  const version = await contentVersion(env);
  if (_charLinkCache && _charLinkCache.version === version) return _charLinkCache.map;
  const map = {};
  const nkey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  try {
    await ensureUrlSlugColumn(env);
    const { results } = await env.DB.prepare(
      "SELECT slug, url_slug, name FROM characters WHERE status='published'"
    ).all();
    for (const r of results || []) {
      // The ADDRESS: render-wiki turns this into `c/{value}`.
      const addr = charAddress(r);
      if (r.slug) map[nkey(r.slug)] = addr;
      if (r.name) map[nkey(r.name)] = addr;
    }
  } catch { /* an empty map just means [[Name]] renders as a plain token */ }
  _charLinkCache = { version, map };
  return map;
}

// Just the roster, for a script page. D1 caps bound parameters at 100, and a
// script's roster is capped at 100 entries, so chunk at 90 for headroom.
async function charsBySlug(env, slugs) {
  const wanted = [...new Set((slugs || []).map(String).filter(Boolean))];
  if (!wanted.length) return [];
  const out = [];
  for (let i = 0; i < wanted.length; i += 90) {
    const chunk = wanted.slice(i, i + 90);
    const marks = chunk.map(() => '?').join(',');
    try {
      const { results } = await env.DB.prepare(
        `SELECT data, status FROM characters
          WHERE status='published' AND slug IN (${marks})`
      ).bind(...chunk).all();
      for (const r of results || []) {
        try {
          const d = foldLegacyCurata(JSON.parse(r.data));
          if (typeof d.page === 'string') d.page = d.page.replace(/\.html$/, '');
          const cls = Classify.classifyPage(d, 'character');
          if (cls !== 'standard') d.classification = cls;
          out.push(d);
        } catch { /* skip an unparseable row rather than 500 the page */ }
      }
    } catch { /* a transient failure: better a short roster than a 500 */ }
  }
  // buildPublicJSON used to do this for us. A character on a Curata
  // collection carries the mark onto every page it appears on, so a roster
  // built by slug has to inherit it too or the mark would vanish on script
  // pages only. Cheap now that the collection set is memoised.
  await applyCollectionCurata(env, out);
  return out;
}

/* ---- the export JSON as a real file ----
   GET /api/page-json?type=script|collection&slug=…

   The Download JSON button on /s/ and /collection/ used to be an <a href="#">
   that JavaScript turned into a blob: URL after the page loaded. That works
   until it doesn't: if the script has not run yet, failed, or was blocked by
   an extension, the bare "#" is what the click gets, and the page silently
   jumps to the top instead of saving anything — which is exactly what a
   reader reports as "the download button does nothing", with no error to see
   and nothing to tell them the file was never attached.

   The server already builds this JSON to render the page, so the button can
   just be a link to it. No script, no blob, no lifetime to manage: it works
   with JavaScript off, survives a long-press "save link as", and can be
   pasted to somebody. Same visibility rules as the page it belongs to — a
   draft's JSON is for whoever may edit it, and a deleted page has none.

   Content-Disposition is what makes it save rather than display; the filename
   is the page's own slug, as the blob version named it. */
async function pageJsonResponse(env, request, url) {
  const type = url.searchParams.get('type') === 'collection' ? 'collection' : 'script';
  const slug = String(url.searchParams.get('slug') || '');
  if (!slug) return jsonResponse({ error: 'Missing slug' }, { status: 400 });
  const isScript = type === 'script';
  const table = isScript ? 'scripts' : 'collections';
  let row = await env.DB.prepare(`SELECT slug, data, status, owner_id FROM ${table} WHERE slug=?`)
    .bind(slug).first().catch(() => null);
  if (!isScript && !row) row = await findCollectionRow(env, slug);
  if (!row || !row.data || row.status === 'deleted') {
    return jsonResponse({ error: 'Not found' }, { status: 404 });
  }
  const d = foldLegacyCurata(JSON.parse(row.data));
  if (!d.slug) d.slug = row.slug || slug;
  if (row.status === 'draft') {
    const sess = await getSession(env, request);
    if (!(canEditRow(sess, row) || await canEditPage(env, sess, type, row))) {
      return jsonResponse({ error: 'Not found' }, { status: 404 });
    }
  }
  let chars = isScript
    ? await charsBySlug(env, d.characters || [])
    : await cachedCardChars(env);
  if (isScript && ((d.characters || []).some(x => String(x).indexOf('off-') === 0) || d.nightOrder)) {
    const official = await loadOfficialRoles(env, url.origin);
    chars = chars.concat(official.filter(c => (d.characters || []).includes(c.slug)));
  }
  const name = (isScript ? d.name : (d.displayName || d.slug)) || 'Untitled';
  const entries = isScript
    ? (d.characters || []).map(x => chars.find(c => c.slug === x)).filter(Boolean)
    : PageRender.sortCollectionMembers(d, PageRender.resolveCollectionMembers(d, chars));
  const text = PageRender.buildPageExport(name, d.author, d.header, entries, isScript ? d : undefined);
  const file = (isScript ? d.slug : (d.id || d.slug) || 'page').replace(/[^a-z0-9._-]+/gi, '-');
  return new Response(text, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + file + '.json"',
      'Cache-Control': 'no-store'
    }
  });
}

// ---- shared SSR for /s/{slug} and /collection/{id} pages ----
async function renderContentPage(env, ctx, request, url, type, slug) {
  const isScript = type === 'script';
  const table = isScript ? 'scripts' : 'collections';
  let row = null;
  try {
    row = await env.DB.prepare(`SELECT slug, data, status, owner_id FROM ${table} WHERE slug=?`)
      .bind(slug).first();
  } catch {
    row = await env.DB.prepare(`SELECT slug, data FROM ${table} WHERE slug=?`).bind(slug).first();
  }
  if (!isScript && !row) row = await findCollectionRow(env, slug);
  if (!row || !row.data) return assetsOrNotFound(env, request);

  // Soft-deleted pages are hidden from everyone; recovery is on the dashboard.
  if (row.status === 'deleted') return assetsOrNotFound(env, request);

  // One session read serves both the draft check and the "may this reader see
  // draft wiki pages / the new-page button" check further down.
  const pageSess = await getSession(env, request);
  // Ownership. It gates the wiki-page half of this page: listing a parent's
  // draft pages, and the button that writes a new one, both need the parent's
  // OWNER (that is what /api/wiki-page enforces), so an approved editor must
  // not be offered either.
  const mayEditParent = canEditRow(pageSess, row);
  // Ownership or an approved editor: what this reader may do to the page
  // itself. That is the draft gate and the Edit button.
  const mayEditPage = mayEditParent || await canEditPage(env, pageSess, type, row);
  const isDraft = row.status === 'draft';
  if (isDraft && !mayEditPage) return assetsOrNotFound(env, request); // 404 for everyone else
  if (!isDraft && ctx) ctx.waitUntil(bumpView(env, request, type, row.slug || slug));
  const d = foldLegacyCurata(JSON.parse(row.data));
  if (!d.slug) d.slug = row.slug || slug;

  // A script knows its roster by slug, so it never needs the rest of the
  // table. A collection's membership is matched on `appearsIn` at read time,
  // so it does — but from the memoised card feed, not a fresh full parse.
  let chars = isScript
    ? await charsBySlug(env, d.characters || [])
    : await cachedCardChars(env);
  // Scripts can carry imported official roles ('off-' slugs), so resolve them.
  // An arranged night order needs this call on an all-homebrew script too: it
  // is what loads the night's non-character steps.
  if (isScript && ((d.characters || []).some(s => String(s).indexOf('off-') === 0) || d.nightOrder)) {
    const official = await loadOfficialRoles(env, url.origin);
    chars = chars.concat(official.filter(c => (d.characters || []).includes(c.slug)));
  }

  const themeBase = isScript ? ('scripts/' + d.slug) : ('collections/' + (d.id || d.slug));
  const theme = PageRender.sanitizeTheme(d.theme, themeBase);
  const ta = PageRender.themeAttrs(theme, '../');

  const name = (isScript ? d.name : (d.displayName || d.slug)) || 'Untitled';

  // Custom wiki pages hanging off this script/collection. They live nowhere
  // else on the site, so this list is the only way in (besides the author's
  // page). Drafts show only to whoever may edit them.
  const wikiPages = await listWikiPages(env, type, row.slug || slug, { includeDrafts: mayEditParent });
  const pagesHTML = WikiRender.renderPageLinks(wikiPages, { linkRoot: '../' });
  // [[Character Name]] inside a custom box links to that character. This needs
  // EVERY character's name, not just the ones on this page, so it cannot come
  // from `chars` on a script page — but it only needs name+slug, so it is its
  // own cheap cached query rather than a reason to load the whole corpus.
  await setWikiTextRegistries(env, url.origin, await cachedCharLinkMap(env));
  const boxesHTML = WikiRender.renderBoxes(d.customBoxes, { linkRoot: '../' });
  const pageKey = isScript ? d.slug : (d.id || d.slug);
  const newPageHref = mayEditParent
    ? '../publish-page?parentType=' + encodeURIComponent(type) + '&parentSlug=' + encodeURIComponent(pageKey)
    : '';

  const editHref = isScript
    ? '../publish-script?s=' + encodeURIComponent(d.slug)
    : '../publish-collection?c=' + encodeURIComponent(d.id || d.slug);
  // The page's own Edit button, gated: it sits in the page, where a reader
  // would take it as an invitation. (The top-bar pencil shows unconditionally;
  // the API is the enforcer.) SSR responses are no-store, so this is safe.
  const ownerEditHref = mayEditPage ? editHref : '';

  const body = isScript
    ? PageRender.renderScriptPage(d, chars, { linkRoot: '../', isDraft, pagesHTML, boxesHTML, newPageHref, editHref: ownerEditHref })
    : PageRender.renderCollectionPage(d, chars, { linkRoot: '../', isDraft, pagesHTML, boxesHTML, newPageHref, editHref: ownerEditHref });

  const nChars = isScript
    ? (d.characters || []).length
    : PageRender.resolveCollectionMembers(d, chars).length;
  const desc = (d.tagline || '').trim() || (d.description || '').trim() ||
    (nChars + '-character homebrew ' + (isScript ? 'script' : 'collection') +
     ' for Blood on the Clocktower' + (d.author ? ', by ' + d.author : '') + '.');
  const canonical = url.origin + (isScript ? '/s/' : '/collection/') + encodeURIComponent(isScript ? d.slug : (d.id || d.slug));
  const img = url.origin + '/assets/' + (d.header || d.logo || 'logo_skull.png');
  const draftBanner = isDraft
    ? '<div style="background:#7a5c18;color:#f7ecd0;text-align:center;padding:10px 16px;font-family:\'TradeGothicLT\',\'Libre Franklin\',sans-serif;letter-spacing:.04em">' + SYS.draftPage + ' <a href="' + attr(editHref) + '" style="color:#ffe9ad">' + SYS.draftEditorLink + '</a>.</div>'
    : '';

  const html = pageShell({
    title: (isDraft ? 'Draft: ' : '') + name, desc, canonicalUrl: canonical,
    ogImage: img, ogCard: d.header ? 'summary_large_image' : 'summary',
    body, draftBanner,
    bodyClass: ta.cls, bodyStyle: ta.style,
    bootstrap: `window.SSR = true; window.LINK_ROOT = '../'; window.PAGE_TYPE = ${JSON.stringify(type)}; window.PAGE_SLUG = ${JSON.stringify(isScript ? d.slug : (d.id || d.slug))};`,
    // sao.js before card-filters.js: the filter box only builds its Steven
    // Approved Order option when window.saoCompare is already there.
    scripts: isScript
      ? ['render.js', 'pageview.js', 'comments.js', 'site.js']
      : ['render.js', 'pageview.js', 'sao.js', 'card-filters.js', 'comments.js', 'site.js']
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
    'SELECT slug, display_name AS name, owner_id, status, data, created_at, updated_at FROM collections WHERE slug=?'
  ).bind(key).first().catch(() => null);
  if (hit) return hit;
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const nkey = norm(key);
  const { results } = await env.DB.prepare(
    'SELECT slug, display_name AS name, owner_id, status, data, created_at, updated_at FROM collections'
  ).all().catch(() => ({ results: [] }));
  for (const row of results || []) {
    try {
      const d = foldLegacyCurata(JSON.parse(row.data));
      if (d.id === key || norm(d.id) === nkey || norm(row.slug) === nkey || norm(d.displayName) === nkey) return row;
    } catch { /* skip bad rows */ }
  }
  return null;
}

// ---- Discord OAuth helpers ----
function discordConfigured(env) {
  return !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);
}

// The site's canonical origin. Every hostname Cloudflare answers on serves the
// whole wiki — the apex, www, any workers.dev or preview name — and the OAuth
// flow used to build its redirect_uri from whichever one the reader happened to
// arrive on. Discord only accepts a redirect_uri that is registered on the
// application *character for character*, so a reader on www got
// "Invalid OAuth2 redirect_uri" and no way to sign in, while the apex kept
// working: the login was broken for some people and fine for others.
//
// So the flow is pinned to ONE origin instead. DISCORD_REDIRECT_URI (or
// SITE_ORIGIN) overrides it if the domain ever changes, but nothing about the
// incoming request does — that is the whole point. Change this and you must
// add the new callback URL in the Discord Developer Portal (OAuth2 ->
// Redirects) in the same breath, or sign-in stops for everybody.
const CANONICAL_ORIGIN = 'https://botchomebrew.wiki';

function canonicalOrigin(env) {
  const raw = (env && (env.SITE_ORIGIN || '')).trim();
  if (raw) { try { return new URL(raw).origin; } catch { /* fall through */ } }
  return CANONICAL_ORIGIN;
}

// The one redirect_uri, used BOTH when sending the reader to Discord and when
// exchanging the code afterwards. Discord compares the two, so they have to be
// produced by the same function — never one from a constant and one from the
// request.
function discordRedirectUri(env) {
  const raw = (env && (env.DISCORD_REDIRECT_URI || '')).trim();
  if (raw) { try { return new URL(raw).toString(); } catch { /* fall through */ } }
  return canonicalOrigin(env) + '/api/auth/discord/callback';
}

// Is this request already on the origin the OAuth flow lives on? A reader who
// is not gets moved there before the flow starts, so the session cookie is set
// on the same host that Discord returns them to.
function onCanonicalOrigin(env, url) {
  return url.origin === canonicalOrigin(env);
}

// Pick a free username derived from the Discord name. This is where
// "Tir-far-thóinn" became @tir-far-th-inn: the old class was [a-z0-9_-], every
// accented letter fell outside it and was replaced by a hyphen, so the ó was
// deleted and the name broken in half. The class now keeps letters of any
// script (\p{L}\p{M}\p{N}) — only the genuine punctuation and spaces become
// hyphens — and the name is normalised so the accent is one composed letter.
async function uniqueUsername(env, base) {
  // Code points, not UTF-16 units, all the way through: slicing a name at 16
  // units can cut an astral character in half and leave a lone surrogate.
  const cut = (s, n) => [...s].slice(0, n).join('');
  const clean = s => normUsername(
    normUsername(s).toLowerCase().replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '-')
  ).replace(/^[-_]+|[-_]+$/g, '');
  let stem = cut(clean(base || 'user'), 16).replace(/[-_]+$/, '');
  // A Discord display name is not vetted the way a typed username is, so it
  // gets the same one-alphabet rule rather than a free pass into a handle that
  // reads as somebody else's — falling back to the plain-letter spelling.
  if (mixesScripts(stem)) stem = cut(clean(foldLatin(stem)).replace(/[^a-z0-9_-]+/g, '-'), 16).replace(/[-_]+$/, '');
  // A name that survives none of that (all punctuation, say) still needs one.
  // A short name is padded with a digit rather than an English word, so a
  // two-character Han name stays a Han name instead of becoming "user-太一"
  // and tripping the one-alphabet rule on its way out.
  if ([...stem].length < 3) stem = stem ? stem + '-1' : 'user';
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? stem : stem + '-' + (i + 1);
    // usernameTaken, so a Discord signup cannot land on the folded twin of an
    // existing handle either — it walks on to -2 like any other collision.
    if (!(await usernameTaken(env, candidate))) return candidate;
  }
  return stem + '-' + Date.now();
}

function loginErrorRedirect(origin, msg) {
  return redirectResponse(origin + '/login?error=' + encodeURIComponent(msg), null, { 'Cache-Control': 'no-store' });
}

// Discord's own words for why a call failed, short enough to put in front of a
// reader and specific enough to act on. Losing them is what made the last
// outage a guessing game: every failure read "Discord sign-in failed", whether
// the secret had been wiped, the callback URL was unregistered, or someone had
// simply pressed Cancel.
async function discordErrorCode(res) {
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      const code = j.error || j.message || j.code || '';
      const desc = j.error_description || '';
      if (code) return String(desc ? code + ': ' + desc : code).slice(0, 120);
    } catch { /* not JSON */ }
    if (body) return body.slice(0, 120);
  } catch { /* body already consumed or unreadable */ }
  return 'HTTP ' + res.status;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ---------- DATA ENDPOINTS (replace static JSON files) ----------
    // ?drafts=1 includes unpublished pages, for admins only. Anyone else
    // asking for it silently gets the ordinary published-only feed rather
    // than an error, so a stale bookmark or a logged-out admin can never be
    // told that drafts exist. Every one of these responses is `no-store`
    // (jsonResponse), so a cache can't hand an admin's copy to a visitor.
    if (method === 'GET' && (path === '/characters.json' || path === '/collections.json' || path === '/scripts.json')) {
      const table = path === '/characters.json' ? 'characters'
        : path === '/collections.json' ? 'collections' : 'scripts';
      const wantsDrafts = url.searchParams.get('drafts') === '1';
      const includeDrafts = wantsDrafts && !!(await adminSession(env, request));
      const fields = url.searchParams.get('fields') === 'card' ? 'card' : 'full';

      // The admin ?drafts=1 feed is never cached and never gets an ETag: it is
      // per-viewer by definition, and a cached copy handed to a visitor would
      // reveal that unpublished pages exist. Same reasoning as the `no-store`
      // note above.
      if (includeDrafts) {
        return jsonResponse(await buildPublicJSON(env, table, { includeDrafts, fields }));
      }

      const version = await contentVersion(env);
      const etag = `W/"${table}-${fields}-v${version}"`;

      // A matching ETag means the browser already has this exact version.
      if ((request.headers.get('If-None-Match') || '') === etag) {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, 'Cache-Control': FEED_CACHE_CONTROL }
        });
      }

      // Edge cache, keyed on the content version so a bump misses automatically
      // rather than needing an explicit purge.
      const cache = caches.default;
      const cacheKey = new Request(
        `https://feed.internal/${table}.json?fields=${fields}&v=${version}`,
        { method: 'GET' }
      );
      const hit = await cache.match(cacheKey).catch(() => null);
      if (hit) return hit;

      const body = JSON.stringify(await buildPublicJSON(env, table, { fields }));
      const response = new Response(body, {
        headers: {
          ...JSON_HEADERS,
          ETag: etag,
          'Cache-Control': FEED_CACHE_CONTROL
        }
      });
      if (ctx) ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
      return response;
    }

    // ---------- SITE-WIDE ANNOUNCEMENT (public; site.js shows the banner) ----------
    if (method === 'GET' && path === '/api/announcement') {
      let ann = null;
      try {
        const r = await env.DB.prepare("SELECT value FROM settings WHERE key='announcement'").first();
        if (r && r.value) ann = JSON.parse(r.value);
      } catch { /* no announcement */ }
      return jsonResponse({ announcement: ann && ann.text ? ann : null });
    }

    // ---------- SYSTEM TEXT OVERRIDES (public; site.js applies them) ----------
    // Every page asks for this, so it must stay small and cheap: only the
    // strings an admin has actually rewritten are in the table, and the Worker
    // holds the list in memory for a few seconds. Empty on a site with no
    // edits, which is the normal case.
    // `no-store`, like every other JSON endpoint here. It was briefly sent
    // with max-age=120, which put a two-minute copy in the browser AND at the
    // edge on top of the isolate cache — an edit could take minutes to show,
    // which defeats the entire feature.
    if (method === 'GET' && path === '/api/site-text') {
      const items = await siteTextItems(env);
      return jsonResponse({ items });
    }

    // ---------- NEWS ----------
    // Public list. ?limit=N for the homepage panel; admins can add
    // ?drafts=1 to see unpublished articles in the editor's list.
    if (method === 'GET' && path === '/api/news') {
      await ensureNewsTable(env);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '30', 10) || 30, 1), 100);
      let includeDrafts = false;
      if (url.searchParams.get('drafts') === '1') {
        includeDrafts = !!(await adminSession(env, request));
      }
      const { results } = await env.DB.prepare(
        includeDrafts
          ? `SELECT slug, title, status, published_at, updated_at, data FROM news
             ORDER BY COALESCE(published_at, updated_at) DESC LIMIT ?`
          : `SELECT slug, title, status, published_at, updated_at, data FROM news
             WHERE status='published' ORDER BY published_at DESC LIMIT ?`
      ).bind(limit).all().catch(() => ({ results: [] }));
      return jsonResponse({
        articles: (results || []).map(r => {
          const d = parseData(r);
          return {
            slug: r.slug, title: r.title, status: r.status,
            publishedAt: r.published_at, updatedAt: r.updated_at,
            author: d.author || null,
            summary: d.summary || NewsRender.autoSummary(d.body, 160),
            image: d.image || null,
            // Body is only sent on the single-article route — the list stays
            // small even with a hundred long articles in it.
            pinned: !!d.pinned
          };
        })
      });
    }

    // One article as JSON. Public for published articles; the admin editor
    // uses it to load drafts too.
    if (method === 'GET' && path === '/api/news/item') {
      await ensureNewsTable(env);
      const slug = url.searchParams.get('slug') || '';
      const row = await env.DB.prepare('SELECT * FROM news WHERE slug=?').bind(slug).first().catch(() => null);
      if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
      if (row.status !== 'published' && !(await adminSession(env, request))) {
        return jsonResponse({ error: 'Not found' }, { status: 404 });
      }
      const d = parseData(row);
      return jsonResponse({
        article: {
          ...d, slug: row.slug, title: row.title, status: row.status,
          publishedAt: row.published_at, updatedAt: row.updated_at
        }
      });
    }

    // ---------- NEWS ARTICLE PAGES (server-side rendered) ----------
    if (method === 'GET' && path.startsWith('/news/')) {
      let slug = decodeURIComponent(path.slice(6));
      if (slug.endsWith('.html')) {
        slug = slug.slice(0, -5);
        return new Response(null, {
          status: 301,
          headers: { Location: url.origin + '/news/' + slug + url.search, 'Cache-Control': 'no-store' }
        });
      }
      if (!slug || !/^[a-z0-9-]+$/i.test(slug)) return assetsOrNotFound(env, request);
      await ensureNewsTable(env);
      const row = await env.DB.prepare('SELECT * FROM news WHERE slug=?').bind(slug).first().catch(() => null);
      if (!row) return assetsOrNotFound(env, request);
      const isDraft = row.status !== 'published';
      if (isDraft && !(await adminSession(env, request))) return assetsOrNotFound(env, request);
      if (!isDraft && ctx) ctx.waitUntil(bumpView(env, request, 'news', row.slug));

      const d = parseData(row);
      const a = {
        ...d, slug: row.slug, title: row.title,
        publishedAt: row.published_at, updatedAt: row.updated_at
      };
      const desc = (a.summary || NewsRender.autoSummary(a.body, 180) ||
        'News from the BOTC Homebrew Wiki.');
      const img = a.image
        ? (/^https?:\/\//i.test(a.image) ? a.image : url.origin + '/assets/' + a.image)
        : url.origin + '/assets/logo_skull.png';
      // [[Character Name]] in an article links to that character's page.
      await setWikiTextRegistries(env, url.origin, await loadCharLinks(env));
      const newsTheme = PageRender.sanitizeTheme(a.theme, 'news/' + a.slug);
      const newsThemeAttrs = PageRender.themeAttrs(newsTheme, '../');
      const html = pageShell({
        title: (isDraft ? 'Draft: ' : '') + (a.title || 'News'),
        desc, canonicalUrl: url.origin + '/news/' + encodeURIComponent(a.slug),
        ogImage: img, ogCard: a.image ? 'summary_large_image' : 'summary',
        bodyClass: newsThemeAttrs.cls, bodyStyle: newsThemeAttrs.style,
        body: '<p class="news-back"><a href="../news">← All news</a></p>' +
          NewsRender.renderArticle(a, { linkRoot: '../', isDraft }),
        draftBanner: isDraft
          ? '<div style="background:#7a5c18;color:#f7ecd0;text-align:center;padding:10px 16px;font-family:\'TradeGothicLT\',\'Libre Franklin\',sans-serif;letter-spacing:.04em">' + SYS.draftArticle + ' <a href="../publish-news?n=' + attr(encodeURIComponent(a.slug)) + '" style="color:#ffe9ad">' + SYS.draftEditorLink + '</a>.</div>'
          : '',
        bootstrap: `window.SSR = true; window.LINK_ROOT = '../'; window.PAGE_TYPE = 'news'; window.PAGE_SLUG = ${JSON.stringify(a.slug)};`,
        // newspage.js puts the Edit button in the top bar for admins.
        scripts: ['comments.js', 'newspage.js', 'site.js']
      });
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }

    // ---------- CUSTOM WIKI PAGES ----------
    // List the pages hanging off one script/collection, or everything one
    // author has written. These pages are deliberately invisible everywhere
    // else on the wiki, so there is no "all pages" feed.
    if (method === 'GET' && path === '/api/wiki-pages') {
      await ensurePagesTable(env);
      const author = (url.searchParams.get('author') || '').trim();
      if (author) {
        // Published only — an author page is public.
        const { results } = await env.DB.prepare(
          `SELECT slug, title, parent_type, parent_slug, author, data, updated_at
           FROM pages WHERE status='published' AND lower(author)=lower(?)
           ORDER BY updated_at DESC LIMIT 200`
        ).bind(author).all().catch(() => ({ results: [] }));
        const pages = [];
        for (const r of results || []) {
          const d = parseData(r);
          const parent = await wikiParentRow(env, r.parent_type, r.parent_slug);
          // A page whose script/collection has been deleted drops out of the
          // public listings with it.
          if (parent && parent.status === 'deleted') continue;
          pages.push({
            slug: r.slug, title: r.title, author: r.author,
            blurb: d.blurb || WikiRender.autoSummary(d.body, 140),
            parentType: r.parent_type,
            parentKey: parent ? parent.key : r.parent_slug,
            parentName: parent ? parent.name : null,
            updatedAt: r.updated_at
          });
        }
        return jsonResponse({ pages });
      }
      const parentType = url.searchParams.get('parentType') || '';
      const parentKey = url.searchParams.get('parentSlug') || '';
      const parent = await wikiParentRow(env, parentType, parentKey);
      if (!parent) return jsonResponse({ error: 'Unknown parent page' }, { status: 404 });
      const sess = await getSession(env, request);
      const mayEdit = canEditRow(sess, { owner_id: parent.ownerId });
      return jsonResponse({
        parent: { type: parent.type, key: parent.key, name: parent.name },
        canEdit: mayEdit,
        pages: await listWikiPages(env, parent.type, parent.slug, { includeDrafts: mayEdit })
      });
    }

    // One wiki page as JSON — what the editor loads. Drafts are visible to
    // their owner and to admins only.
    if (method === 'GET' && path === '/api/wiki-page') {
      await ensurePagesTable(env);
      const slug = url.searchParams.get('slug') || '';
      const row = await env.DB.prepare('SELECT * FROM pages WHERE slug=?')
        .bind(slug).first().catch(() => null);
      if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
      const sess = await getSession(env, request);
      const editable = canEditRow(sess, row);
      if (row.status !== 'published' && !editable) {
        return jsonResponse({ error: 'Not found' }, { status: 404 });
      }
      const parent = await wikiParentRow(env, row.parent_type, row.parent_slug);
      return jsonResponse({
        page: {
          ...parseData(row), slug: row.slug, title: row.title,
          parentType: row.parent_type, parentSlug: row.parent_slug,
          parentKey: parent ? parent.key : row.parent_slug,
          parentName: parent ? parent.name : null,
          author: row.author || null,
          updatedAt: row.updated_at
        },
        status: row.status, canEdit: editable
      });
    }

    // ---------- CUSTOM WIKI PAGE (server-side rendered, noindex) ----------
    if (method === 'GET' && path.startsWith('/p/')) {
      let slug = decodeURIComponent(path.slice(3));
      if (slug.endsWith('.html')) {
        slug = slug.slice(0, -5);
        return new Response(null, {
          status: 301,
          headers: { Location: url.origin + '/p/' + encodeURIComponent(slug) + url.search, 'Cache-Control': 'no-store' }
        });
      }
      if (!slug || !/^[a-z0-9-]+$/i.test(slug)) return assetsOrNotFound(env, request);
      await ensurePagesTable(env);
      const row = await env.DB.prepare('SELECT * FROM pages WHERE slug=?')
        .bind(slug).first().catch(() => null);
      if (!row) return assetsOrNotFound(env, request);
      const isDraft = row.status !== 'published';
      if (isDraft) {
        const sess = await getSession(env, request);
        if (!canEditRow(sess, row)) return assetsOrNotFound(env, request);
      }
      if (!isDraft && ctx) ctx.waitUntil(bumpView(env, request, 'wikipage', row.slug));

      const d = parseData(row);
      const parent = await wikiParentRow(env, row.parent_type, row.parent_slug);
      // A page goes down with its parent: if the script/collection it belongs
      // to has been deleted, nothing links here any more and the public
      // shouldn't reach it either. Its owner still can, so restoring the
      // parent brings everything back.
      if (parent && parent.status === 'deleted') {
        const sess = await getSession(env, request);
        if (!canEditRow(sess, row)) return assetsOrNotFound(env, request);
      }
      await setWikiTextRegistries(env, url.origin, await loadCharLinks(env));
      const page = {
        ...d, slug: row.slug, title: row.title,
        author: row.author || d.author || null,
        parentType: row.parent_type,
        parentKey: parent ? parent.key : row.parent_slug,
        parentName: parent ? parent.name : null,
        updatedAt: row.updated_at
      };
      const theme = PageRender.sanitizeTheme(d.theme, 'pages/' + row.slug);
      const ta = PageRender.themeAttrs(theme, '../');
      const desc = (d.blurb || d.subtitle || WikiRender.autoSummary(d.body, 180) ||
        'A page from the BOTC Homebrew Wiki.');
      const bannerImg = d.header ? WikiRender.safeImg(d.header, url.origin + '/') : '';

      const html = pageShell({
        title: (isDraft ? 'Draft: ' : '') + (row.title || 'Page'),
        desc, canonicalUrl: url.origin + '/p/' + encodeURIComponent(row.slug),
        ogImage: bannerImg || (url.origin + '/assets/logo_skull.png'),
        ogCard: bannerImg ? 'summary_large_image' : 'summary',
        // These pages are intentionally unlisted: no search engines, no
        // sitemap entry, no site search — only their parent page links here.
        noindex: true,
        bodyClass: ta.cls, bodyStyle: ta.style,
        body: WikiRender.renderWikiPage(page, { linkRoot: '../', isDraft }),
        draftBanner: isDraft
          ? '<div style="background:#7a5c18;color:#f7ecd0;text-align:center;padding:10px 16px;font-family:\'TradeGothicLT\',\'Libre Franklin\',sans-serif;letter-spacing:.04em">' + SYS.draftPage + ' <a href="../publish-page?p=' + attr(encodeURIComponent(row.slug)) + '" style="color:#ffe9ad">' + SYS.draftEditorLink + '</a>.</div>'
          : '',
        bootstrap: `window.SSR = true; window.LINK_ROOT = '../'; window.WIKI_PAGE_SLUG = ${JSON.stringify(row.slug)};` +
          (d.comments === false ? '' : ` window.PAGE_TYPE = 'wikipage'; window.PAGE_SLUG = ${JSON.stringify(row.slug)};`),
        scripts: d.comments === false ? ['wikipage.js', 'site.js'] : ['wikipage.js', 'comments.js', 'site.js']
      });
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }

    // ---------- COMMENTS (public read; posting needs an account) ----------
    if (method === 'GET' && path === '/api/comments') {
      const type = url.searchParams.get('type') || '';
      const slug = url.searchParams.get('slug') || '';
      const target = await commentTarget(env, type, slug);
      if (!target) return jsonResponse({ error: 'Page not found' }, { status: 404 });
      await ensureCommentTables(env);
      // Pinned top-level comments float to the top; everything else is
      // oldest-first so a thread reads in the order it was written. Replies
      // are grouped under their parent by the client.
      const { results } = await env.DB.prepare(
        `SELECT c.id, c.ts, c.body, c.user_id, c.parent_id, c.pinned,
                u.username, u.display_name, u.avatar_url, u.is_admin
         FROM comments c LEFT JOIN users u ON u.id = c.user_id
         WHERE c.entity_type=? AND c.slug=? AND c.status='visible'
         ORDER BY c.pinned DESC, c.id ASC LIMIT 500`
      ).bind(type, target.slug).all().catch(() => ({ results: [] }));

      const sess = await getSession(env, request);
      let me = null;
      if (sess) {
        const u = await env.DB.prepare(
          'SELECT id, username, is_admin, banned, comment_terms FROM users WHERE id=?'
        ).bind(sess.userId).first().catch(() => null);
        if (u) {
          me = {
            username: u.username,
            isAdmin: !!u.is_admin,
            // Suspended accounts can read but not post.
            canComment: !u.banned,
            // Page owners moderate their own page; admins moderate everything.
            canModerate: !!u.is_admin || (target.ownerId != null && target.ownerId === u.id),
            agreed: String(u.comment_terms || '') === COMMENT_TERMS_VERSION
          };
        }
      }
      return jsonResponse({
        type, slug: target.slug,
        termsVersion: COMMENT_TERMS_VERSION,
        me,
        comments: (results || []).map(r => ({
          id: r.id, ts: r.ts, body: r.body,
          parentId: r.parent_id || null,
          pinned: !!r.pinned,
          username: r.username || '[deleted user]',
          displayName: r.display_name || r.username || '[deleted user]',
          avatarUrl: r.avatar_url || null,
          isAdmin: !!r.is_admin,
          // "Creator": this comment was written by the account that owns the
          // page it sits on, so a reader can tell the person who made the
          // thing from everyone else discussing it. Decided here rather than
          // client-side because the page's owner is not otherwise something
          // the comment widget is told.
          isOwner: !!(target.ownerId != null && r.user_id === target.ownerId),
          mine: !!(sess && r.user_id === sess.userId)
        }))
      });
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
      // One segment is an identity or a flat address from before nesting; two
      // is a nested address, /c/{set}/{character}.
      if (slug && /^[a-z0-9-]+(\/[a-z0-9-]+)?$/i.test(slug)) {
        const found = await resolveCharacterPath(env, slug);
        const row = found ? found.row : null;
        if (row && row.data) {
          // Soft-deleted pages are hidden from everyone (incl. owner/admin);
          // recovery happens on the admin dashboard, not the live page.
          if (row.status === 'deleted') return assetsOrNotFound(env, request);
          const isDraft = row.status === 'draft';
          // Two things want to know whether this viewer owns the page: the
          // draft gate and the Partial nudge. Resolve it at most once, and
          // only when one of them asks — a logged-out reader looking at a
          // finished page never pays for a session lookup.
          let editable = null;
          const canEdit = async () => {
            if (editable === null) {
              editable = await canEditPage(env, await getSession(env, request), 'character', row);
            }
            return editable;
          };
          if (isDraft && !(await canEdit())) return assetsOrNotFound(env, request); // 404 for everyone else
          // Read at the canonical address, whichever door they came in by.
          // This has to come AFTER the draft and deleted gates: a 301 where a
          // stranger should get a 404 tells them the page exists and where it
          // now lives, and the site never reveals that unpublished pages exist.
          if (found.canonical && found.canonical !== slug) {
            return new Response(null, {
              status: 301,
              headers: {
                Location: url.origin + '/c/' + found.canonical + url.search,
                'Cache-Control': 'no-store'
              }
            });
          }
          const d = foldLegacyCurata(JSON.parse(row.data));
          // The row is the truth for both: `slug` is the identity (the art
          // paths and every reference are keyed on it) and `page` is the
          // address, which is what the canonical link and the OG tags use.
          d.slug = String(row.slug);
          d.page = 'c/' + found.canonical;
          // The creator's opt-out, applied before anything can lend the mark
          // back: Classify.isCurata is the one answer, and the row's own flag
          // is dropped here so the rest of the page renders as unmarked.
          if (!Classify.isCurata(d)) delete d.curata;
          // Same Curata inheritance the JSON feeds get, so the star on the
          // page agrees with the star in the grid it was clicked from.
          if (!d.curata) await applyCollectionCurata(env, [d]);
          // Same for the "Appears in" row: a character listed by hand in a
          // collection says so here without its creator typing the name in.
          await applyCollectionAppearsIn(env, [d]);
          // "This page is Partial" is shown to the people who can act on it
          // and to nobody else (see partialNoticeHTML). It asks isIncomplete,
          // not isPartial: Curata lifts a page out of the public Partial
          // tier, but it does not fill in the missing tags or almanac, and
          // the owner is still the one who can. Most Curata here is
          // inherited from a collection, so no admin ever looked at the page.
          const partialNotice = Classify.isIncomplete(d) && await canEdit();
          // Views are counted against the IDENTITY, so a page's history
          // survives every rename it ever has.
          if (!isDraft) ctx.waitUntil(bumpView(env, request, 'character', String(row.slug)));
          Render.setOfficialIconUrls(await officialIconMap(env, url.origin));
          Render.setOfficialNames(await officialNameMap(env, url.origin));
          // [[Character Name]] inside a jinx rule or a custom box links to
          // that character. Cheap cached name->slug query, not the corpus.
          WikiRender.setCharLinks(await cachedCharLinkMap(env));
          // Jinxes are a property of the pair, so this page shows the ones it
          // declares AND the ones other characters declare with it.
          try {
            const jx = await jinxIndex(env, ctx);
            Render.setWikiChars(jx.chars);
            d.jinxes = mergeMirroredJinxes(d, String(row.slug), jx);
          } catch { /* the page's own jinxes still render */ }
          return new Response(renderCharacterPage(d, url.origin, isDraft, partialNotice), {
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
          });
        }
        // Nothing here. resolveCharacterPath already followed the `redirects`
        // table, so an address a renamed page used to live at has been tried.
      }
      // Unknown slug -> fall back to a committed static page (if any), else 404.
      return assetsOrNotFound(env, request);
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
        return renderContentPage(env, ctx, request, url, 'script', slug);
      }
      return assetsOrNotFound(env, request);
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
        return renderContentPage(env, ctx, request, url, 'collection', key);
      }
      return assetsOrNotFound(env, request);
    }

    // ---------- IMAGE ASSETS (served from R2, fall back to static) ----------
    if (method === 'GET' && path.startsWith('/assets/')) {
      const key = path.slice('/assets/'.length);
      if (env.ART && R2_SERVE_PREFIXES.some(p => key.startsWith(p))) {
        const obj = await env.ART.get(key);
        if (obj) {
          const headers = new Headers();
          obj.writeHttpMetadata(headers);
          const ext = key.split('.').pop().toLowerCase();
          if (!headers.has('Content-Type') && EXT_CONTENT_TYPE[ext]) {
            headers.set('Content-Type', EXT_CONTENT_TYPE[ext]);
          }
          // Defence in depth behind the upload whitelist. /api/upload now
          // refuses anything that isn't a real image type, but objects written
          // before that check exists still carry whatever Content-Type was
          // claimed at the time, and writeHttpMetadata() above replays it.
          // These two headers make such an object inert: nosniff stops the
          // browser second-guessing a wrong type, and the sandbox CSP means
          // even a response literally labelled text/html cannot run script or
          // touch the site's origin. Safe to apply unconditionally — every
          // response on this path is an image.
          headers.set('X-Content-Type-Options', 'nosniff');
          headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
          headers.set('Cache-Control', 'no-cache, must-revalidate');
          if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
          return new Response(obj.body, { headers });
        }
      }
      return env.ASSETS.fetch(request); // not in R2 -> committed static file
    }

    // ---------- RANDOM CHARACTER (302 to a random published page) ----------
    if (method === 'GET' && path === '/random') {
      // Weighted by classification: Curata pages come up more often and
      // Partial (unfinished) pages never do. Falls back to a plain SQL
      // RANDOM() pick if the table can't be read as JSON for any reason.
      // Uses the memoised card feed rather than a fresh full parse: this route
      // reads the whole corpus purely to throw all of it away except one slug,
      // so it must never be the thing that pays to build it.
      let picked = null;
      try {
        picked = Classify.weightedPick(await cachedCardChars(env));
      } catch { /* fall through */ }
      let row = picked && picked.slug ? { slug: picked.slug, page: picked.page } : null;
      if (!row) {
        await ensureUrlSlugColumn(env);
        try {
          row = await env.DB.prepare(
            "SELECT slug, url_slug FROM characters WHERE status='published' ORDER BY RANDOM() LIMIT 1"
          ).first();
        } catch {
          row = await env.DB.prepare(
            'SELECT slug FROM characters ORDER BY RANDOM() LIMIT 1'
          ).first();
        }
        if (row) row.page = 'c/' + charAddress(row);
      }
      const dest = row ? '/' + String(row.page || ('c/' + row.slug)).replace(/^\//, '') : '/all-characters';
      return new Response(null, {
        status: 302,
        headers: { Location: url.origin + dest, 'Cache-Control': 'no-store' }
      });
    }

    // ---------- CREATOR PAGE (/u/{username} and /author?a=Name) ----------
    // One page, two keys. profile.html renders both: an account profile when
    // the name belongs to somebody, and a plain creator page when it does not
    // (half the wiki was bulk-imported under names with no account behind them).
    if (method === 'GET' && path.startsWith('/u/')) return serveProfileShell(env, request, url);

    // /author?a=Name — the link every character info box, credits list and the
    // homepage creator strip already points at. When the name belongs to an
    // account it redirects to that account's canonical URL; otherwise the same
    // page renders in place. 302 and not 301: an admin can link or unlink a
    // name at any time, and a cached permanent redirect would outlive that.
    if (method === 'GET' && (path === '/author' || path === '/author.html')) {
      const who = (url.searchParams.get('a') || '').trim();
      if (path === '/author.html') {
        return new Response(null, {
          status: 301,
          headers: {
            Location: url.origin + '/author' + (who ? '?a=' + encodeURIComponent(who) : ''),
            'Cache-Control': 'no-store'
          }
        });
      }
      if (who) {
        // A D1 hiccup must not 500 a page that used to be a static file:
        // resolveCreatorAccount swallows its own errors and returns null, so
        // the worst case here is the un-redirected creator page.
        const acct = await resolveCreatorAccount(env, who);
        if (acct && acct.username) {
          return new Response(null, {
            status: 302,
            headers: {
              Location: url.origin + '/u/' + encodeURIComponent(acct.username),
              'Cache-Control': 'no-store'
            }
          });
        }
      }
      return serveProfileShell(env, request, url);
    }

    // ---------- CREATOR PAGE DATA (?u=username or ?a=creator name) ----------
    // Returns everything one person made: pages their account owns, UNION pages
    // credited to any name that account has published under. An unclaimed name
    // gets the same shape with a minimal profile and no account fields.
    if (method === 'GET' && path === '/api/user') {
      const uname = (url.searchParams.get('u') || '').trim();
      const aname = (url.searchParams.get('a') || '').trim();
      if (!uname && !aname) return jsonResponse({ error: 'Missing username' }, { status: 400 });

      let u = null;
      if (uname) {
        await ensureProfileColumn(env);
        // Keyed, so /u/tir-far-thóinn and /u/tir-far-thoinn are one profile —
        // a link typed without the accent still lands.
        const cols = 'id, username, display_name, bio, avatar_url, created_at';
        u = await selectUserByName(env, cols + ', profile_json', uname);
        if (!u) u = await selectUserByName(env, cols, uname);
        if (!u) return jsonResponse({ error: 'No such user' }, { status: 404 });
      } else {
        u = await resolveCreatorAccount(env, aname);
        if (u) {
          await ensureProfileColumn(env);
          const full = await env.DB.prepare('SELECT profile_json FROM users WHERE id=?')
            .bind(u.id).first().catch(() => null);
          if (full) u.profile_json = full.profile_json;
        }
      }

      // Every creator name this page covers, lower-cased for matching.
      const names = u ? await creatorNamesFor(env, u.id, u.username) : [];
      if (aname && !names.includes(normCreator(aname))) names.push(normCreator(aname));

      // Drafts are for the people who can do something about them: the owner
      // of the profile and the admins. Same rule the old author page used.
      const sess = await getSession(env, request);
      const canSeeDrafts = !!(sess && (sess.isAdmin || (u && sess.userId === u.id)));

      const statusIn = canSeeDrafts ? "('published','draft')" : "('published')";
      // owner_id OR credited-name, so a page counts either way round: one the
      // account owns but credited to somebody else, and one credited to this
      // name but owned by nobody (the bulk-imported case).
      function whereFor(nameCol) {
        const clauses = [];
        if (u) clauses.push('owner_id=?');
        if (names.length) clauses.push(creditAnySQL(nameCol, names.length));
        if (!clauses.length) return null;
        return { sql: `(${clauses.join(' OR ')}) AND status IN ${statusIn}`,
                 binds: [...(u ? [u.id] : []), ...names] };
      }
      // The PK slug comes off the row, not out of the JSON: legacy rows do not
      // all carry `slug` in their data blob, and a card with no slug is a
      // broken link.
      async function pagesFrom(table, nameCol) {
        const w = whereFor(nameCol);
        if (!w) return [];
        try {
          const { results } = await env.DB.prepare(
            `SELECT slug, data, status FROM ${table} WHERE ${w.sql} ORDER BY updated_at DESC`
          ).bind(...w.binds).all();
          return results || [];
        } catch {
          // status/updated_at not migrated on this row set — legacy fallback
          const { results } = await env.DB.prepare(
            `SELECT slug, data FROM ${table} WHERE owner_id=?`
          ).bind(u ? u.id : -1).all().catch(() => ({ results: [] }));
          return results || [];
        }
      }

      const [charRows, scriptRows] = await Promise.all([
        pagesFrom('characters', 'creator'),
        pagesFrom('scripts', 'author')
      ]);
      // Collections keep their author in the JSON blob (no column), so they are
      // filtered in JS — the same full-table read applyCollectionCurata does.
      let collRows = [];
      try {
        const { results } = await env.DB.prepare(
          `SELECT slug, data, status, owner_id FROM collections WHERE status IN ${statusIn}`
        ).all();
        collRows = (results || []).filter(r => {
          if (u && r.owner_id === u.id) return true;
          if (!names.length) return false;
          const d = parseData(r);
          // A collection can be co-credited too.
          return creditNames(d.author).some(n => names.includes(n));
        });
      } catch { collRows = []; }

      // Trim to what a card needs. The old endpoint shipped every page's whole
      // data blob — a creator with forty characters meant a megabyte of almanac
      // prose just to draw thumbnails.
      function card(row, type) {
        const d = parseData(row);
        const status = row.status || 'published';
        const slug = row.slug || d.slug;
        const o = {
          slug, name: d.name || d.displayName || slug,
          status,
          page: typeof d.page === 'string' ? d.page.replace(/\.html$/, '') : undefined
        };
        if (type === 'character') {
          o.team = d.team || '';
          o.ability = d.ability || '';
          o.creator = d.creator || '';
          o.tags = d.tags || '';
          o.art = d.art || '';
          o.image = Array.isArray(d.image) ? d.image[0] : (d.image || '');
          o.appearsIn = d.appearsIn || '';
        } else if (type === 'script') {
          o.author = d.author || '';
          o.tagline = d.tagline || '';
          o.header = d.header || '';
          // A tile's banner is header || logo, then the text fallback. The
          // logo was never sent, so profile.html's `sc.header || sc.logo`
          // could only ever see the first half and every page with a logo and
          // no header — which is every Bloodstar import — drew the text
          // banner on its card while its own page showed the logo.
          o.logo = d.logo || '';
          o.characters = Array.isArray(d.characters) ? d.characters.length : 0;
        } else {
          // Collection URLs use the kebab id, never the PK slug — legacy rows
          // have display-string slugs like "The Academy".
          o.id = d.id || slug;
          o.displayName = d.displayName || slug;
          o.author = d.author || '';
          // Tagline first, description as the fallback — the tile prefers the
          // short line and only falls back to the long one.
          o.tagline = d.tagline || '';
          o.description = d.description || '';
          o.header = d.header || '';
          o.logo = d.logo || '';        // header || logo, as above
        }
        if (d.curata) o.curata = true;
        const cls = Classify.classifyPage(d, type);
        if (cls !== 'standard') o.classification = cls;
        // Partial is derived per read, and the page needs the raw ingredients
        // to explain itself in the editor's terms — but not the prose itself.
        return o;
      }

      const characters = charRows.map(r => card(r, 'character'));
      const scripts = scriptRows.map(r => card(r, 'script'));
      const collections = collRows.map(r => card(r, 'collection'));
      // A Curata collection lends its status to its characters here too, so
      // the mark on a profile card agrees with the mark on the character page.
      await applyCollectionCurata(env, characters);

      const split = list => ({
        live: list.filter(x => x.status !== 'draft'),
        drafts: list.filter(x => x.status === 'draft')
      });
      const c = split(characters), s = split(scripts), k = split(collections);

      const extra = u ? parseProfileExtra(u) : { links: {}, pinned: [] };
      // A pinned page that has since gone draft or been deleted quietly drops
      // out rather than 404-ing from somebody's profile.
      const livePins = extra.pinned.filter(p => {
        const pool = p.type === 'character' ? c.live : p.type === 'script' ? s.live : k.live;
        return pool.some(x => x.slug === p.slug);
      });

      // Custom wiki pages by this person. They are unlisted everywhere else, so
      // their creator page is one of only two ways in. Matched the same way the
      // content tables are — the account that owns them, or any creator name it
      // has claimed — so a page written under a bulk-imported credit still
      // shows up on the page for that name.
      let pages = [];
      try {
        await ensurePagesTable(env);
        const where = [];
        const binds = [];
        if (u) { where.push('owner_id=?'); binds.push(u.id); }
        if (names.length) { where.push(creditAnySQL('author', names.length)); binds.push(...names); }
        if (where.length) {
          const { results } = await env.DB.prepare(
            `SELECT slug, title, parent_type, parent_slug, data, updated_at FROM pages
             WHERE (${where.join(' OR ')}) AND status='published'
             ORDER BY updated_at DESC LIMIT 200`
          ).bind(...binds).all();
          for (const r of results || []) {
            const d = parseData(r);
            const parent = await wikiParentRow(env, r.parent_type, r.parent_slug);
            if (parent && parent.status === 'deleted') continue;
            pages.push({
              slug: r.slug, title: r.title,
              blurb: d.blurb || WikiRender.autoSummary(d.body, 140),
              parentType: r.parent_type,
              parentKey: parent ? parent.key : r.parent_slug,
              parentName: parent ? parent.name : null,
              updatedAt: r.updated_at
            });
          }
        }
      } catch { /* the creator page still works without them */ }

      return jsonResponse({
        profile: u ? {
          claimed: true,
          username: u.username,
          displayName: u.display_name || u.username,
          bio: u.bio || '',
          avatarUrl: u.avatar_url || null,
          joined: u.created_at,
          creatorNames: names,
          links: extra.links,
          pinned: livePins
        } : {
          claimed: false,
          username: null,
          // Show the spelling the pages actually use, not whatever casing came
          // in on the query string.
          displayName: creditSpelling(aname, charRows, scriptRows) || aname,
          creatorNames: names,
          links: {},
          pinned: []
        },
        characters: c.live, scripts: s.live, collections: k.live, pages,
        drafts: canSeeDrafts
          ? { characters: c.drafts, scripts: s.drafts, collections: k.drafts }
          : null
      });
    }

    // ---------- CREATOR INDEX DATA (every creator, claimed or not) ----------
    // ---------- JINX INDEX (the /jinxes page: list + relationship graph) ----------
    // Nodes are every character that takes part in a jinx: the wiki pages
    // themselves, plus the official characters they are jinxed with, which are
    // what most of the edges actually point at. Official↔official jinxes are
    // not here: this is a map of the homebrew wiki, not of the base game.
    if (method === 'GET' && path === '/api/jinxes') {
      let index;
      try {
        index = await jinxIndex(env, ctx);
      } catch {
        return jsonResponse({ nodes: [], edges: [] });
      }
      const officialIcons = await officialIconMap(env, url.origin).catch(() => ({}));
      const officialNames = await officialNameMap(env, url.origin).catch(() => ({}));

      const nodes = new Map();
      function addWiki(slug) {
        const r = index.rows[slug];
        if (!r || nodes.has('c:' + slug)) return 'c:' + slug;
        nodes.set('c:' + slug, {
          id: 'c:' + slug, slug: r.slug, name: r.name, team: r.team,
          creator: r.creator, official: false,
          icon: r.art ? (url.origin + '/assets/' + r.art) : (r.image || ''),
          href: '/' + String(r.page || ('c/' + r.slug)).replace(/^\//, '')
        });
        return 'c:' + slug;
      }
      function addOfficial(key, name) {
        const id = 'o:' + key;
        name = name || '';
        if (nodes.has(id)) return id;
        const nm = officialNames[key] || name || key;
        nodes.set(id, {
          id, slug: '', name: nm, team: '', creator: '', official: true,
          icon: officialIcons[key] || (url.origin + '/assets/icons/' + key + '.png'),
          href: 'https://wiki.bloodontheclocktower.com/' + encodeURIComponent(nm.replace(/ /g, '_'))
        });
        return id;
      }

      const edges = [];
      for (const e of index.edges) {
        const a = addWiki(e.from);
        if (!a) continue;
        // An edge whose target is neither a wiki page nor a known official
        // character is a typo or a draft, and has no node to attach to.
        let b;
        if (e.to) b = addWiki(e.to);
        else if (officialIcons[e.key] || officialNames[e.key]) b = addOfficial(e.key, e.name);
        else continue;
        edges.push({ a, b, align: e.align, text: e.text });
      }

      // The base-game layer. Marked `base` so the page can switch it on and
      // off without another request, and only drawn between characters that
      // are already anchors on the map or brought in with it.
      const baseEdges = [];
      for (const j of await loadOfficialJinxes(env, url.origin)) {
        if (!officialNames[j.a] || !officialNames[j.b]) continue;
        baseEdges.push({
          a: addOfficial(j.a), b: addOfficial(j.b),
          align: 'good', text: j.text || '', base: true
        });
      }

      const body = JSON.stringify({
        nodes: [...nodes.values()], edges, baseEdges
      });
      // Same edge-cache treatment as the JSON feeds: the index underneath is
      // already keyed by contentVersion, so the response can be too.
      const etag = `W/"jinxes-v${await contentVersion(env)}"`;
      if ((request.headers.get('If-None-Match') || '') === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': FEED_CACHE_CONTROL } });
      }
      return new Response(body, {
        headers: { ...JSON_HEADERS, ETag: etag, 'Cache-Control': FEED_CACHE_CONTROL }
      });
    }

    if (method === 'GET' && path === '/api/creators') {
      const tally = new Map();   // lower(name) -> {name, characters, scripts, collections}
      // One credit string can name several people; each of them gets their own
      // row here, the same way each of them gets their own creator page.
      function bump(raw, kind) {
        for (const name of Creators.splitCreators(raw)) {
          const key = normCreator(name);
          if (!key) continue;
          let row = tally.get(key);
          if (!row) { row = { name: name.trim(), characters: 0, scripts: 0, collections: 0 }; tally.set(key, row); }
          row[kind]++;
        }
      }
      try {
        const [chars, scripts, colls] = await Promise.all([
          env.DB.prepare(`SELECT creator AS n FROM characters WHERE status='published'`).all(),
          env.DB.prepare(`SELECT author AS n FROM scripts WHERE status='published'`).all(),
          env.DB.prepare(`SELECT data FROM collections WHERE status='published'`).all()
        ]);
        for (const r of chars.results || []) bump(r.n, 'characters');
        for (const r of scripts.results || []) bump(r.n, 'scripts');
        for (const r of colls.results || []) bump(parseData(r).author, 'collections');
      } catch { /* partial tally is better than none */ }

      // Attach accounts. One pass over the alias table and one over the users
      // that own published pages, rather than a resolve call per name.
      const aliases = new Map();
      try {
        const { results } = await env.DB.prepare(
          `SELECT key, value FROM settings WHERE key LIKE 'creator_alias:%'`
        ).all();
        for (const r of results || []) {
          aliases.set(String(r.key).slice('creator_alias:'.length), String(r.value || ''));
        }
      } catch { /* none set */ }
      // lower(name) -> owner_id, the account that owns the most published
      // pages credited to that name (proof by ownership, in bulk). Counted in
      // JS rather than SQL because a credit can name several people.
      const owners = new Map();
      try {
        const { results } = await env.DB.prepare(
          `SELECT creator AS n, owner_id, COUNT(*) AS c FROM characters
            WHERE owner_id IS NOT NULL AND creator IS NOT NULL AND status='published'
            GROUP BY creator, owner_id`
        ).all();
        const perName = new Map();   // name -> Map(owner_id -> count)
        for (const r of results || []) {
          for (const key of creditNames(r.n)) {
            if (!perName.has(key)) perName.set(key, new Map());
            const m = perName.get(key);
            m.set(r.owner_id, (m.get(r.owner_id) || 0) + r.c);
          }
        }
        for (const [key, m] of perName) {
          let best = null, bestN = 0;
          for (const [ownerId, n] of m) {
            if (n > bestN || (n === bestN && best != null && ownerId < best)) { best = ownerId; bestN = n; }
          }
          if (best != null) owners.set(key, best);
        }
      } catch { /* no owned pages */ }
      let users = [];
      try {
        const { results } = await env.DB.prepare(
          'SELECT id, username, display_name, avatar_url FROM users'
        ).all();
        users = results || [];
      } catch { /* users unreadable */ }
      const byId = new Map(users.map(x => [x.id, x]));
      const byName = new Map(users.map(x => [String(x.username).toLowerCase(), x]));

      const out = [];
      for (const [key, row] of tally) {
        let acct = null;
        if (aliases.has(key)) {
          const v = aliases.get(key);
          acct = v ? byName.get(v.toLowerCase()) || null : null;
        } else if (owners.has(key)) {
          acct = byId.get(owners.get(key)) || null;
        }
        out.push({
          name: row.name,
          characters: row.characters, scripts: row.scripts, collections: row.collections,
          total: row.characters + row.scripts + row.collections,
          username: acct ? acct.username : null,
          displayName: acct ? (acct.display_name || acct.username) : null,
          avatarUrl: acct ? acct.avatar_url : null
        });
      }
      out.sort((a, b) => b.total - a.total || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      return jsonResponse({ creators: out });
    }

    // ---------- SITEMAP (built live from D1) ----------
    if (method === 'GET' && path === '/sitemap.xml') {
      const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      async function pub(table) {
        // Characters are listed at their address, not their identity, or
        // every URL in the sitemap would be one the site 301s away from.
        const addr = table === 'characters' ? ', url_slug' : '';
        if (table === 'characters') await ensureUrlSlugColumn(env);
        try {
          return (await env.DB.prepare(`SELECT slug, updated_at${addr} FROM ${table} WHERE status='published'`).all()).results;
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
      async function pubNews() {
        try {
          await ensureNewsTable(env);
          return (await env.DB.prepare(
            `SELECT slug, updated_at FROM news WHERE status='published'`
          ).all()).results;
        } catch { return []; }
      }
      const [chars, scripts, colls, news] = await Promise.all([
        pub('characters'), pub('scripts'), pubCollections(), pubNews()
      ]);
      const staticPages = ['', 'all-characters', 'all-collections', 'scripts', 'tags', 'creators',
        'script', 'tools', 'tokens', 'grimforge', 'iconforge', 'mass-upload', 'bloodstar',
        'steven-approved-order', 'rules', 'news', 'jinxes'];
      const urls = staticPages.map(p => '<url><loc>' + xmlEsc(url.origin + '/' + p) + '</loc></url>');
      const lastmod = r => r.updated_at ? '<lastmod>' + xmlEsc(String(r.updated_at).slice(0, 10)) + '</lastmod>' : '';
      for (const r of chars) {
        urls.push('<url><loc>' + xmlEsc(url.origin + '/c/' + charAddress(r)) + '</loc>' + lastmod(r) + '</url>');
      }
      for (const r of scripts) {
        urls.push('<url><loc>' + xmlEsc(url.origin + '/s/' + encodeURIComponent(r.slug)) + '</loc>' + lastmod(r) + '</url>');
      }
      for (const r of colls) {
        let id = '';
        try { id = JSON.parse(r.data).id || ''; } catch { /* fall back to slug */ }
        urls.push('<url><loc>' + xmlEsc(url.origin + '/collection/' + encodeURIComponent(id || r.slug)) + '</loc>' + lastmod(r) + '</url>');
      }
      for (const r of news) {
        urls.push('<url><loc>' + xmlEsc(url.origin + '/news/' + encodeURIComponent(r.slug)) + '</loc>' + lastmod(r) + '</url>');
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
        return tooManyResponse('Too many signups from this connection. Try again later.', 3600);
      }
      const body = await request.json().catch(() => ({}));
      // Kept as typed, only NFC-composed: an accented letter is a letter, and
      // the handle is the name. Identity comparisons happen on usernameKey().
      const username = normUsername(body.username);
      const email = String(body.email || '').trim();
      const password = String(body.password || '');
      const bad = validSignup(username, email, password);
      if (bad) return jsonResponse({ error: bad }, { status: 400 });

      // One message for both cases the key catches — the exact handle, and the
      // one that differs only by an accent — because to a reader they are the
      // same collision and the remedy is the same.
      if (await usernameTaken(env, username)) {
        return jsonResponse({
          error: 'That username is taken, or is too close to one that already exists. Try adding something to it.'
        }, { status: 409 });
      }
      const emailTaken = await env.DB.prepare('SELECT 1 FROM users WHERE email IS NOT NULL AND lower(email)=lower(?)')
        .bind(email).first();
      if (emailTaken) return jsonResponse({ error: 'An account with that email already exists. Try logging in or resetting your password.' }, { status: 409 });

      const hash = await hashPassword(password);
      await ensureUsernameKey(env);
      const res = await env.DB.prepare(
        `INSERT INTO users (username, username_key, password_hash, email, is_admin, last_login)
         VALUES (?,?,?,?,0,datetime('now'))`
      ).bind(username, usernameKey(username), hash, email).run();
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
        return tooManyResponse('Too many login attempts. Wait a few minutes and try again.', 600);
      }
      const body = await request.json().catch(() => ({}));
      const identifier = String(body.username || body.email || '').trim();
      const password = String(body.password || '');
      if (!identifier || !password) return jsonResponse({ error: 'Missing credentials' }, { status: 400 });
      const user = await findUserByLogin(env, identifier);
      // "Invalid login" for both halves left people re-typing a password that
      // was right all along. Which half failed is only said for a NAME: names
      // are public here (every profile is a page, /creators lists them all),
      // so naming one confirms nothing new. An email address is not public, so
      // an email-shaped identifier keeps one message for both cases.
      const isEmailish = identifier.includes('@');
      const vague = 'That email and password don\'t match. Check both, or use "Forgot your password?" below.';
      if (!user) {
        return jsonResponse({
          error: isEmailish ? vague
            : 'No account has that username. It\'s the @name on your account page. You can also log in with your email address.'
        }, { status: 401 });
      }
      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) {
        if (!user.password_hash && user.discord_id) {
          return jsonResponse({ error: 'This account signs in with Discord. Use the Discord button (you can set a password afterwards on your account page).' }, { status: 401 });
        }
        return jsonResponse({
          error: isEmailish ? vague
            : 'That password doesn\'t match this account. Try again, or use "Forgot your password?" below.'
        }, { status: 401 });
      }
      if (user.banned) {
        return jsonResponse({ error: 'This account has been suspended. Contact the admins if you think this is a mistake.' }, { status: 403 });
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
      // Unread DM count (dms table may not exist until the first message)
      let unreadMessages = 0;
      try {
        const r = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM dms WHERE recipient_id=? AND read_at IS NULL AND recipient_deleted=0'
        ).bind(sess.userId).first();
        unreadMessages = r ? r.n : 0;
      } catch { /* no DMs yet */ }
      return jsonResponse({
        loggedIn: true,
        isAdmin: !!u.is_admin,
        username: u.username,
        displayName: u.display_name || u.username,
        avatarUrl: u.avatar_url || null,
        email: u.email || null,
        emailVerified: !!u.email_verified,
        discordLinked: !!u.discord_id,
        hasPassword: !!u.password_hash,
        unreadMessages
      });
    }

    // The Download JSON button on /s/ and /collection/ points straight here.
    if (method === 'GET' && path === '/api/page-json') {
      return pageJsonResponse(env, request, url);
    }

    /* ---- read a Bloodstar project ----
       ?url= anything that points at a project on Bloodstar, on either of its
       hosts (BLOODSTAR_HOST_CANON in worker/bloodstar.js): the almanac, the
       script.json, or the folder. The Worker fetches BOTH published files and
       hands back one normalized bundle (see worker/bloodstar.js).

       Why the Worker and not the browser: the almanac has to be parsed, and a
       Worker has no DOMParser, so the parse lives here either way. Having the
       fetch here too means the tool keeps working if Bloodstar ever stops
       sending `access-control-allow-origin: *`, and the reader's phone never
       downloads 180 KB of someone else's HTML to throw most of it away.

       Login required, and the host is pinned to Bloodstar: this is the Worker
       fetching a URL a stranger typed, and the only safe version of that is
       one that can only ever reach Bloodstar. */
    if (method === 'GET' && path === '/api/bloodstar') {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in. Create an account or log in first.' }, { status: 401 });
      if (!sess.isAdmin && await rateLimited(env, request, 'bloodstar', 60, 3600, { sess })) {
        return tooManyResponse('You have read a lot of Bloodstar projects in the last hour. Take a short break and try again.', 3600);
      }
      const src = Bloodstar.bloodstarSource(url.searchParams.get('url'));
      if (src.error) return jsonResponse({ error: src.error }, { status: 400 });

      let scriptJson = null;
      try {
        const res = await fetch(src.scriptUrl, { redirect: 'follow' });
        if (res.status === 404) {
          return jsonResponse({ error: 'Bloodstar has no script.json for that project. Check the link, and that the project has been published.' }, { status: 404 });
        }
        if (!res.ok) {
          return jsonResponse({ error: 'Bloodstar answered ' + res.status + ' for that project\'s script.json.' }, { status: 502 });
        }
        scriptJson = await res.json();
      } catch {
        return jsonResponse({ error: 'Could not read that project\'s script.json. Bloodstar may be down, or the link may be wrong.' }, { status: 502 });
      }
      if (!Array.isArray(scriptJson)) {
        return jsonResponse({ error: 'That project\'s script.json is not a script (the file should be a list of characters).' }, { status: 422 });
      }

      // The almanac is the optional half: a project can publish a script with
      // no almanac written yet, and that still imports — it just arrives
      // without the prose, which the tool says out loud rather than looking
      // like it silently lost it.
      let almanacHtml = '';
      try {
        const res = await fetch(src.almanacUrl, { redirect: 'follow' });
        if (res.ok) {
          const text = await res.text();
          // A generated almanac for a 40-character script is ~180 KB. Anything
          // past a couple of megabytes is not one, and parsing it would spend
          // the whole request's CPU on a file we are going to reject anyway.
          if (text.length <= 4 * 1024 * 1024) almanacHtml = text;
        }
      } catch { /* the script alone is still worth importing */ }

      const official = await loadOfficialRoles(env, url.origin);
      const almanac = almanacHtml ? Bloodstar.parseAlmanac(almanacHtml, src.base) : null;
      const bundle = Bloodstar.buildBundle(scriptJson, almanac, src, official);
      bundle.hasAlmanac = !!almanacHtml;
      if (!almanacHtml) {
        bundle.warnings.unshift('That project has no readable almanac.html, so only what is in script.json could be read — no flavour text, overviews, examples, how-to-run or tips.');
      }
      return jsonResponse(bundle);
    }

    // ---- is this page's identity still free? (editor helper) ----
    // The create page builds a character's identity from its name, uploads the
    // art to art/{slug}.png and only then writes the row — so a name another
    // account already used failed at the *upload* step with a confusing "that
    // art slot belongs to a character owned by another account". This lets an
    // editor find that out before it uploads anything, and offers a free one
    // in the style the wiki already uses for duplicate names
    // (witcher-odyssey, sculptor-fall-of-rome, illusionist-megalomania).
    //
    // For characters this is about the IDENTITY, not the URL: the reader-facing
    // address is /c/{set}/{character} and the Worker derives it on save, so a
    // duplicate name never needs a different identity to get its own page.
    // Identities still have to be unique because they name the art slot, which
    // is why the suffix ladder is still here and still looks like a URL.
    // Scripts and collections are unchanged: for them the slug IS the URL.
    // Login required: whether a slug is taken can betray someone's draft.
    if (method === 'GET' && path === '/api/slug-check') {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in.' }, { status: 401 });
      const type = url.searchParams.get('type') || 'character';
      const t = CONTENT[type];
      if (!t) return jsonResponse({ error: 'Unknown page type.' }, { status: 400 });
      const kebab = s => String(s || '').toLowerCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '').slice(0, 80);
      const base = kebab(url.searchParams.get('name') || url.searchParams.get('slug'));
      if (!base) return jsonResponse({ error: 'Nothing to check.' }, { status: 400 });
      // A collection's URL is its kebab `id`, which for legacy rows is NOT the
      // PK slug ("The Academy" is the PK of the-academy). /api/collection
      // resolves a write through findCollectionRow, so the check has to look
      // the same way round or it calls a URL free that the save then refuses
      // with "A collection with that name already exists."
      const row = type === 'collection'
        ? await findCollectionRow(env, base)
        : await getEntityRow(env, type, base);
      // A URL a renamed page still redirects from is taken too: building a new
      // page there would quietly hijack every old link to the moved one.
      const parked = !row && !!(await lookupRedirect(env, type, base));
      if (!row && !parked) return jsonResponse({ base, taken: false, mine: false, suggestion: base });
      // `mine` says a save on this URL would update that page rather than
      // collide with it — which is what the create page wants, and what a
      // rename must still avoid (it would move a page onto a live one).
      const mine = !!row && canEditRow(sess, row);
      // Find the first free variant either way.
      let used;
      if (type === 'collection') {
        // Same reason as above: a collection is reachable by its id as well as
        // by its PK slug, so both count as taken. The table is small and
        // findCollectionRow already scans it.
        used = new Set();
        const { results } = await env.DB.prepare('SELECT slug, data FROM collections')
          .all().catch(() => ({ results: [] }));
        for (const r of results || []) {
          used.add(String(r.slug));
          try {
            const d = foldLegacyCurata(JSON.parse(r.data));
            if (d && d.id) used.add(String(d.id));
          } catch { /* skip bad rows */ }
        }
      } else {
        try {
          const { results } = await env.DB.prepare(
            `SELECT slug FROM ${t.table} WHERE slug=? OR slug LIKE ?`
          ).bind(base, base + '-%').all();
          used = new Set((results || []).map(r => String(r.slug)));
        } catch { used = new Set(); }
      }
      try {
        const { results } = await env.DB.prepare(
          'SELECT from_slug FROM redirects WHERE entity_type=? AND (from_slug=? OR from_slug LIKE ?)'
        ).bind(type, base, base + '-%').all();
        for (const r of results || []) used.add(String(r.from_slug));
      } catch { /* nothing has ever been renamed */ }
      used.add(base);
      // Disambiguation ladder, in order:
      //   witcher
      //   witcher-{collection or script}   <- the character's own "appears in"
      //   witcher-{username}               <- when it belongs to neither
      //   witcher-...-2, -3                <- further copies by the same author
      //
      // Collection first because it is what the wiki already reads as
      // (`witcher-odyssey`), and because it is the useful half of the name when
      // two different people write a Witcher for two different sets. The
      // username rung catches the loose character that belongs to no set, where
      // the author IS the distinguishing fact.
      //
      // Duplicate NAMES are entirely fine and nothing here discourages them:
      // the display name is untouched, no warning is shown, and the page simply
      // gets its own address. Numbering keeps the site's existing -2/-3 style
      // (the first copy is unnumbered, so the second is 2).
      const candidates = [];
      const appears = kebab(String(url.searchParams.get('appearsIn') || '').split(',')[0]);
      let author = '';
      try {
        const u = await env.DB.prepare('SELECT username FROM users WHERE id=?')
          .bind(sess.userId).first();
        author = kebab(u && u.username);
      } catch { /* fall through to plain numbering */ }
      // The collection/script wins outright when there is one: the author rung
      // is the fallback for a character that belongs to no set, not a second
      // guess to try once the collection form is taken. So a second Witcher in
      // Odyssey is witcher-odyssey-2 — still obviously an Odyssey Witcher —
      // rather than jumping to witcher-{author} and dropping the set from the
      // URL entirely.
      const flavour = appears || author;
      if (flavour) {
        candidates.push(base + '-' + flavour);
        for (let i = 2; i < 60; i++) candidates.push(base + '-' + flavour + '-' + i);
      }
      // Last resort, and the whole ladder for a page with neither a set nor a
      // resolvable username.
      for (let i = 2; i < 60; i++) candidates.push(base + '-' + i);
      const suggestion = candidates.find(s => s.length <= 80 && !used.has(s)) || null;
      // Nothing about the page sitting on that URL is returned: it may be
      // somebody's draft, and the site never reveals that drafts exist.
      return jsonResponse({ base, taken: true, mine, suggestion });
    }

    // ---------- AUTH: FORGOT / RESET PASSWORD ----------
    if (method === 'POST' && path === '/api/forgot-password') {
      if (await rateLimited(env, request, 'forgot', 5, 3600)) {
        return tooManyResponse('Too many reset requests. Try again later.', 3600);
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
          // Half the people who ask for a reset are stuck on the OTHER field:
          // their display name is the only name the site shows them, so this
          // is the one message that can tell them what to type.
          `<p>Hi ${escapeHtml(user.display_name || user.username)},</p>
           <p>Someone (hopefully you) asked to reset the password for your ${APP_NAME} account.</p>
           <p>Your username is <b>@${escapeHtml(user.username)}</b>. That, or this email address, is what goes in the log-in box.</p>
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
      // Everything signed in under the old password goes. Order matters: the
      // revoke has to happen BEFORE the new session is minted, or it would
      // delete the session it just created and log them straight back out.
      // A reset is the other half of "I think somebody is in my account".
      await revokeSessions(env, parseInt(userId, 10) || userId);
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
        return tooManyResponse('Too many verification emails requested. Try again later.', 3600);
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
      const wantsLink = url.searchParams.get('link') === '1';

      // Move the reader to the origin Discord will return to BEFORE anything
      // else happens, so the whole flow — the state token, the code, the
      // session cookie — belongs to one host. Nothing is carried across: a
      // handoff token would let one person's half-finished sign-in be
      // completed by another, which is exactly the attack `state` exists to
      // prevent. Someone linking Discord from another hostname is asked to log
      // in here first; signing in, the common case, just works.
      if (!onCanonicalOrigin(env, url)) {
        return redirectResponse(
          canonicalOrigin(env) + '/api/auth/discord' + (wantsLink ? '?link=1' : ''),
          null,
          { 'Cache-Control': 'no-store' }
        );
      }

      let linkUserId = 0;
      if (wantsLink) {
        const sess = await getSession(env, request);
        if (!sess) return loginErrorRedirect(url.origin, 'Log in first, then link Discord from your account page.');
        linkUserId = sess.userId;
      }
      const state = randomToken();
      await env.SESSIONS.put(
        'oauth:' + state,
        JSON.stringify({ link: linkUserId }),
        { expirationTtl: OAUTH_STATE_TTL }
      );

      const auth = new URL('https://discord.com/oauth2/authorize');
      auth.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
      auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('redirect_uri', discordRedirectUri(env));
      auth.searchParams.set('scope', 'identify email');
      auth.searchParams.set('state', state);
      // No `prompt` parameter. It used to be sent as `prompt=none`, which
      // Discord documents for exactly one case — "if a user has previously
      // authorized your application with the requested scopes ... it will skip
      // the authorization screen and redirect them back" — and says nothing
      // about any other. Everyone else takes an undefined path: a first-time
      // user, someone who has revoked access, and above all someone who is not
      // logged in to Discord IN THAT BROWSER, because "show no UI" and "ask
      // them to log in" cannot both be obeyed. That last case is why this read
      // as a browser bug: signed in to Discord in one browser and not the
      // other, the same account gets a working sign-in in one and a page that
      // spins forever in the other, with nothing different on our side.
      //
      // Leaving it off costs a returning reader one click on Discord's
      // "Authorize" screen. It buys a flow with no undefined states in it,
      // which is the better trade for the front door of the site.
      // A cached redirect would replay a state token that KV has already
      // expired or consumed, and the reader would be stuck on "please try
      // again" until they cleared their browser cache.
      return redirectResponse(auth.toString(), null, { 'Cache-Control': 'no-store' });
    }

    if (method === 'GET' && path === '/api/auth/discord/callback') {
      if (!discordConfigured(env)) return loginErrorRedirect(url.origin, 'Discord sign-in is not configured.');

      // Discord itself refused: the reader pressed Cancel, or the application
      // is misconfigured. Say which — this used to be reported as a state
      // mismatch, which sent everyone looking in the wrong place.
      const oauthErr = url.searchParams.get('error');
      if (oauthErr) {
        console.log('discord-oauth: authorize returned', oauthErr, url.searchParams.get('error_description') || '');
        return loginErrorRedirect(url.origin, oauthErr === 'access_denied'
          ? 'Discord sign-in was cancelled.'
          : 'Discord refused the sign-in (' + oauthErr + '). Please try again.');
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') || '';
      const stateRaw = state && await env.SESSIONS.get('oauth:' + state);
      if (!code || !stateRaw) return loginErrorRedirect(url.origin, 'Discord sign-in failed (the sign-in took too long, or the link was reused). Please try again.');
      await env.SESSIONS.delete('oauth:' + state);
      let linkUserId = 0;
      try { linkUserId = (JSON.parse(stateRaw).link | 0); } catch {}

      // Exchange the code for a token. The redirect_uri here must match the
      // one sent to /authorize character for character, which is why both come
      // from discordRedirectUri(env) and neither is built from this request.
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID,
          client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: discordRedirectUri(env)
        })
      });
      if (!tokenRes.ok) {
        // Discord's own reason, in the Worker log and in the message. The
        // three that matter: invalid_client (the secret is wrong or was wiped
        // by a deploy), invalid_grant (a stale or reused code) and
        // invalid_request (usually the redirect_uri is not registered).
        const detail = await discordErrorCode(tokenRes);
        console.log('discord-oauth: token exchange failed', tokenRes.status, detail);
        return loginErrorRedirect(url.origin, 'Discord sign-in failed (' + detail + '). Please tell an admin if it keeps happening.');
      }
      const tok = await tokenRes.json();

      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: 'Bearer ' + tok.access_token }
      });
      if (!userRes.ok) {
        const detail = await discordErrorCode(userRes);
        console.log('discord-oauth: profile fetch failed', userRes.status, detail);
        return loginErrorRedirect(url.origin, 'Discord sign-in failed (profile fetch: ' + detail + '). Please try again.');
      }
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

      // Existing Discord-linked account -> log in. A picture the user set on
      // the wiki wins over the Discord one, so logging in never clobbers it.
      if (byDiscord) {
        if (byDiscord.banned) return loginErrorRedirect(url.origin, 'This account has been suspended.');
        await env.DB.prepare(
          `UPDATE users SET discord_username=?, avatar_url=COALESCE(avatar_url, ?), last_login=datetime('now') WHERE id=?`
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
          if (byEmail.banned) return loginErrorRedirect(url.origin, 'This account has been suspended.');
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
      await ensureUsernameKey(env);
      const ins = await env.DB.prepare(
        `INSERT INTO users (username, username_key, password_hash, email, is_admin, display_name, discord_id, discord_username, avatar_url, email_verified, last_login)
         VALUES (?, ?, '', ?, 0, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(username, usernameKey(username), discordEmail, discordName, discordId, du.username || discordName, avatarUrl, discordEmail ? 1 : 0).run();
      const newId = ins.meta.last_row_id;
      await logActivity(env, { userId: newId }, 'signup', 'user', null, username);
      const t = await createSession(env, newId, false);
      return redirectResponse(url.origin + '/account?welcome=1', sessionCookie(t));
    }

    // ---------- YOUR OWN MESSAGES TO THE ADMINS ----------
    if (method === 'GET' && path === '/api/contact') {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in' }, { status: 401 });
      await ensureMessagesTable(env);
      const { results } = await env.DB.prepare(
        // replied_at lets the account page say an answer is waiting; the answer
        // itself was delivered as a DM, so it is read in /messages.
        'SELECT id, ts, category, body, status, replied_at, replied_by FROM messages WHERE user_id=? ORDER BY id DESC LIMIT 20'
      ).bind(sess.userId).all();
      return jsonResponse({ messages: results || [] });
    }

    // ---------- DIRECT MESSAGES: CONVERSATION LIST ----------
    if (method === 'GET' && path === '/api/messages') {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in' }, { status: 401 });
      await ensureDmTables(env);
      const me = sess.userId;
      // One row per conversation partner: newest message id + my unread count.
      const { results: convs } = await env.DB.prepare(
        `SELECT partner, MAX(id) AS last_id, SUM(unread) AS unread FROM (
           SELECT CASE WHEN sender_id=?1 THEN recipient_id ELSE sender_id END AS partner,
                  id,
                  CASE WHEN recipient_id=?1 AND read_at IS NULL THEN 1 ELSE 0 END AS unread
           FROM dms
           WHERE (sender_id=?1 AND sender_deleted=0) OR (recipient_id=?1 AND recipient_deleted=0)
         ) GROUP BY partner ORDER BY last_id DESC LIMIT 100`
      ).bind(me).all();
      const list = convs || [];
      const lastById = {}, userById = {};
      if (list.length) {
        const marks = ids => ids.map(() => '?').join(',');
        const lastIds = list.map(c => c.last_id);
        const partnerIds = list.map(c => c.partner);
        const [lasts, users] = await Promise.all([
          env.DB.prepare(`SELECT id, ts, sender_id, body FROM dms WHERE id IN (${marks(lastIds)})`).bind(...lastIds).all(),
          env.DB.prepare(`SELECT id, username, display_name, avatar_url, is_admin FROM users WHERE id IN (${marks(partnerIds)})`).bind(...partnerIds).all()
        ]);
        for (const r of lasts.results || []) lastById[r.id] = r;
        for (const r of users.results || []) userById[r.id] = r;
      }
      let unreadTotal = 0;
      const conversations = list.map(c => {
        const u = userById[c.partner];
        if (!u) return null; // partner account was deleted
        const last = lastById[c.last_id] || {};
        unreadTotal += c.unread || 0;
        return {
          username: u.username,
          displayName: u.display_name || u.username,
          avatarUrl: u.avatar_url || null,
          isAdmin: !!u.is_admin,
          unread: c.unread || 0,
          lastTs: last.ts || null,
          lastFromMe: last.sender_id === me,
          lastBody: String(last.body || '').slice(0, 120)
        };
      }).filter(Boolean);
      const { results: blocks } = await env.DB.prepare(
        `SELECT u.username FROM dm_blocks b JOIN users u ON u.id=b.blocked_id
         WHERE b.user_id=? ORDER BY lower(u.username)`
      ).bind(me).all();
      return jsonResponse({
        conversations,
        unreadTotal,
        blocked: (blocks || []).map(b => b.username)
      });
    }

    // ---------- DIRECT MESSAGES: ONE THREAD ----------
    // ?with=username (+ optional ?before=id to page further back). Loading the
    // newest page marks the incoming messages as read.
    if (method === 'GET' && path === '/api/messages/thread') {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in' }, { status: 401 });
      await ensureDmTables(env);
      const other = await findUserByUsername(env, (url.searchParams.get('with') || '').trim());
      if (!other) return jsonResponse({ error: 'No such user.' }, { status: 404 });
      if (other.id === sess.userId) return jsonResponse({ error: "You can't message yourself." }, { status: 400 });
      const before = parseInt(url.searchParams.get('before'), 10) || 0;
      const PAGE = 50;
      const { results } = await env.DB.prepare(
        `SELECT id, ts, sender_id, body, read_at FROM dms
         WHERE ((sender_id=?1 AND recipient_id=?2 AND sender_deleted=0)
             OR (sender_id=?2 AND recipient_id=?1 AND recipient_deleted=0))
           AND (?3=0 OR id<?3)
         ORDER BY id DESC LIMIT ${PAGE}`
      ).bind(sess.userId, other.id, before).all();
      const rows = results || [];
      if (!before && rows.some(r => r.sender_id === other.id && !r.read_at)) {
        await env.DB.prepare(
          `UPDATE dms SET read_at=datetime('now')
           WHERE recipient_id=? AND sender_id=? AND read_at IS NULL`
        ).bind(sess.userId, other.id).run();
      }
      const youBlockedThem = !!(await env.DB.prepare(
        'SELECT 1 FROM dm_blocks WHERE user_id=? AND blocked_id=?'
      ).bind(sess.userId, other.id).first());
      return jsonResponse({
        partner: {
          username: other.username,
          displayName: other.display_name || other.username,
          avatarUrl: other.avatar_url || null,
          isAdmin: !!other.is_admin
        },
        messages: rows.reverse().map(r => ({
          id: r.id, ts: r.ts,
          fromMe: r.sender_id === sess.userId,
          read: !!r.read_at,
          body: r.body
        })),
        hasMore: rows.length === PAGE,
        youBlockedThem
      });
    }

    // ---------- ACCOUNT PAGE DATA ----------
    if (method === 'GET' && path === '/api/account') {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in' }, { status: 401 });
      await ensureProfileColumn(env);
      const batch = await env.DB.batch([
        env.DB.prepare(`SELECT username, email, is_admin, display_name, bio, profile_json, discord_id, discord_username, avatar_url, email_verified, password_hash, created_at, last_login FROM users WHERE id=?`).bind(sess.userId),
        env.DB.prepare(`SELECT slug, name, team, status, created_at, updated_at FROM characters WHERE owner_id=? AND status IS NOT 'deleted' ORDER BY updated_at DESC`).bind(sess.userId),
        env.DB.prepare(`SELECT slug, display_name AS name, status, created_at, updated_at FROM collections WHERE owner_id=? AND status IS NOT 'deleted' ORDER BY updated_at DESC`).bind(sess.userId),
        env.DB.prepare(`SELECT slug, name, status, created_at, updated_at FROM scripts WHERE owner_id=? AND status IS NOT 'deleted' ORDER BY updated_at DESC`).bind(sess.userId),
        env.DB.prepare(`SELECT ts, action, entity_type, entity_slug, entity_name FROM activity_log WHERE user_id=? ORDER BY ts DESC, id DESC LIMIT 50`).bind(sess.userId)
      ]);
      const u = batch[0].results[0];
      if (!u) return jsonResponse({ error: 'Not logged in' }, { status: 401, 'Set-Cookie': clearCookie() });
      // Custom wiki pages this account owns, drafts included — the account
      // page is where their author manages them.
      let myPages = [];
      try {
        await ensurePagesTable(env);
        const { results } = await env.DB.prepare(
          `SELECT slug, title, parent_type, parent_slug, status, created_at, updated_at
           FROM pages WHERE owner_id=? ORDER BY updated_at DESC`
        ).bind(sess.userId).all();
        myPages = (results || []).map(r => ({
          slug: r.slug, name: r.title, status: r.status,
          parentType: r.parent_type, parentSlug: r.parent_slug,
          created_at: r.created_at, updated_at: r.updated_at
        }));
      } catch { /* non-fatal */ }
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
          lastLogin: u.last_login,
          links: parseProfileExtra(u).links,
          pinned: parseProfileExtra(u).pinned
        },
        characters: batch[1].results,
        collections: batch[2].results,
        scripts: batch[3].results,
        pages: myPages,
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
      // A character can be asked for by identity or by address, so an editor
      // opened from a copied /c/{set}/{name} URL finds the page too.
      if (!row && type === 'character') {
        const found = await resolveCharacterPath(env, slug);
        if (found) row = await getEntityRow(env, 'character', found.row.slug);
      }
      // A renamed page answers on its old slug here too, so an editor opened
      // from a stale link (edit?c={old}) still finds it.
      if (!row) {
        const moved = await lookupRedirect(env, type, slug);
        if (moved) row = await getEntityRow(env, type, moved);
      }
      if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
      const sess = await getSession(env, request);
      const owns = canEditRow(sess, row);
      // 'owner' | 'approved' | 'all' | 'tags' | '': what this reader may
      // actually change, which is what the editor needs before it offers them
      // a form.
      const mode = owns ? 'owner' : await editPermission(env, sess, type, row);
      const editable = !!mode;
      // Soft-deleted pages read as gone; restore from the dashboard first.
      if (row.status === 'deleted') return jsonResponse({ error: 'Not found' }, { status: 404 });
      // A draft is invisible to everyone but the people who may work on it —
      // its owner, and the editors the owner named by hand.
      if (row.status === 'draft' && !owns && mode !== 'approved') {
        return jsonResponse({ error: 'Not found' }, { status: 404 });
      }
      const pageData = foldLegacyCurata(JSON.parse(row.data));
      /* Curata is admin-only to GRANT and the creator's to decline, so the
         editor has to be told which of the two it is looking at before it
         offers the opt-out — and a character usually has the mark because a
         collection lent it, not because anyone starred the page. `curataFrom`
         is the collection's name, worked out the same way the /c/ page works
         it out, so the control can say where the mark came from.
         The probe carries the opt-out itself so that ticking the box and
         re-opening the editor still reports where the mark WOULD come from —
         otherwise the control would vanish the moment it was used. */
      let curataFrom = null;
      if (type === 'character' && !pageData.curata) {
        const probe = { slug: row.slug, appearsIn: pageData.appearsIn || '' };
        await applyCollectionCurata(env, [probe]).catch(() => null);
        if (probe.curata) curataFrom = probe.curataFrom || '';
      }
      /* Approved editing that came from the script or collection this
         character is on, rather than from the character itself. The editor
         needs it to word its banner — see waterfallParent. */
      let editVia = null;
      if (mode === 'approved' && type === 'character' && !isApprovedEditor(sess, parseData(row))) {
        const par = await waterfallParent(env, sess, row).catch(() => null);
        if (par) {
          editVia = {
            type: par.type,
            key: par.type === 'collection' ? (par.data.id || par.slug) : par.slug,
            name: (par.type === 'script' ? par.data.name : par.data.displayName) || par.slug
          };
        }
      }
      return jsonResponse({
        slug: row.slug, data: pageData,
        curataFrom, editVia,
        status: row.status || 'published', canEdit: editable,
        editMode: mode || false, isOwner: owns,
        // The editor posts this back so the Worker can tell a save based on
        // the current row from one based on an hour-old copy.
        updatedAt: row.updated_at || null
      });
    }

    /* ---------- DOES THIS HANDLE EXIST? (the approved-editor picker) -------
       The owner types a username into the editor list and wants to know THERE
       whether it landed, rather than after a save. Deliberately thin: it
       answers with the handle as the site spells it and nothing else, and it
       needs a session — every account here already has a public /u/ page, so
       this reveals nothing new, but there is no reason to hand a stranger a
       name-checking loop.

       The lookup goes through selectUserByName, so `tir-far-thoinn` finds
       `@tir-far-thóinn` exactly as a link would. */
    if (method === 'GET' && path === '/api/account-lookup') {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in' }, { status: 401 });
      const name = (url.searchParams.get('u') || '').trim();
      if (!name) return jsonResponse({ error: 'Missing username' }, { status: 400 });
      const u = await selectUserByName(env, 'id, username', name).catch(() => null);
      if (!u) return jsonResponse({ found: false });
      return jsonResponse({ found: true, id: Number(u.id), username: String(u.username) });
    }

    /* ---------- PAGES SHARED WITH THIS ACCOUNT (approved editing) ----------
       Being named as an editor arrives as a message with a link, but a message
       scrolls away. This is the standing list, and without it an editor has no
       way back to a page they were invited to — a shared DRAFT in particular
       is in no feed, no search and no browse page by design.

       Its own request rather than part of /api/account, for the same reason
       the suggestions inbox is: it is empty for almost everybody.

       The LIKE is a coarse filter that only has to be cheap and never miss:
       sanitizePublicEdit + JSON.stringify are the only writers of this field,
       so the stored form is exactly `"publicEdit":"approved"`. isApprovedEditor
       below is what actually decides. */
    if (method === 'GET' && path === '/api/shared-pages') {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in' }, { status: 401 });
      const tables = [
        ['character', 'characters', 'name'],
        ['script', 'scripts', 'name'],
        ['collection', 'collections', 'display_name']
      ];
      const out = [];
      for (const [type, table, nameCol] of tables) {
        let rows = [];
        try {
          ({ results: rows } = await env.DB.prepare(
            `SELECT slug, ${nameCol} AS name, owner_id, status, data, updated_at FROM ${table}
              WHERE status IN ('published','draft') AND data LIKE '%"publicEdit":"approved"%'`
          ).all());
        } catch { rows = []; }
        for (const r of rows || []) {
          // A page this account already owns belongs in its own drafts and its
          // own page list, not here. Admins own everything for this purpose,
          // so their list is empty, which is right: they are not guests.
          if (canEditRow(sess, r)) continue;
          if (!isApprovedEditor(sess, parseData(r))) continue;
          if (!(await canEditPage(env, sess, type, r))) continue;   // protection, mostly
          const d = parseData(r);
          out.push({
            type, slug: r.slug,
            key: type === 'collection' ? (d.id || r.slug) : r.slug,
            name: r.name || r.slug,
            status: r.status || 'published',
            updatedAt: r.updated_at || null,
            /* Editing a script or a collection carries down to the owner's own
               characters on it (waterfallEditor). The characters themselves
               are not listed here — a roster of 200 would bury the four pages
               actually shared with this account — so the row says so instead,
               and the parent page is the way to them. */
            sharesRoster: type !== 'character'
          });
        }
      }
      out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      return jsonResponse({ pages: out.slice(0, 100) });
    }

    // ---------- DISCORD SIGN-IN HEALTH CHECK (admin only) ----------
    // Discord sign-in has two failure modes nothing on the wiki can see on its
    // own, because both happen outside the repo: a Git deploy wiping a
    // dashboard variable that was typed as "Text" instead of "Secret", and the
    // callback URL going missing from the Discord Developer Portal. Both look
    // identical from a reader's seat — the button just stops working — and
    // neither shows up in any test. This asks Discord directly, so the answer
    // is one tap on the dashboard instead of an afternoon of guessing.
    if (method === 'GET' && path === '/api/admin/discord-check') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });

      const redirectUri = discordRedirectUri(env);
      const out = {
        clientId: !!env.DISCORD_CLIENT_ID,
        clientSecret: !!env.DISCORD_CLIENT_SECRET,
        redirectUri,
        canonicalOrigin: canonicalOrigin(env),
        requestOrigin: url.origin,
        // A reader on this hostname is handed over to the canonical one before
        // the flow starts, so this is a note, not a fault.
        originPinned: onCanonicalOrigin(env, url)
      };
      if (!out.clientId || !out.clientSecret) {
        out.ok = false;
        out.status = 'Not configured: ' +
          (!out.clientId && !out.clientSecret ? 'both DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are missing'
            : !out.clientId ? 'DISCORD_CLIENT_ID is missing' : 'DISCORD_CLIENT_SECRET is missing') +
          '. Re-add them in the Cloudflare dashboard as type Secret (a Text variable is deleted by the next Git deploy).';
        return jsonResponse(out);
      }

      // Ask Discord whether the ID and secret are still a valid pair. This
      // grant needs no reader and no consent screen, so it can be run any time.
      try {
        const res = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + btoa(env.DISCORD_CLIENT_ID + ':' + env.DISCORD_CLIENT_SECRET)
          },
          body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'identify' })
        });
        if (res.ok) {
          out.ok = true;
          out.status = 'Discord accepted the app credentials.';
        } else {
          const detail = await discordErrorCode(res);
          out.ok = false;
          if (/invalid_client/i.test(detail)) {
            out.status = 'Discord rejected the app credentials (' + detail + '). The client secret is wrong or has been reset — copy it again from the Discord Developer Portal and re-save it in Cloudflare as type Secret.';
          } else {
            // Anything else is Discord declining THIS grant, which is not the
            // same as sign-in being broken. Saying so keeps the check from
            // crying wolf and sending someone off to re-set a working secret.
            out.inconclusive = true;
            out.status = 'Could not confirm either way — Discord answered ' + res.status + ' (' + detail + ') to the credential check. This does not mean sign-in is broken; check the callback URL below.';
          }
        }
      } catch (e) {
        out.ok = false;
        out.inconclusive = true;
        out.status = 'Could not reach Discord: ' + String(e && e.message || e).slice(0, 120);
      }

      // Credentials being valid does NOT mean the callback URL is registered —
      // that list is only readable from the portal, and an unregistered URL is
      // exactly what produces "Invalid OAuth2 redirect_uri". So the check
      // always hands over the string to compare against, character for
      // character, rather than implying it has checked it.
      out.note = 'Discord Developer Portal -> your application -> OAuth2 -> Redirects must contain this exact URL: ' + redirectUri;
      return jsonResponse(out);
    }

    // ---------- ADMIN DASHBOARD (read, admin only) ----------
    if (method === 'GET' && path === '/api/admin/dashboard') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });

      const batch = await env.DB.batch([
        env.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM characters  WHERE status IS NOT 'deleted') AS characters,
             (SELECT COUNT(*) FROM collections WHERE status IS NOT 'deleted') AS collections,
             (SELECT COUNT(*) FROM scripts     WHERE status IS NOT 'deleted') AS scripts,
             (SELECT COUNT(*) FROM users)       AS users`),
        env.DB.prepare(
          `SELECT team, COUNT(*) AS n FROM characters WHERE status IS NOT 'deleted' GROUP BY team ORDER BY n DESC`),
        env.DB.prepare(
          `SELECT 'character' AS type, slug, name, updated_at FROM characters WHERE status IS NOT 'deleted'
           UNION ALL SELECT 'collection', slug, display_name, updated_at FROM collections WHERE status IS NOT 'deleted'
           UNION ALL SELECT 'script', slug, name, updated_at FROM scripts WHERE status IS NOT 'deleted'
           ORDER BY updated_at DESC LIMIT 15`),
        env.DB.prepare(
          `SELECT 'character' AS type, slug, name, created_at FROM characters WHERE status IS NOT 'deleted'
           UNION ALL SELECT 'collection', slug, display_name, created_at FROM collections WHERE status IS NOT 'deleted'
           UNION ALL SELECT 'script', slug, name, created_at FROM scripts WHERE status IS NOT 'deleted'
           ORDER BY created_at DESC LIMIT 15`),
        env.DB.prepare(
          `SELECT ts, username, action, entity_type, entity_slug, entity_name
           FROM activity_log ORDER BY ts DESC, id DESC LIMIT 25`),
        env.DB.prepare(
          `SELECT username, email, is_admin, created_at FROM users
           ORDER BY created_at DESC LIMIT 15`),
        env.DB.prepare(`SELECT value FROM settings WHERE key='wiki_locked'`),
        env.DB.prepare(
          `SELECT 'collection' AS type, slug, display_name AS name FROM collections WHERE owner_id IS NULL AND status IS NOT 'deleted'
           UNION ALL SELECT 'script', slug, name FROM scripts WHERE owner_id IS NULL AND status IS NOT 'deleted'
           UNION ALL SELECT 'character', slug, name FROM characters WHERE owner_id IS NULL AND status IS NOT 'deleted'
           ORDER BY type, name LIMIT 200`),
        env.DB.prepare(
          `SELECT 'character' AS type, slug, name, updated_at, data FROM characters WHERE status='deleted'
           UNION ALL SELECT 'collection', slug, display_name, updated_at, data FROM collections WHERE status='deleted'
           UNION ALL SELECT 'script', slug, name, updated_at, data FROM scripts WHERE status='deleted'
           ORDER BY updated_at DESC LIMIT 200`),
        env.DB.prepare(`SELECT key FROM settings WHERE key LIKE 'protected:%' ORDER BY key`)
      ]);

      const lockVal = batch[6].results[0];
      // Trim the deleted rows down to just what the panel needs (name, when,
      // and who/when it was deleted) — never ship the whole data blob.
      const deleted = (batch[8].results || []).map(r => {
        let meta = {};
        try { meta = (JSON.parse(r.data || '{}')._deleted) || {}; } catch { /* ignore */ }
        return {
          type: r.type, slug: r.slug, name: r.name,
          updated_at: r.updated_at,
          deletedAt: meta.at || null, deletedBy: meta.by || null, deletedFrom: meta.from || null
        };
      });
      // settings keys look like protected:{type}:{slug}
      const protectedPages = (batch[9].results || []).map(r => {
        const parts = String(r.key).split(':');
        return { type: parts[1] || '', slug: parts.slice(2).join(':') };
      }).filter(p => p.type && p.slug);
      return jsonResponse({
        counts: batch[0].results[0],
        charactersByTeam: batch[1].results,
        recentEdits: batch[2].results,
        recentCreations: batch[3].results,
        recentActivity: batch[4].results,
        recentSignups: batch[5].results,
        locked: !!lockVal && lockVal.value === '1',
        unowned: batch[7].results,
        deleted: deleted,
        protectedPages: protectedPages
      });
    }

    // ---------- ADMIN: FULL ACTIVITY LOG (paginated + filterable) ----------
    // ?limit=50 (max 200), ?before={id} to page further back, and optional
    // filters: ?user= (username), ?action=, ?type= (entity_type), ?days=N.
    if (method === 'GET' && path === '/api/admin/activity') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      const q = url.searchParams;
      const limit = Math.min(Math.max(parseInt(q.get('limit') || '50', 10) || 50, 1), 200);
      const filters = [];
      const fBinds = [];
      const uname = (q.get('user') || '').trim();
      if (uname) {
        // activity_log.username is a copy of users.username taken at write
        // time, so resolve the account and match its exact spelling. Falls back
        // to the ASCII comparison for the log rows of a deleted account.
        const who = await findUserByUsername(env, uname);
        if (who) { filters.push('username = ?'); fBinds.push(who.username); }
        else { filters.push('lower(username)=lower(?)'); fBinds.push(uname); }
      }
      const action = (q.get('action') || '').trim();
      if (action.endsWith('*')) {
        // "comment*" -> every comment action in one filter (comment,
        // comment-reply, comment-remove, comment-pin, …). LIKE is safe here:
        // the prefix is matched literally and % / _ are stripped first.
        const stem = action.slice(0, -1).replace(/[%_\\]/g, '');
        if (stem) { filters.push("action LIKE ?"); fBinds.push(stem + '%'); }
      } else if (action) {
        filters.push('action=?'); fBinds.push(action);
      }
      const etype = (q.get('type') || '').trim();
      if (etype) { filters.push('entity_type=?'); fBinds.push(etype); }
      const days = parseInt(q.get('days') || '0', 10) || 0;
      if (days > 0) { filters.push("ts >= datetime('now', ?)"); fBinds.push('-' + Math.min(days, 3650) + ' days'); }
      const rowWh = filters.slice();
      const rowBinds = fBinds.slice();
      const before = parseInt(q.get('before') || '0', 10) || 0;
      if (before) { rowWh.push('id < ?'); rowBinds.push(before); }
      // The COUNT is a full scan of the largest write-heavy table when no
      // filter narrows it, and it was being run again on every page of the
      // cursor — for a number the UI only shows once, above the first page.
      // Run it on the first page only; later pages keep the total they have.
      const wantTotal = !before;
      const jobs = [
        env.DB.prepare(
          'SELECT id, ts, username, action, entity_type, entity_slug, entity_name FROM activity_log' +
          (rowWh.length ? ' WHERE ' + rowWh.join(' AND ') : '') +
          ' ORDER BY id DESC LIMIT ?'
        ).bind(...rowBinds, limit).all()
      ];
      if (wantTotal) {
        jobs.push(env.DB.prepare(
          'SELECT COUNT(*) AS n FROM activity_log' +
          (filters.length ? ' WHERE ' + filters.join(' AND ') : '')
        ).bind(...fBinds).first());
      }
      const [rowsRes, totalRes] = await Promise.all(jobs);
      const rows = rowsRes.results || [];
      return jsonResponse({
        rows,
        total: wantTotal ? (totalRes ? totalRes.n : rows.length) : null,
        hasMore: rows.length === limit,
        nextBefore: rows.length ? rows[rows.length - 1].id : null
      });
    }

    // ---------- ADMIN: ACTIVITY REPORT FOR A TIME WINDOW ----------
    // ?days=N (1–365, default 7). Summarizes everything in the window plus
    // the full event log (capped at 1000 rows for the download).
    if (method === 'GET' && path === '/api/admin/report') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10) || 7, 1), 365);
      const since = '-' + days + ' days';
      const batch = await env.DB.batch([
        env.DB.prepare(
          `SELECT action, COUNT(*) AS n FROM activity_log WHERE ts >= datetime('now', ?)
           GROUP BY action ORDER BY n DESC`).bind(since),
        env.DB.prepare(
          `SELECT entity_type, action, COUNT(*) AS n FROM activity_log
           WHERE ts >= datetime('now', ?) AND entity_type IN ('character','collection','script')
           GROUP BY entity_type, action ORDER BY entity_type, n DESC`).bind(since),
        env.DB.prepare(
          `SELECT username, COUNT(*) AS n FROM activity_log
           WHERE ts >= datetime('now', ?) AND username IS NOT NULL
           GROUP BY username ORDER BY n DESC LIMIT 10`).bind(since),
        env.DB.prepare(
          `SELECT entity_type, entity_slug, MAX(entity_name) AS entity_name, COUNT(*) AS n
           FROM activity_log WHERE ts >= datetime('now', ?) AND entity_slug IS NOT NULL
           GROUP BY entity_type, entity_slug ORDER BY n DESC LIMIT 10`).bind(since),
        env.DB.prepare(
          `SELECT username, created_at FROM users WHERE created_at >= datetime('now', ?)
           ORDER BY created_at DESC LIMIT 100`).bind(since),
        env.DB.prepare(
          `SELECT COUNT(*) AS n FROM activity_log WHERE ts >= datetime('now', ?)`).bind(since),
        env.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM characters  WHERE status IS NOT 'deleted') AS characters,
             (SELECT COUNT(*) FROM collections WHERE status IS NOT 'deleted') AS collections,
             (SELECT COUNT(*) FROM scripts     WHERE status IS NOT 'deleted') AS scripts,
             (SELECT COUNT(*) FROM users)       AS users`),
        env.DB.prepare(
          `SELECT ts, username, action, entity_type, entity_slug, entity_name FROM activity_log
           WHERE ts >= datetime('now', ?) ORDER BY id DESC LIMIT 1000`).bind(since)
      ]);
      const log = batch[7].results || [];
      return jsonResponse({
        generatedAt: new Date().toISOString(),
        days,
        activityCount: batch[5].results[0] ? batch[5].results[0].n : 0,
        byAction: batch[0].results,
        contentByType: batch[1].results,
        topUsers: batch[2].results,
        topPages: batch[3].results,
        newUsers: batch[4].results,
        siteTotals: batch[6].results[0] || {},
        log,
        logTruncated: log.length === 1000
      });
    }

    // ---------- ADMIN: VERSION HISTORY FOR ONE PAGE ----------
    if (method === 'GET' && path === '/api/admin/revisions') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      const type = url.searchParams.get('type') || '';
      // REVISABLE, not CONTENT: wiki-page history is written like every other
      // type's and was unreachable purely because this guard did not know the
      // word — while publish-page.html told people it could not be restored.
      if (!REVISABLE[type]) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
      const slugParam = (url.searchParams.get('slug') || '').trim();
      if (!slugParam) return jsonResponse({ error: 'Missing slug' }, { status: 400 });
      const row = await revisableRow(env, type, slugParam);
      const pk = row ? row.slug : slugParam;
      await ensureRevisionsTable(env);
      const { results } = await env.DB.prepare(
        `SELECT id, ts, name, status, edited_by, length(data) AS bytes
         FROM revisions WHERE entity_type=? AND slug=? ORDER BY id DESC`
      ).bind(type, pk).all();
      return jsonResponse({
        slug: pk,
        current: row ? { name: row.name, status: row.status || 'published' } : null,
        revisions: results || []
      });
    }

    // ---------- PAGE HISTORY (the page's OWNER, or an admin) ----------
    // Deliberately outside /api/admin/: rollback used to be admin-only, so an
    // owner whose page had been clobbered — by a stale admin tab, or by their
    // own second window — had to file a contact-form message and wait for
    // somebody to fix it. They can see and undo their own history now.
    if (method === 'GET' && path === '/api/page-history') {
      const type = url.searchParams.get('type') || '';
      const slugParam = (url.searchParams.get('slug') || '').trim();
      if (!REVISABLE[type]) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
      if (!slugParam) return jsonResponse({ error: 'Missing slug' }, { status: 400 });
      const row = await revisableRow(env, type, slugParam);
      if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
      const sess = await getSession(env, request);
      const owns = canEditRow(sess, row);
      // A published page's history is public, the way a wiki's is. A draft is
      // its owner's alone, and has no history anyway (see saveRevision).
      if ((row.status || 'published') !== 'published' && !owns) {
        return jsonResponse({ error: 'Not found' }, { status: 404 });
      }
      await ensureRevisionsTable(env);
      const { results } = await env.DB.prepare(
        `SELECT id, ts, name, status, edited_by, data, length(data) AS bytes
           FROM revisions WHERE entity_type=? AND slug=? ORDER BY id ASC`
      ).bind(type, row.slug).all();
      const revs = results || [];
      /* Each row is the page as it stood BEFORE the save that replaced it,
         stamped with who made that save. So an entry describes the difference
         between it and whatever came next: the following snapshot, or the page
         as it stands now for the newest one. */
      const entries = revs.map((r, i) => {
        const after = i + 1 < revs.length ? revs[i + 1].data : row.data;
        return {
          id: r.id, ts: r.ts, by: r.edited_by || null,
          name: r.name, status: r.status, bytes: r.bytes,
          changed: diffFieldLabels(r.data, after)
        };
      }).reverse();
      return jsonResponse({
        type, slug: row.slug,
        name: row.name || row.slug,
        status: row.status || 'published',
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        canRestore: owns,
        publicEdit: publicEditMode(parseData(row)) || '',
        entries
      });
    }

    /* Suggested edits: one page's list, or everything waiting on the pages you
       own (?inbox=1). A page's list is for the people who can act on it: its
       owner, an admin, and each suggester's own entries. */
    if (method === 'GET' && path === '/api/suggestions') {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in.' }, { status: 401 });
      await ensureSuggestTable(env);

      if (url.searchParams.get('inbox')) {
        // Everything open on a page this account owns. The join is done in JS
        // because the four content types live in four tables.
        const out = [];
        for (const [type, t] of Object.entries(CONTENT)) {
          const { results } = await env.DB.prepare(
            `SELECT s.id, s.entity_type, s.slug, s.username, s.note, s.ts, s.base_updated_at,
                    r.${t.nameCol} AS name, r.updated_at
               FROM suggestions s JOIN ${t.table} r ON r.slug = s.slug
              WHERE s.entity_type=? AND s.status='open' AND r.owner_id=?
              ORDER BY s.id DESC LIMIT 100`
          ).bind(type, sess.userId).all().catch(() => ({ results: [] }));
          (results || []).forEach(r => out.push(r));
        }
        out.sort((a, b) => (b.id - a.id));
        return jsonResponse({ inbox: out.slice(0, 100) });
      }

      const type = url.searchParams.get('type') || '';
      const slugParam = (url.searchParams.get('slug') || '').trim();
      if (!REVISABLE[type] || !slugParam) return jsonResponse({ error: 'Missing type or slug' }, { status: 400 });
      const row = await revisableRow(env, type, slugParam);
      if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
      const owns = canEditRow(sess, row);
      const { results } = await env.DB.prepare(
        `SELECT id, user_id, username, note, base_updated_at, status, reply,
                decided_by, decided_at, ts, data
           FROM suggestions WHERE entity_type=? AND slug=? ORDER BY id DESC LIMIT 100`
      ).bind(type, row.slug).all().catch(() => ({ results: [] }));
      const mine = (results || []).filter(r => owns || r.user_id === sess.userId);
      return jsonResponse({
        type, slug: row.slug, name: row.name || row.slug,
        updatedAt: row.updated_at || null,
        canReview: owns,
        suggestions: mine.map(r => ({
          id: r.id, by: r.username || null, mine: r.user_id === sess.userId,
          note: r.note || '', status: r.status, reply: r.reply || '',
          decidedBy: r.decided_by || null, decidedAt: r.decided_at || null,
          ts: r.ts, stale: !!(r.base_updated_at && row.updated_at && r.base_updated_at !== row.updated_at),
          // What the suggestion would change about the page as it stands now.
          changes: diffFieldValues(row.data, r.data)
        }))
      });
    }

    /* One entry of a page's history in detail: every field that changed, with
       what it said before and after, so the edit can be read before deciding
       whether to put the old version back. Same visibility rule as the history
       itself: public for a published page. */
    if (method === 'GET' && path === '/api/page-revision') {
      const type = url.searchParams.get('type') || '';
      const slugParam = (url.searchParams.get('slug') || '').trim();
      const id = parseInt(url.searchParams.get('id'), 10) || 0;
      if (!REVISABLE[type]) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
      if (!slugParam || !id) return jsonResponse({ error: 'Missing slug or id' }, { status: 400 });
      const row = await revisableRow(env, type, slugParam);
      if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
      const sess = await getSession(env, request);
      const owns = canEditRow(sess, row);
      if ((row.status || 'published') !== 'published' && !owns) {
        return jsonResponse({ error: 'Not found' }, { status: 404 });
      }
      await ensureRevisionsTable(env);
      const rev = await env.DB.prepare(
        'SELECT id, ts, edited_by, data FROM revisions WHERE id=? AND entity_type=? AND slug=?'
      ).bind(id, type, row.slug).first().catch(() => null);
      if (!rev) return jsonResponse({ error: 'No such revision for that page.' }, { status: 404 });
      // The version that replaced this one: the next snapshot up, or the page
      // as it stands now.
      const next = await env.DB.prepare(
        'SELECT data FROM revisions WHERE entity_type=? AND slug=? AND id>? ORDER BY id ASC LIMIT 1'
      ).bind(type, row.slug, id).first().catch(() => null);
      return jsonResponse({
        id: rev.id, ts: rev.ts, by: rev.edited_by || null,
        fields: diffFieldValues(rev.data, next ? next.data : row.data)
      });
    }

    // ---------- ADMIN: USER LIST (users panel; ?q= searches) ----------
    if (method === 'GET' && path === '/api/admin/users') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      await ensureBanColumn(env);
      // 48, not unbounded: D1 errors on a LIKE pattern over 50 characters.
      const q = (url.searchParams.get('q') || '').trim().slice(0, 48);
      let sql =
        `SELECT u.id, u.username, u.display_name, u.email, u.is_admin,
                COALESCE(u.banned, 0) AS banned, u.created_at, u.last_login,
                (SELECT COUNT(*) FROM characters  WHERE owner_id=u.id AND status IS NOT 'deleted') AS characters,
                (SELECT COUNT(*) FROM scripts     WHERE owner_id=u.id AND status IS NOT 'deleted') AS scripts,
                (SELECT COUNT(*) FROM collections WHERE owner_id=u.id AND status IS NOT 'deleted') AS collections
         FROM users u`;
      const binds = [];
      if (q) {
        sql += ' WHERE u.username LIKE ? OR u.display_name LIKE ? OR u.email LIKE ?';
        const like = '%' + q + '%';
        binds.push(like, like, like);
      }
      sql += ' ORDER BY u.created_at DESC LIMIT 200';
      const { results } = await env.DB.prepare(sql).bind(...binds).all();
      return jsonResponse({ users: results || [], me: sess.userId });
    }

    // ---- every handle, for the dashboard's type-ahead ----
    // /api/admin/users cannot serve this: it counts each account's pages with
    // three subqueries per row and stops at the 200 newest, so the accounts an
    // admin most often reaches for — the ones that have been here longest —
    // are exactly the ones missing from it. This is the two columns a
    // suggestion list shows and nothing else.
    if (method === 'GET' && path === '/api/admin/user-names') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      const { results } = await env.DB.prepare(
        'SELECT username, display_name FROM users ORDER BY username LIMIT 3000'
      ).all().catch(() => ({ results: [] }));
      return jsonResponse({ users: results || [] });
    }

    // ---------- ADMIN: CONTACT-FORM INBOX ----------
    if (method === 'GET' && path === '/api/admin/messages') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      await ensureMessagesTable(env);
      const status = url.searchParams.get('status') || 'open';
      let sql = 'SELECT id, ts, user_id, username, category, body, status, last_reply, replied_at, replied_by FROM messages';
      const binds = [];
      if (status !== 'all') { sql += ' WHERE status=?'; binds.push(status === 'resolved' ? 'resolved' : 'open'); }
      sql += ' ORDER BY id DESC LIMIT 200';
      const [list, open] = await Promise.all([
        env.DB.prepare(sql).bind(...binds).all(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE status='open'").first()
      ]);
      return jsonResponse({ messages: list.results || [], openCount: open ? open.n : 0 });
    }

    // ---------- ADMIN: REPORTED DM CONVERSATIONS ----------
    // ---- new-account watchlist ----
    // Signup is deliberately open and needs no email verification, so the
    // highest-risk cohort is simply "accounts that appeared recently". This is
    // the compensating control for that decision: one screen showing who is
    // new and how much they have already published, so a spam run is visible
    // as a row rather than as a hundred scattered pages.
    if (method === 'GET' && path === '/api/admin/new-users') {
      await ensureBanColumn(env);
      const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days'), 10) || 7));
      const { results } = await env.DB.prepare(
        `SELECT u.id, u.username, u.display_name, u.email, u.created_at,
                COALESCE(u.banned,0) AS banned, u.is_admin, u.email_verified,
                (SELECT COUNT(*) FROM characters  c WHERE c.owner_id = u.id) AS characters,
                (SELECT COUNT(*) FROM collections o WHERE o.owner_id = u.id) AS collections,
                (SELECT COUNT(*) FROM scripts     s WHERE s.owner_id = u.id) AS scripts,
                (SELECT COUNT(*) FROM comments    m WHERE m.user_id  = u.id) AS comments,
                (SELECT COUNT(*) FROM dms         d WHERE d.sender_id = u.id) AS dms_sent
           FROM users u
          WHERE u.created_at >= datetime('now', ?)
          ORDER BY u.created_at DESC
          LIMIT 200`
      ).bind('-' + days + ' day').all();
      const users = (results || []).map(r => ({
        ...r,
        // What actually matters at a glance: total output, so the list can be
        // read for outliers rather than scanned column by column.
        total: (r.characters || 0) + (r.collections || 0) + (r.scripts || 0) + (r.comments || 0)
      }));
      return jsonResponse({ days, users });
    }

    // ---- queue counts for the dashboard tab badges ----
    // One cheap call so the tab strip can say what is waiting without the page
    // having to open (and pay for) every tab. Every count here is an indexed
    // COUNT(*) against a status column — see the launch-scale indexes in
    // migration/schema.sql; these three tables had no indexes at all before.
    if (method === 'GET' && path === '/api/admin/queue-counts') {
      const one = async (sql, ...binds) => {
        try {
          const r = await env.DB.prepare(sql).bind(...binds).first();
          return r ? Number(r.n) || 0 : 0;
        } catch { return 0; }
      };
      const [reportedComments, reportedDms, openMessages, newUsers] = await Promise.all([
        one("SELECT COUNT(*) AS n FROM comment_reports WHERE status='open'"),
        one("SELECT COUNT(*) AS n FROM dm_reports WHERE status='open'"),
        one("SELECT COUNT(*) AS n FROM messages WHERE status='open'"),
        // The new-account cohort is the one worth watching, because signup is
        // deliberately open and unverified — this is the compensating control.
        one("SELECT COUNT(*) AS n FROM users WHERE created_at >= datetime('now','-7 day')")
      ]);
      // The lock state rides along because this is the one call the dashboard
      // makes on every load. It used to come from /api/admin/dashboard, which
      // is now lazy-loaded with the Health tab — and the lock banner has to be
      // correct from the first paint regardless of which tab you land on.
      const locked = await isWikiLocked(env);
      // Last backup result, so a nightly backup that has quietly stopped
      // working is visible on the dashboard instead of on the day it is needed.
      let backup = null;
      try {
        const r = await env.DB.prepare("SELECT value FROM settings WHERE key='last_backup'").first();
        if (r && r.value) backup = JSON.parse(r.value);
      } catch { /* no backup has run since this was added */ }
      return jsonResponse({ reportedComments, reportedDms, openMessages, newUsers, locked, backup });
    }

    if (method === 'GET' && path === '/api/admin/dm-reports') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      await ensureDmTables(env);
      const status = url.searchParams.get('status') || 'open';
      let sql =
        `SELECT r.id, r.ts, r.reason, r.status,
                ru.username AS reporter, tu.username AS reported
         FROM dm_reports r
         LEFT JOIN users ru ON ru.id=r.reporter_id
         LEFT JOIN users tu ON tu.id=r.reported_id`;
      const binds = [];
      if (status !== 'all') { sql += ' WHERE r.status=?'; binds.push(status === 'resolved' ? 'resolved' : 'open'); }
      sql += ' ORDER BY r.id DESC LIMIT 200';
      const [list, open] = await Promise.all([
        env.DB.prepare(sql).bind(...binds).all(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM dm_reports WHERE status='open'").first()
      ]);
      return jsonResponse({ reports: list.results || [], openCount: open ? open.n : 0 });
    }

    // ---------- ADMIN: TRANSCRIPT OF A REPORTED CONVERSATION ----------
    // Privacy guard: only conversations someone reported can be opened, and
    // only by an admin. ?a= and ?b= are the two usernames.
    if (method === 'GET' && path === '/api/admin/dm-thread') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      await ensureDmTables(env);
      const ua = await findUserByUsername(env, (url.searchParams.get('a') || '').trim());
      const ub = await findUserByUsername(env, (url.searchParams.get('b') || '').trim());
      if (!ua || !ub) return jsonResponse({ error: 'No such user.' }, { status: 404 });
      const reported = await env.DB.prepare(
        `SELECT 1 FROM dm_reports
         WHERE (reporter_id=?1 AND reported_id=?2) OR (reporter_id=?2 AND reported_id=?1)`
      ).bind(ua.id, ub.id).first();
      if (!reported) {
        return jsonResponse({ error: 'That conversation has not been reported, so it stays private.' }, { status: 403 });
      }
      const { results } = await env.DB.prepare(
        `SELECT id, ts, sender_id, body FROM dms
         WHERE (sender_id=?1 AND recipient_id=?2) OR (sender_id=?2 AND recipient_id=?1)
         ORDER BY id DESC LIMIT 100`
      ).bind(ua.id, ub.id).all();
      return jsonResponse({
        a: ua.username, b: ub.username,
        messages: (results || []).reverse().map(r => ({
          id: r.id, ts: r.ts,
          from: r.sender_id === ua.id ? ua.username : ub.username,
          body: r.body
        }))
      });
    }

    // ---------- ADMIN: ORPHANED IMAGES (R2 objects no page references) ----------
    if (method === 'GET' && path === '/api/admin/orphans') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      if (!env.ART) return jsonResponse({ error: 'Image storage (R2) is not configured' }, { status: 500 });
      // Every image path mentioned anywhere in any page's JSON (all statuses:
      // drafts and trashed pages still need their art if restored).
      // Wiki pages and news articles can embed any assets/ path in their body
      // text, so their tables count as references too — without them an image
      // a /p/ page uses looks orphaned and could be purged out from under it.
      await ensurePagesTable(env);
      await ensureNewsTable(env);
      const refs = new Set();
      for (const tbl of ['characters', 'collections', 'scripts', 'pages', 'news']) {
        const { results } = await env.DB.prepare(`SELECT data FROM ${tbl}`).all()
          .catch(() => ({ results: [] }));
        for (const r of results || []) {
          const found = String(r.data).match(/(?:art|scripts|collections)\/[A-Za-z0-9._ -]+\.(?:png|jpe?g|webp|gif|svg)/gi) || [];
          for (const f of found) refs.add(f.toLowerCase());
        }
      }
      const userIds = new Set(
        ((await env.DB.prepare('SELECT id FROM users').all()).results || []).map(r => String(r.id))
      );
      const orphans = [];
      let totalBytes = 0;
      let truncated = false;
      for (const prefix of ['art/', 'scripts/', 'collections/', 'avatars/']) {
        let cursor;
        do {
          const listed = await env.ART.list({ prefix, cursor, limit: 1000 });
          for (const o of listed.objects) {
            let orphan;
            if (prefix === 'avatars/') {
              // avatars/u{id}.{ext} is orphaned when that account no longer exists
              const m = o.key.match(/^avatars\/u(\d+)\./);
              orphan = !!m && !userIds.has(m[1]);
            } else {
              orphan = !refs.has(o.key.toLowerCase());
            }
            if (!orphan) continue;
            totalBytes += o.size || 0;
            if (orphans.length < 500) {
              orphans.push({ key: o.key, size: o.size || 0, uploaded: o.uploaded || null });
            } else {
              truncated = true;
            }
          }
          cursor = listed.truncated ? listed.cursor : null;
        } while (cursor);
      }
      return jsonResponse({ orphans, totalBytes, truncated });
    }

    // ---------- ADMIN: BROKEN CHARACTER REFERENCES ----------
    if (method === 'GET' && path === '/api/admin/broken-refs') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      const charStatus = {};
      for (const r of (await env.DB.prepare('SELECT slug, status FROM characters').all()).results || []) {
        charStatus[r.slug] = r.status || 'published';
      }
      const official = new Set((await loadOfficialRoles(env, url.origin)).map(r => r.slug));
      function checkRefs(list) {
        const missing = [], deleted = [], draft = [];
        for (const raw of list || []) {
          const s = String(raw);
          if (official.has(s)) continue;
          const st = charStatus[s];
          if (st === undefined) missing.push(s);
          else if (st === 'deleted') deleted.push(s);
          else if (st === 'draft') draft.push(s);
        }
        return { missing, deleted, draft };
      }
      const issues = [];
      let checkedScripts = 0, checkedCollections = 0;
      for (const r of (await env.DB.prepare(
        "SELECT slug, name, status, data FROM scripts WHERE status IS NOT 'deleted'").all()).results || []) {
        checkedScripts++;
        let d; try { d = foldLegacyCurata(JSON.parse(r.data)); } catch { continue; }
        const res = checkRefs(d.characters);
        if (res.missing.length || res.deleted.length || res.draft.length) {
          issues.push({ type: 'script', slug: r.slug, name: r.name, status: r.status, ...res });
        }
      }
      for (const r of (await env.DB.prepare(
        "SELECT slug, display_name AS name, status, data FROM collections WHERE status IS NOT 'deleted'").all()).results || []) {
        checkedCollections++;
        let d; try { d = foldLegacyCurata(JSON.parse(r.data)); } catch { continue; }
        const res = checkRefs((d.include || []).concat(d.exclude || []));
        if (res.missing.length || res.deleted.length || res.draft.length) {
          issues.push({ type: 'collection', slug: r.slug, name: r.name, status: r.status, ...res });
        }
      }
      return jsonResponse({ issues, checkedScripts, checkedCollections });
    }

    // ---------- ADMIN: BACKUP BROWSER ----------
    if (method === 'GET' && path === '/api/admin/backups') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      if (!env.ART) return jsonResponse({ error: 'Image storage (R2) is not configured' }, { status: 500 });
      const byDate = {};
      let cursor;
      do {
        const listed = await env.ART.list({ prefix: 'backups/', cursor, limit: 1000 });
        for (const o of listed.objects) {
          const m = o.key.match(/^backups\/(\d{4}-\d{2}-\d{2})\/([a-z_]+)\.json$/);
          if (!m) continue;
          (byDate[m[1]] = byDate[m[1]] || []).push({ table: m[2], size: o.size || 0 });
        }
        cursor = listed.truncated ? listed.cursor : null;
      } while (cursor);
      const backups = Object.keys(byDate).sort().reverse().map(date => ({
        date, tables: byDate[date].sort((a, b) => a.table < b.table ? -1 : 1)
      }));
      return jsonResponse({ backups });
    }

    // ---------- ADMIN: DOWNLOAD ONE BACKUP TABLE ----------
    if (method === 'GET' && path === '/api/admin/backup-file') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      if (!env.ART) return jsonResponse({ error: 'Image storage (R2) is not configured' }, { status: 500 });
      const date = url.searchParams.get('date') || '';
      const table = url.searchParams.get('table') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[a-z_]{1,40}$/.test(table)) {
        return jsonResponse({ error: 'Bad date or table.' }, { status: 400 });
      }
      // Concatenated across parts so the downloaded file is the whole table.
      const rows = await readBackupTable(env, date, table);
      if (!rows) return jsonResponse({ error: 'No such backup file.' }, { status: 404 });
      return new Response(JSON.stringify(rows), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="botc-backup-${date}-${table}.json"`,
          'Cache-Control': 'no-store'
        }
      });
    }

    // ---------- ADMIN: COMMENT MODERATION ----------
    // ?view=reported (default) shows open reports; ?view=recent shows the
    // latest comments site-wide; ?view=removed shows what's been taken down.
    if (method === 'GET' && path === '/api/admin/comments') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      await ensureCommentTables(env);
      const view = url.searchParams.get('view') || 'reported';
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);
      const base =
        `SELECT c.id, c.ts, c.entity_type, c.slug, c.body, c.status, c.removed_by, c.removed_at,
                c.parent_id, c.pinned, u.username, u.id AS user_id
         FROM comments c LEFT JOIN users u ON u.id = c.user_id`;
      let sql, binds = [];
      if (view === 'recent') {
        sql = base + " WHERE c.status='visible' ORDER BY c.id DESC LIMIT ?";
        binds = [limit];
      } else if (view === 'removed') {
        // 'hidden' = a reply that went down with its parent, not removed on
        // its own. Shown here too so nothing is invisible to an admin.
        sql = base + " WHERE c.status IN ('removed','hidden') ORDER BY COALESCE(c.removed_at, c.ts) DESC LIMIT ?";
        binds = [limit];
      } else {
        sql = `SELECT c.id, c.ts, c.entity_type, c.slug, c.body, c.status, c.removed_by, c.removed_at,
                      c.parent_id, c.pinned, u.username, u.id AS user_id,
                      COUNT(r.id) AS reports, MAX(r.reason) AS reason
               FROM comment_reports r
               JOIN comments c ON c.id = r.comment_id
               LEFT JOIN users u ON u.id = c.user_id
               WHERE r.status='open'
               GROUP BY c.id ORDER BY MAX(r.id) DESC LIMIT ?`;
        binds = [limit];
      }
      const { results } = await env.DB.prepare(sql).bind(...binds).all().catch(() => ({ results: [] }));
      const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM comment_reports WHERE status='open'")
        .first().catch(() => ({ n: 0 }));
      return jsonResponse({ view, comments: results || [], openReports: (open && open.n) || 0 });
    }

    // ---------- ADMIN: JINX HEALTH ----------
    // Every jinx that points at nothing: a typo, a character that was never
    // imported, or one since renamed or unpublished. On the page itself these
    // just look like a name that does not link anywhere, so nothing else
    // counts them.
    if (method === 'GET' && path === '/api/admin/jinx-health') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });

      const index = await jinxIndex(env, ctx);
      const icons = await officialIconMap(env, url.origin).catch(() => ({}));
      const names = await officialNameMap(env, url.origin).catch(() => ({}));

      const broken = new Map();      // key -> {key, label, count, on[]}
      let official = 0, wiki = 0;
      for (const e of index.edges) {
        if (e.to) { wiki++; continue; }
        if (icons[e.key] || names[e.key]) { official++; continue; }
        const row = broken.get(e.key) ||
          { key: e.key, label: e.name || e.id || e.key, count: 0, on: [] };
        row.count++;
        const from = index.rows[e.from];
        if (from && row.on.length < 25) {
          row.on.push({ slug: from.slug, name: from.name, creator: from.creator });
        }
        broken.set(e.key, row);
      }

      // A pair both sides wrote a rule for: only one of the two is ever
      // shown, so the other is invisible work. Worth surfacing.
      const texts = new Map();
      const conflicts = [];
      for (const e of index.edges) {
        if (!e.to) continue;
        const pair = [e.from, e.to].sort().join('|');
        const prev = texts.get(pair);
        if (prev === undefined) { texts.set(pair, e); continue; }
        if ((prev.text || '').trim() !== (e.text || '').trim()) {
          conflicts.push({
            a: index.rows[prev.from], b: index.rows[e.from],
            aText: prev.text, bText: e.text
          });
        }
      }

      return jsonResponse({
        totals: { official, wiki, broken: [...broken.values()].reduce((n, r) => n + r.count, 0) },
        broken: [...broken.values()].sort((a, b) => b.count - a.count),
        conflicts
      });
    }

    // ---------- ADMIN: PAGE LIST FOR BULK ACTIONS ----------
    if (method === 'GET' && path === '/api/admin/pages') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      const type = url.searchParams.get('type') || '';
      const t = CONTENT[type];
      if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
      // D1 caps LIKE/GLOB patterns at 50 characters and ERRORS above it rather
      // than degrading, so a long search query used to fail the whole request.
      const q = (url.searchParams.get('q') || '').trim().slice(0, 48);
      const owner = (url.searchParams.get('owner') || '').trim();
      const status = (url.searchParams.get('status') || '').trim();
      // Membership lives in the collection's own match/include/exclude, not on
      // the character, so it can't be a WHERE clause — resolved below.
      const collKey = (url.searchParams.get('collection') || '').trim();
      const wh = [];
      const binds = [];
      if (q) {
        wh.push(`(p.slug LIKE ? OR p.${t.nameCol} LIKE ?)`);
        const like = '%' + q + '%';
        binds.push(like, like);
      }
      if (owner === 'none') wh.push('p.owner_id IS NULL');
      else if (owner) { wh.push('lower(u.username)=lower(?)'); binds.push(owner); }
      if (['published', 'draft', 'deleted'].includes(status)) { wh.push('p.status=?'); binds.push(status); }
      else if (status === 'all') { /* every status, deleted included */ }
      else wh.push("p.status IS NOT 'deleted'");
      // Content flags can't be expressed in SQL (they live in the data blob),
      // so pull `data` and filter in JS. 'any' means no flag filter.
      const flag = (url.searchParams.get('flag') || '').trim();
      // Only over-fetch when something below actually filters in JS. With no
      // flag and no collection filter the extra 600 rows were read, parsed and
      // classified purely to be thrown away by the .slice(0, 400) at the end —
      // and `data` is the expensive column in this query, ~3 KB a row.
      const needsJsFilter = !!collKey ||
        ['no-icon', 'partial', 'curata', 'no-owner'].includes(flag);
      const rowLimit = needsJsFilter ? 1000 : 400;
      const { results } = await env.DB.prepare(
        `SELECT p.slug, p.${t.nameCol} AS name, p.status, p.updated_at, u.username AS owner, p.data
         FROM ${t.table} p LEFT JOIN users u ON u.id = p.owner_id
         ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
         ORDER BY p.updated_at DESC LIMIT ${rowLimit}`
      ).bind(...binds).all();
      let pages = (results || []).map(r => {
        const d = parseData(r);
        return {
          slug: r.slug, name: r.name, status: r.status,
          updated_at: r.updated_at, owner: r.owner,
          curata: Classify.isCurata(d),
          // Granted by an admin but declined by the page's creator. The raw
          // flag is still stored (an admin's record of the decision), so the
          // dashboard can say which of the two it is looking at.
          curataOptOut: !!(d.curata && d.curataOptOut),
          classification: Classify.classifyPage(d, type),
          // "hasIcon: true" for a page that does not need one, so the
          // no-icon filter only ever surfaces pages with a real gap.
          hasIcon: type === 'character' ? (!Classify.needsIcon(d) || Classify.hasIcon(d)) : true,
          missing: type === 'character' ? Classify.missingBits(d) : []
        };
      });
      // Narrow to one collection's roster. Composes with everything above, so
      // "collection X + owner none" is the list of that collection's unowned
      // pages — which, with the assign-owner bulk action, is how a whole
      // collection gets handed to an account.
      if (collKey) {
        if (type !== 'character') {
          return jsonResponse({ error: 'The collection filter only applies to characters.' }, { status: 400 });
        }
        const crow = await findCollectionRow(env, collKey);
        if (!crow) return jsonResponse({ error: 'No collection called “' + collKey + '”.' }, { status: 404 });
        const { results: all } = await env.DB.prepare(
          "SELECT slug, appears_in AS appearsIn FROM characters WHERE status IS NOT 'deleted'"
        ).all().catch(() => ({ results: [] }));
        const members = new Set(
          PageRender.resolveCollectionMembers(parseData(crow), all || []).map(x => x.slug)
        );
        pages = pages.filter(p => members.has(p.slug));
      }
      if (flag === 'no-icon') pages = pages.filter(p => !p.hasIcon);
      else if (flag === 'partial') pages = pages.filter(p => p.classification === 'partial');
      else if (flag === 'curata') pages = pages.filter(p => p.curata);
      else if (flag === 'no-owner') pages = pages.filter(p => !p.owner);
      return jsonResponse({ pages: pages.slice(0, 400), total: pages.length });
    }

    // ---------- ADMIN: PAGE-VIEW ANALYTICS ----------
    if (method === 'GET' && path === '/api/admin/analytics') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10) || 7, 1), 365);
      const since = '-' + days + ' day';
      await ensureViewsTable(env);
      await ensureNewsTable(env);  // the name lookup below UNIONs both of
      await ensurePagesTable(env); // these in
      const names =
        `(SELECT 'character' AS t, slug, name FROM characters
          UNION ALL SELECT 'script', slug, name FROM scripts
          UNION ALL SELECT 'collection', slug, display_name FROM collections
          UNION ALL SELECT 'news', slug, title FROM news
          UNION ALL SELECT 'wikipage', slug, title FROM pages)`;
      const [top, totals] = await Promise.all([
        env.DB.prepare(
          `SELECT pv.entity_type, pv.slug, SUM(pv.n) AS views, MAX(p.name) AS name
           FROM page_views pv LEFT JOIN ${names} p ON p.t = pv.entity_type AND p.slug = pv.slug
           WHERE pv.day >= date('now', ?)
           GROUP BY pv.entity_type, pv.slug ORDER BY views DESC LIMIT 15`
        ).bind(since).all(),
        env.DB.prepare(
          `SELECT COALESCE(SUM(n), 0) AS views, COUNT(DISTINCT entity_type || ':' || slug) AS pages
           FROM page_views WHERE day >= date('now', ?)`
        ).bind(since).first()
      ]);
      return jsonResponse({ days, totals: totals || { views: 0, pages: 0 }, top: top.results || [] });
    }

    // ---------- ADMIN: SYSTEM TEXT OVERRIDES ----------
    // The full rows, with who changed what and when. The catalogue of every
    // editable string is NOT built here — /text-editor scans the site's own
    // files in the browser, so nothing is stored until something is changed.
    if (method === 'GET' && path === '/api/admin/site-text') {
      const sess = await adminSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not authorized' }, { status: 403 });
      await ensureSiteTextTable(env);
      const rows = await env.DB.prepare(
        `SELECT id, scope, source, original, replacement, updated_at, updated_by
           FROM site_text ORDER BY updated_at DESC`
      ).all();
      return jsonResponse({ overrides: rows.results || [] });
    }

    // ---------- BROKEN-LINK REPORT (the 404 page's contact box) ----------
    // Deliberately OUTSIDE the logged-in write gate below: whoever follows a
    // dead link off Discord is the person least likely to have an account, and
    // nobody signs up to report that the wiki is broken. Lands in the same
    // dashboard inbox as /api/contact.
    //
    // It writes nothing but a message row, the rate limit is per IP (or per
    // account when there is one), and every field is capped. An anonymous row
    // has user_id NULL, which the dashboard already handles; it just cannot be
    // replied to, which is why the form asks for somewhere to write back.
    if (method === 'POST' && path === '/api/report-broken-link') {
      const sess = await getSession(env, request);
      if (await rateLimited(env, request, 'brokenlink', 4, 3600, { sess })) {
        return tooManyResponse('Thanks. That is enough reports from here for now; try again in an hour.', 3600);
      }
      const b = await request.json().catch(() => ({}));
      const brokenPath = String(b.path || '').trim().slice(0, 300);
      const note = String(b.note || '').trim().slice(0, 1000);
      const replyTo = String(b.contact || '').trim().slice(0, 120);
      const cameFrom = String(b.from || '').trim().slice(0, 300);
      if (!brokenPath && !note) {
        return jsonResponse({ error: 'Tell us what you were looking for first.' }, { status: 400 });
      }
      await ensureMessagesTable(env);
      let uname = null;
      if (sess) {
        try {
          const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
          uname = u ? u.username : null;
        } catch { /* non-fatal: the report is still worth keeping */ }
      }
      // One readable block, because the inbox shows `body` and nothing else.
      const lines = ['Broken link: ' + (brokenPath || '(not given)')];
      if (note) lines.push('', note);
      if (cameFrom) lines.push('', 'Came from: ' + cameFrom);
      if (replyTo && !uname) lines.push('', 'Reply to: ' + replyTo);
      await env.DB.prepare(
        'INSERT INTO messages (user_id, username, category, body) VALUES (?,?,?,?)'
      ).bind(sess ? sess.userId : null, uname, 'bug', lines.join('\n')).run();
      if (sess) await logActivity(env, sess, 'contact', 'message', null, 'broken-link');
      return jsonResponse({ ok: true, message: 'Thanks, the admins have it.' });
    }

    // ---------- WRITES (logged-in users; ownership enforced) ----------
    if (method === 'POST' && path.startsWith('/api/')) {
      const sess = await getSession(env, request);
      if (!sess) return jsonResponse({ error: 'Not logged in. Create an account or log in first.' }, { status: 401 });

      // Fresh account flags from D1: bans and admin promotions/demotions
      // apply immediately instead of when the 30-day session cookie expires.
      const acctFlags = await getAccountFlags(env, sess.userId);
      if (!acctFlags) return jsonResponse({ error: 'Not logged in.' }, { status: 401, 'Set-Cookie': clearCookie() });
      sess.isAdmin = !!acctFlags.is_admin;

      // Every /api/admin/* endpoint (plus lock/seed/backup) is admin-only.
      const adminOnly = path.startsWith('/api/admin/') ||
                        path === '/api/lock' || path === '/api/seed' || path === '/api/backup';
      if (adminOnly && !sess.isAdmin) return jsonResponse({ error: 'Not authorized' }, { status: 403 });

      // Content writes are blocked while the wiki is locked (true freeze,
      // applies to admins too). Lock toggle + seed are intentionally exempt.
      // Posting a comment counts as a content write: a wiki locked because of
      // vandalism should not leave the comment boxes open. Removing and
      // reporting comments stay available so moderation still works.
      const isContentWrite = ['/api/character', '/api/collection', '/api/script', '/api/wiki-page', '/api/publish', '/api/delete', '/api/upload', '/api/bloodstar-art', '/api/comments', '/api/jinx'].includes(path);

      // What a SUSPENDED account may still reach. Everything else that writes
      // is closed to them. The old rule only covered the content-write list
      // above, which left a banned user free to pin and delete comments, mark
      // pages Curata, file reports, block people, change their public profile and
      // avatar, and roll pages back — none of which is what "suspended" is
      // supposed to mean.
      //
      // Deliberately still allowed:
      //   /api/contact           appealing the ban is the point
      //   /api/logout            never trap somebody in a session
      //   /api/account/password  they must be able to secure their own account
      //   /api/account/email     same
      const BANNED_ALLOWED = new Set([
        '/api/contact', '/api/logout', '/api/account/password', '/api/account/email'
      ]);
      if (acctFlags.banned && !BANNED_ALLOWED.has(path)) {
        return jsonResponse({ error: 'This account is suspended. You can contact the admins from your account page.' }, { status: 403 });
      }
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
        // Links + pinned pages ride in the same save. Only touched when the
        // client sends them, so an older form that posts name+bio alone can
        // never wipe somebody's links.
        if (b.links !== undefined || b.pinned !== undefined) {
          await ensureProfileColumn(env);
          const extra = sanitizeProfileExtra(b);
          // You can only pin your own published pages — checked here, and again
          // on read, so a page that later goes draft quietly drops off.
          const verified = [];
          for (const p of extra.pinned) {
            const t = CONTENT[p.type];
            if (!t) continue;
            const row = await env.DB.prepare(
              `SELECT slug FROM ${t.table} WHERE slug=? AND owner_id=? AND status='published'`
            ).bind(p.slug, sess.userId).first().catch(() => null);
            if (row) verified.push(p);
          }
          extra.pinned = verified;
          await env.DB.prepare('UPDATE users SET profile_json=? WHERE id=?')
            .bind(JSON.stringify(extra), sess.userId).run();
          return jsonResponse({ ok: true, links: extra.links, pinned: extra.pinned });
        }
        return jsonResponse({ ok: true });
      }

      // ---- profile picture (uploaded to R2 under avatars/u{id}.{ext}) ----
      // Body: {data: dataURL} to set, or {remove: true} to go back to the
      // initial-letter avatar. The key is derived from the session, so users
      // can only ever touch their own avatar slot.
      if (path === '/api/account/avatar') {
        if (!env.ART) return jsonResponse({ error: 'Image storage (R2) is not configured' }, { status: 500 });
        if (await rateLimited(env, request, 'avatar', 20, 3600)) {
          return tooManyResponse('Too many avatar changes. Try again later.', 3600);
        }
        const b = await request.json().catch(() => ({}));
        const AVATAR_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
        async function deleteOwnAvatars() {
          for (const e of AVATAR_EXTS) {
            try { await env.ART.delete('avatars/u' + sess.userId + '.' + e); } catch { /* best-effort */ }
          }
        }
        if (b.remove) {
          await deleteOwnAvatars();
          await env.DB.prepare('UPDATE users SET avatar_url=NULL WHERE id=?').bind(sess.userId).run();
          return jsonResponse({ ok: true, avatarUrl: null });
        }
        let data = String(b.data || '');
        if (!data.startsWith('data:')) return jsonResponse({ error: 'Send the image as a data URL.' }, { status: 400 });
        const contentType = data.slice(5, data.indexOf(';'));
        const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[contentType];
        if (!ext) return jsonResponse({ error: 'Profile pictures must be PNG, JPEG, or WebP.' }, { status: 400 });
        data = data.slice(data.indexOf(',') + 1);
        let bytes;
        try { bytes = base64ToBytes(data); } catch { return jsonResponse({ error: 'Could not read that image.' }, { status: 400 }); }
        if (!bytes.length) return jsonResponse({ error: 'Could not read that image.' }, { status: 400 });
        if (bytes.length > 2 * 1024 * 1024) return jsonResponse({ error: 'Picture is too large (2 MB max).' }, { status: 413 });
        await deleteOwnAvatars(); // clear any old picture with a different extension
        const key = 'avatars/u' + sess.userId + '.' + ext;
        await env.ART.put(key, bytes, {
          httpMetadata: { contentType },
          customMetadata: { owner: String(sess.userId) }
        });
        // ?v= busts any cached copy the browser holds of the previous picture
        const avatarUrl = '/assets/' + key + '?v=' + Date.now();
        await env.DB.prepare('UPDATE users SET avatar_url=? WHERE id=?').bind(avatarUrl, sess.userId).run();
        return jsonResponse({ ok: true, avatarUrl });
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
        // Changing a password is what somebody does when they think their
        // account is compromised, so it has to end the attacker's session too.
        // The tab doing the changing keeps its own.
        await revokeSessions(env, sess.userId, sess.token);
        return jsonResponse({ ok: true, otherSessionsEndedProbably: true });
      }

      if (path === '/api/account/email') {
        // Sends a Resend email every time it succeeds, so without a limit any
        // account is a free mail cannon pointed at any address.
        if (!sess.isAdmin && await rateLimited(env, request, 'emailchange', 5, 3600, { sess })) {
          return tooManyResponse('You have changed your email several times in the last hour. Try again later.', 3600);
        }
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
        {
          const limited = await writeLimited(env, request, sess, 'upload');
          if (limited) return limited;
        }
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

        // The content type was whatever the client claimed — out of the data-URL
        // prefix or straight off the request header — and it was stored on the R2
        // object, where the serve path replays it verbatim via
        // writeHttpMetadata(). Uploading `data:text/html;base64,...` to
        // art/x.png therefore served attacker-written HTML from our own origin,
        // and there is no CSP on the site to contain it.
        //
        // Same fix /api/account/avatar already uses: whitelist the type, and
        // derive everything downstream from the MAPPED value so the client's
        // string is never trusted again. SVG is not on the list and must not be
        // added — it is a script-execution format wearing an image extension.
        // split(';') drops any `; charset=...` the raw-body branch picked up off
        // the request header.
        const declaredType = String(contentType || '').toLowerCase().split(';')[0].trim();
        const uploadExt = UPLOAD_CONTENT_TYPES[declaredType];
        if (!uploadExt) {
          return jsonResponse({
            error: 'Images must be PNG, JPEG, WebP, or GIF.'
          }, { status: 400 });
        }
        contentType = uploadExt.type;
        // The extension has to agree with the bytes, or /assets/ hands back a
        // file whose name promises one thing and whose Content-Type says
        // another — exactly the confusion nosniff exists to stop.
        const keyExt = key.split('.').pop().toLowerCase();
        if (!uploadExt.exts.includes(keyExt)) {
          return jsonResponse({
            error: `A ${contentType} image must be saved as .${uploadExt.exts[0]} (got .${keyExt}).`
          }, { status: 400 });
        }

        {
          const denied = await uploadSlotDenied(env, sess, key);
          if (denied) return denied;
        }

        const ext = key.split('.').pop().toLowerCase();
        if (!contentType) contentType = EXT_CONTENT_TYPE[ext] || 'application/octet-stream';
        await env.ART.put(key, bytes, {
          httpMetadata: { contentType },
          customMetadata: { owner: String(sess.userId) }
        });
        // Uploads were never recorded anywhere, so there was no way to answer
        // "who put this image here" or to see a flood while it was happening.
        // 'upload' is not in FEED_CHANGING_ACTIONS, so this costs no cache.
        await logActivity(env, sess, 'upload', 'image', key, Math.round(bytes.length / 1024) + ' KB');
        return jsonResponse({ ok: true, path: '/assets/' + key });
      }

      /* ---- copy one image from Bloodstar straight into R2 ----
         Body: {key, src}. `src` must be an https URL on a Bloodstar host; `key`
         is an ordinary upload slot and goes through uploadSlotDenied(), the
         same permission check /api/upload uses, so this can reach nothing
         that route could not.

         It exists because the alternative is the browser doing it: a 40
         character import is 40 images down and 40 base64 bodies back up, on
         a phone, and both halves of that are the reader's data. Here the
         bytes go Bloodstar -> Worker -> R2 and the page sends one short POST
         per character. The tool falls back to the browser path (canvas plus
         /api/upload, as mass-upload.html does) for art hosted anywhere else,
         which is how a project's imgur-hosted background still comes over. */
      if (path === '/api/bloodstar-art') {
        {
          const limited = await writeLimited(env, request, sess, 'upload');
          if (limited) return limited;
        }
        if (!env.ART) return jsonResponse({ error: 'Image storage (R2) is not configured' }, { status: 500 });
        const b = await request.json().catch(() => ({}));
        let key = String(b.key || '').replace(/^\/+/, '').replace(/^assets\//, '');
        if (!key || key.includes('..') || !R2_PREFIXES.some(p => key.startsWith(p))) {
          return jsonResponse({ error: 'Key must be under: ' + R2_PREFIXES.join(', ') }, { status: 400 });
        }
        let srcUrl;
        try { srcUrl = new URL(String(b.src || '')); } catch { srcUrl = null; }
        if (!srcUrl || srcUrl.protocol !== 'https:' || !Bloodstar.isBloodstarHost(srcUrl.hostname)) {
          return jsonResponse({ error: 'That image is not on Bloodstar. Upload it through /api/upload instead.' }, { status: 400 });
        }
        // Both spellings of each Bloodstar host are accepted and only one of
        // them answers (see BLOODSTAR_HOST_CANON), so the image is asked for
        // at the one that does — an old project's export writes whichever
        // spelling it was written under.
        srcUrl.hostname = Bloodstar.bloodstarHost(srcUrl.hostname);
        {
          const denied = await uploadSlotDenied(env, sess, key);
          if (denied) return denied;
        }
        let res;
        try {
          res = await fetch(srcUrl.toString(), { redirect: 'follow' });
        } catch {
          return jsonResponse({ error: 'Could not reach that image on Bloodstar.' }, { status: 502 });
        }
        if (!res.ok) {
          return jsonResponse({ error: 'Bloodstar answered ' + res.status + ' for that image.' }, { status: 502 });
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (!bytes.length) return jsonResponse({ error: 'That image came back empty.' }, { status: 502 });
        if (bytes.length > 8 * 1024 * 1024) {
          return jsonResponse({ error: 'That image is too large (8 MB max).' }, { status: 413 });
        }
        // Same whitelist /api/upload applies, for the same reason: whatever
        // type is stored here is the type /assets/ replays, so an unlisted one
        // is a file served from our own origin under someone else's rules.
        const declaredType = String(res.headers.get('Content-Type') || '').toLowerCase().split(';')[0].trim();
        const uploadExt = UPLOAD_CONTENT_TYPES[declaredType];
        if (!uploadExt) {
          return jsonResponse({ error: 'That image is not a PNG, JPEG, WebP or GIF.' }, { status: 400 });
        }
        const keyExt = key.split('.').pop().toLowerCase();
        if (!uploadExt.exts.includes(keyExt)) {
          return jsonResponse({
            error: `A ${uploadExt.type} image must be saved as .${uploadExt.exts[0]} (got .${keyExt}).`
          }, { status: 400 });
        }
        await env.ART.put(key, bytes, {
          httpMetadata: { contentType: uploadExt.type },
          customMetadata: { owner: String(sess.userId) }
        });
        await logActivity(env, sess, 'upload', 'image', key, Math.round(bytes.length / 1024) + ' KB (Bloodstar)');
        return jsonResponse({ ok: true, path: '/assets/' + key });
      }

      // ---- comments ----
      /* ---- suggest an edit ----
         Body: {type, slug, data, note}. `data` is the whole page as the
         suggester would have it, the same object the editor posts to save. It
         is stored, not applied: nothing here touches the row. */
      if (path === '/api/suggest') {
        if (acctFlags.banned) {
          return jsonResponse({ error: 'This account is suspended.' }, { status: 403 });
        }
        if (await rateLimited(env, request, 'suggest', 20, 3600)) {
          return tooManyResponse('Too many suggestions from this connection. Try again later.', 3600);
        }
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        if (!REVISABLE[type]) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        const row = await revisableRow(env, type, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        if ((row.status || 'published') !== 'published') {
          return jsonResponse({ error: 'That page is not published.' }, { status: 400 });
        }
        // The owner does not suggest to themselves; they just save.
        if (canEditRow(sess, row)) {
          return jsonResponse({ error: 'This is your own page: save it directly instead.' }, { status: 400 });
        }
        const mode = publicEditMode(parseData(row));
        if (mode !== 'suggest') {
          return jsonResponse({ error: 'That page is not taking suggestions.' }, { status: 403 });
        }
        if (await isProtected(env, type, row.slug)) {
          return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
        }
        const data = b.data;
        if (!data || typeof data !== 'object') return jsonResponse({ error: 'Nothing to suggest.' }, { status: 400 });
        if (publicEditTooBig(data)) {
          return jsonResponse({ error: 'That suggestion is too large to send.' }, { status: 413 });
        }
        // Owner-only settings never ride in on a suggestion, approved or not.
        const storedNow = parseData(row);
        data.slug = row.slug;
        data.publicEdit = storedNow.publicEdit;
        data.curata = !!storedNow.curata;
        // Declining Curata is the owner's, so it is re-pinned exactly as the
        // grant is — a suggestion can neither add it nor take it off.
        if (storedNow.curataOptOut) data.curataOptOut = true; else delete data.curataOptOut;
        delete data.status;
        delete data.renameFrom;
        delete data.appearsInFrom;
        if (!diffFieldLabels(row.data, JSON.stringify(data)).length) {
          return jsonResponse({ error: 'That is the page exactly as it stands, so there is nothing to suggest.' }, { status: 400 });
        }
        await ensureSuggestTable(env);
        const open = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM suggestions WHERE entity_type=? AND slug=? AND user_id=? AND status='open'"
        ).bind(type, row.slug, sess.userId).first().catch(() => ({ n: 0 }));
        if (open && open.n >= SUGGEST_MAX_OPEN_PER_PAGE) {
          return jsonResponse({ error: 'You already have suggestions waiting on this page.' }, { status: 429 });
        }
        let uname = null;
        try {
          const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
          uname = u ? u.username : null;
        } catch { /* non-fatal */ }
        const res = await env.DB.prepare(
          `INSERT INTO suggestions (entity_type, slug, user_id, username, note, data, base_updated_at)
           VALUES (?,?,?,?,?,?,?)`
        ).bind(type, row.slug, sess.userId, uname,
               String(b.note || '').trim().slice(0, SUGGEST_NOTE_MAX) || null,
               JSON.stringify(data), row.updated_at || null).run();
        await logActivity(env, sess, 'suggest', type, row.slug, row.name || row.slug);
        ctx.waitUntil(notifyPageEdit(env, {
          fromId: sess.userId, ownerId: row.owner_id, type, slug: row.slug,
          what: 'suggested an edit to', name: row.name || row.slug,
          path: '/suggestions?type=' + encodeURIComponent(type) + '&slug=' + encodeURIComponent(row.slug),
          origin: url.origin
        }));
        return jsonResponse({ ok: true, id: res.meta ? res.meta.last_row_id : null });
      }

      /* ---- approve / decline / withdraw a suggestion ----
         Approving is an ordinary save made on the suggester's behalf: the
         current version is snapshotted into the page's history first, so it
         shows up in the log and can be rolled back like any other edit. */
      if (path === '/api/suggestion') {
        const b = await request.json().catch(() => ({}));
        const id = parseInt(b.id, 10) || 0;
        const action = String(b.action || '');
        if (!id) return jsonResponse({ error: 'Missing suggestion id.' }, { status: 400 });
        await ensureSuggestTable(env);
        const sug = await env.DB.prepare('SELECT * FROM suggestions WHERE id=?')
          .bind(id).first().catch(() => null);
        if (!sug) return jsonResponse({ error: 'No such suggestion.' }, { status: 404 });
        if (sug.status !== 'open') return jsonResponse({ error: 'That suggestion has already been dealt with.' }, { status: 409 });
        const row = await revisableRow(env, sug.entity_type, sug.slug);
        if (!row) return jsonResponse({ error: 'That page is gone.' }, { status: 404 });
        const owns = canEditRow(sess, row);

        if (action === 'withdraw') {
          if (sug.user_id !== sess.userId && !owns) {
            return jsonResponse({ error: 'That is not your suggestion.' }, { status: 403 });
          }
          await env.DB.prepare(
            "UPDATE suggestions SET status='withdrawn', decided_at=datetime('now') WHERE id=?"
          ).bind(id).run();
          return jsonResponse({ ok: true, status: 'withdrawn' });
        }

        if (!owns) return jsonResponse({ error: 'Only the page\u2019s creator can answer a suggestion.' }, { status: 403 });
        const reply = String(b.reply || '').trim().slice(0, SUGGEST_NOTE_MAX) || null;
        let by = null;
        try {
          const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
          by = u ? u.username : null;
        } catch { /* non-fatal */ }

        if (action === 'decline') {
          await env.DB.prepare(
            "UPDATE suggestions SET status='declined', reply=?, decided_by=?, decided_at=datetime('now') WHERE id=?"
          ).bind(reply, by, id).run();
          ctx.waitUntil(notifySuggestionAnswer(env, sug, row, 'declined', reply, sess.userId, url.origin));
          return jsonResponse({ ok: true, status: 'declined' });
        }

        if (action !== 'approve') return jsonResponse({ error: 'Unknown action.' }, { status: 400 });
        if (row.status === 'deleted') {
          return jsonResponse({ error: 'That page is in the trash. Restore it first.' }, { status: 400 });
        }
        if (!sess.isAdmin && await isProtected(env, sug.entity_type, row.slug)) {
          return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
        }
        let d;
        try { d = foldLegacyCurata(JSON.parse(sug.data)); } catch { d = null; }
        if (!d) return jsonResponse({ error: 'That suggestion is corrupt and cannot be applied.' }, { status: 500 });
        // Re-pin everything that belongs to the page rather than to the
        // suggestion: the row may have changed since it was written.
        const now = parseData(row);
        d.slug = row.slug;
        d.publicEdit = now.publicEdit;
        d.curata = !!now.curata;
        if (now.curataOptOut) d.curataOptOut = true; else delete d.curataOptOut;
        delete d._deleted;
        await saveRevision(env, sess, sug.entity_type, row);   // the approval is undoable
        try { await applyRollback(env, sug.entity_type, row, d); }
        catch (e) { return jsonResponse({ error: (e && e.message) || 'Could not apply that suggestion.' }, { status: 500 }); }
        await env.DB.prepare(
          "UPDATE suggestions SET status='approved', reply=?, decided_by=?, decided_at=datetime('now') WHERE id=?"
        ).bind(reply, by, id).run();
        await logActivity(env, sess, 'suggestion-approve', sug.entity_type, row.slug,
          (d.name || d.displayName || d.title || row.name || row.slug) +
          (sug.username ? ' (from ' + sug.username + ')' : ''));
        ctx.waitUntil(notifySuggestionAnswer(env, sug, row, 'approved', reply, sess.userId, url.origin));
        return jsonResponse({ ok: true, status: 'approved', slug: row.slug });
      }

      // ---- roll a page back to one of its own revisions (owner or admin) ----
      // Same operation as /api/admin/rollback, gated on owning the page rather
      // than on being an admin. Outside /api/admin/ because everything under
      // that prefix is admin-only by the check above.
      if (path === '/api/page-rollback') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        if (!REVISABLE[type]) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        const row = await revisableRow(env, type, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        if (!canEditRow(sess, row)) return jsonResponse({ error: 'That page belongs to another account.' }, { status: 403 });
        if (row.status === 'deleted') {
          return jsonResponse({ error: 'That page is in the trash. It has to be restored before it can be rolled back.' }, { status: 400 });
        }
        if (!sess.isAdmin && await isProtected(env, type, row.slug)) {
          return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
        }
        await ensureRevisionsTable(env);
        const rev = await env.DB.prepare(
          'SELECT id, ts, data FROM revisions WHERE id=? AND entity_type=? AND slug=?'
        ).bind(parseInt(b.id, 10) || 0, type, row.slug).first();
        if (!rev) return jsonResponse({ error: 'No such revision for that page.' }, { status: 404 });
        let d;
        try { d = foldLegacyCurata(JSON.parse(rev.data)); } catch { d = null; }
        if (!d) return jsonResponse({ error: 'That revision is corrupt and cannot be restored.' }, { status: 500 });
        delete d._deleted;
        // Snapshot what is being replaced, so the rollback is itself undoable.
        await saveRevision(env, sess, type, row);
        try { await applyRollback(env, type, row, d); }
        catch (e) { return jsonResponse({ error: (e && e.message) || 'Could not restore that revision.' }, { status: 500 }); }
        await logActivity(env, sess, 'rollback', type, row.slug, d.name || d.displayName || d.title || row.name);
        return jsonResponse({ ok: true, slug: row.slug, restoredFrom: rev.ts });
      }

      // Agreeing to the comment terms. The browser also shows the modal, but
      // the server is what actually gates posting, so a first comment can
      // carry {agree:true} and be accepted in one round-trip.
      if (path === '/api/comments/agree') {
        await ensureCommentTables(env);
        await env.DB.prepare('UPDATE users SET comment_terms=? WHERE id=?')
          .bind(COMMENT_TERMS_VERSION, sess.userId).run();
        return jsonResponse({ ok: true, agreed: true });
      }

      if (path === '/api/comments') {
        if (acctFlags.banned) {
          return jsonResponse({ error: 'This account is suspended and cannot post comments.' }, { status: 403 });
        }
        if (await rateLimited(env, request, 'comment', 30, 3600)) {
          return tooManyResponse('Slow down — too many comments from this connection. Try again later.', 3600);
        }
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        const target = await commentTarget(env, type, String(b.slug || ''));
        if (!target) return jsonResponse({ error: 'That page does not exist (or is not published yet).' }, { status: 404 });
        const body = String(b.body || '').replace(/\r\n/g, '\n').trim().slice(0, COMMENT_MAX);
        if (!body) return jsonResponse({ error: 'Write something first.' }, { status: 400 });
        await ensureCommentTables(env);
        // First-time commenters must accept the terms; the client sends
        // agree:true from the modal alongside their first comment.
        const u = await env.DB.prepare('SELECT comment_terms FROM users WHERE id=?')
          .bind(sess.userId).first().catch(() => null);
        let agreed = u && String(u.comment_terms || '') === COMMENT_TERMS_VERSION;
        if (!agreed && b.agree) {
          await env.DB.prepare('UPDATE users SET comment_terms=? WHERE id=?')
            .bind(COMMENT_TERMS_VERSION, sess.userId).run();
          agreed = true;
        }
        if (!agreed) {
          return jsonResponse({
            error: 'Please agree to the comment guidelines first.',
            needsAgreement: true, termsVersion: COMMENT_TERMS_VERSION
          }, { status: 428 });
        }
        // Replying: the parent must be a visible comment on this same page.
        // Threads stay one level deep — replying to a reply attaches to that
        // reply's parent instead of nesting further.
        let parentId = null, parentAuthorId = null;
        if (b.parentId) {
          const parent = await env.DB.prepare(
            "SELECT id, parent_id, entity_type, slug, status, user_id FROM comments WHERE id=?"
          ).bind(parseInt(b.parentId, 10) || 0).first().catch(() => null);
          if (!parent || parent.status !== 'visible' ||
              parent.entity_type !== type || parent.slug !== target.slug) {
            return jsonResponse({ error: 'The comment you replied to is no longer there.' }, { status: 404 });
          }
          parentId = parent.parent_id || parent.id;
          parentAuthorId = parent.user_id;   // told about the reply
        }
        const res = await env.DB.prepare(
          'INSERT INTO comments (entity_type, slug, user_id, body, parent_id) VALUES (?,?,?,?,?)'
        ).bind(type, target.slug, sess.userId, body, parentId).run();
        await logActivity(env, sess, parentId ? 'comment-reply' : 'comment',
          type, target.slug, body.slice(0, 60));
        // Tell the page's owner (and whoever is being replied to) about it.
        ctx.waitUntil(notifyComment(env, {
          fromId: sess.userId, target, body, origin: url.origin, parentAuthorId
        }));
        return jsonResponse({
          ok: true, id: (res.meta && res.meta.last_row_id) || null, parentId
        });
      }

      // Pin / unpin a comment — admins and the page's owner. Only top-level
      // comments can be pinned; pinning a reply pins the thread it belongs to.
      if (path === '/api/comments/pin') {
        await ensureCommentTables(env);
        const b = await request.json().catch(() => ({}));
        const id = parseInt(b.id, 10);
        if (!id) return jsonResponse({ error: 'Missing comment id.' }, { status: 400 });
        const row = await env.DB.prepare('SELECT * FROM comments WHERE id=?').bind(id).first().catch(() => null);
        if (!row || row.status !== 'visible') return jsonResponse({ error: 'Comment not found.' }, { status: 404 });
        const target = await commentTarget(env, row.entity_type, row.slug);
        const isOwner = target && target.ownerId != null && target.ownerId === sess.userId;
        if (!sess.isAdmin && !isOwner) {
          return jsonResponse({ error: 'Only the page owner and the admins can pin comments.' }, { status: 403 });
        }
        const pinId = row.parent_id || row.id;
        const on = !!b.pinned;
        await env.DB.prepare('UPDATE comments SET pinned=? WHERE id=?').bind(on ? 1 : 0, pinId).run();
        await logActivity(env, sess, on ? 'comment-pin' : 'comment-unpin',
          row.entity_type, row.slug, 'comment #' + pinId);
        return jsonResponse({ ok: true, id: pinId, pinned: on });
      }

      // Remove a comment: its author, the page's owner, or any admin.
      if (path === '/api/comments/delete') {
        await ensureCommentTables(env);
        const b = await request.json().catch(() => ({}));
        const id = parseInt(b.id, 10);
        if (!id) return jsonResponse({ error: 'Missing comment id.' }, { status: 400 });
        const row = await env.DB.prepare('SELECT * FROM comments WHERE id=?').bind(id).first().catch(() => null);
        if (!row || row.status !== 'visible') return jsonResponse({ error: 'Comment not found.' }, { status: 404 });
        const target = await commentTarget(env, row.entity_type, row.slug);
        const isOwner = target && target.ownerId != null && target.ownerId === sess.userId;
        if (!sess.isAdmin && !isOwner && row.user_id !== sess.userId) {
          return jsonResponse({ error: 'You can only remove your own comments.' }, { status: 403 });
        }
        let by = null;
        try {
          const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
          by = u ? u.username : null;
        } catch { /* non-fatal */ }
        await removeCommentCascade(env, row, by);
        await logActivity(env, sess, 'comment-remove', row.entity_type, row.slug, 'comment #' + id);
        return jsonResponse({ ok: true, id });
      }

      // Report a comment to the admins (shows up in the dashboard queue).
      if (path === '/api/comments/report') {
        await ensureCommentTables(env);
        if (await rateLimited(env, request, 'comment-report', 20, 3600)) {
          return tooManyResponse('Too many reports. Try again later.', 3600);
        }
        const b = await request.json().catch(() => ({}));
        const id = parseInt(b.id, 10);
        if (!id) return jsonResponse({ error: 'Missing comment id.' }, { status: 400 });
        const row = await env.DB.prepare('SELECT id FROM comments WHERE id=?').bind(id).first().catch(() => null);
        if (!row) return jsonResponse({ error: 'Comment not found.' }, { status: 404 });
        const already = await env.DB.prepare(
          "SELECT id FROM comment_reports WHERE comment_id=? AND reporter_id=? AND status='open'"
        ).bind(id, sess.userId).first().catch(() => null);
        if (already) return jsonResponse({ ok: true, id, already: true });
        await env.DB.prepare(
          'INSERT INTO comment_reports (comment_id, reporter_id, reason) VALUES (?,?,?)'
        ).bind(id, sess.userId, String(b.reason || '').trim().slice(0, 500) || null).run();
        return jsonResponse({ ok: true, id });
      }

      // ---- content create / update ----
      if (path === '/api/character') {
        {
          const limited = await writeLimited(env, request, sess, 'character');
          if (limited) return limited;
        }
        // `let`, not `const`: the tags-only branch below replaces the posted
        // page with the stored one, and esbuild refuses a const reassignment
        // at build time (which is what failed the Cloudflare deploy).
        let c = await request.json();
        if (!c || !c.slug || !c.name || !c.team || !c.ability)
          return jsonResponse({ error: 'Missing required fields' }, { status: 400 });
        // The slug is the character's IDENTITY: the primary key, the art slot
        // in R2, and what every reference to this page is stored as. It is
        // also the one-segment URL that 301s to the page's real address, and
        // that route only matches [a-z0-9-].
        if (!/^[a-z0-9-]{1,80}$/.test(String(c.slug))) {
          return jsonResponse({ error: 'Invalid character URL. Use lower-case letters, numbers and hyphens only.' }, { status: 400 });
        }
        // No page on this wiki may BE an official character. Enforced here, at
        // the one door every route goes through — the two editors, the mass
        // uploader, the Bloodstar importer and the Grimoire Forge draft button
        // all end up at /api/character — so there is one rule rather than five
        // that can drift. Admins included: "never" is the point, and an admin
        // saving one is how two of the three already on the wiki got there.
        //
        // A shared NAME is fine and always was (this wiki has a Pope and a
        // Nightwatchman that are nothing like the official ones); it is the
        // name AND the ability together that mean the page is a copy.
        {
          const graded = OfficialRoles.officialMatch(
            await loadOfficialRoles(env, url.origin), { name: c.name, ability: c.ability });
          if (graded && graded.match === 'exact') {
            return jsonResponse({
              error: OfficialRoles.officialRefusal(graded.role), official: graded.role.id
            }, { status: 400 });
          }
        }
        // Renaming: the editor sends the page's identity in renameFrom and the
        // slug its new name asks for in `slug`. The IDENTITY does not move —
        // it is what the art in R2, the comments, the view history and every
        // script roster are keyed on — so a rename is an address change, made
        // after the save below. The page keeps its primary key and simply gets
        // a new /c/{set}/{name}, with the old address 301ing to it forever.
        const renameFrom = String(c.renameFrom || '');
        delete c.renameFrom;
        let renamedFrom = null;
        const renamedArt = false;
        if (renameFrom && renameFrom !== c.slug) {
          if (!/^[a-z0-9-]{1,80}$/.test(renameFrom)) {
            return jsonResponse({ error: 'Invalid page URL to rename from.' }, { status: 400 });
          }
          const src = await getEntityRow(env, 'character', renameFrom);
          if (!src) {
            return jsonResponse({ error: 'The page being renamed no longer exists at /c/' + renameFrom + '.' }, { status: 404 });
          }
          if (!canEditRow(sess, src)) {
            return jsonResponse({ error: 'That character belongs to another account.' }, { status: 403 });
          }
          if (!sess.isAdmin && await isProtected(env, 'character', renameFrom)) {
            return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
          }
          // Write back to the row that already exists. Nothing is moved, so
          // the old "is the target slug free?" check has nothing to guard:
          // two characters can share a name and still get their own address.
          renamedFrom = charAddress(src);
          c.slug = renameFrom;
        }
        const existing = await getEntityRow(env, 'character', c.slug);
        // Ownership, or the page's own public-editing setting. Everything
        // that belongs to the creator (the URL, publishing, deleting, who may
        // edit) needs 'owner'. 'all' and 'tags' are what a guest was invited
        // to do.
        const perm = existing ? await editPermission(env, sess, 'character', existing) : 'owner';
        if (existing && !perm) {
          return jsonResponse({ error: 'A character with that name already exists and belongs to another account. Pick a different name.' }, { status: 403 });
        }
        if (existing && !permCanWrite(perm)) {
          return jsonResponse({ error: SUGGEST_INSTEAD, suggest: true }, { status: 403 });
        }
        if (existing && perm === 'owner' && !sess.isAdmin && await isProtected(env, 'character', existing.slug)) {
          return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
        }
        {
          const conflict = checkEditConflict(existing, c);
          if (conflict) return conflict;
        }
        const stored = existing ? parseData(existing) : null;
        if (perm === 'tags') {
          // Tags and nothing else. Rather than compare field by field and
          // hope nothing was missed, the stored page IS the save and only the
          // tags come from what was posted, so nothing else can reach the row.
          const tags = typeof c.tags === 'string' ? c.tags : '';
          c = stored;
          c.tags = tags.slice(0, PUBLIC_EDIT_TAGS_MAX);
        }
        if (existing && perm !== 'owner' && publicEditTooBig(c)) {
          return jsonResponse({ error: 'That edit is too large to save.' }, { status: 413 });
        }
        let status = c.status === 'draft' ? 'draft' : 'published';
        delete c.status;
        let editorsAdded = [], editorsUnknown = [];
        if (existing && perm !== 'owner') {
          // Publishing and unpublishing belong to the creator. An approved
          // editor reaches a draft, so this is what keeps a draft a draft
          // rather than keeping a published page published.
          status = existing.status || 'published';
          // As does who may edit it: a guest cannot open a page further, and
          // cannot close it behind themselves either.
          c.publicEdit = stored.publicEdit;
          // The approved-editor list travels with it. An editor cannot add a
          // friend to somebody else's page, and cannot take the others off.
          c.editors = approvedEditors(stored);
        } else {
          c.publicEdit = sanitizePublicEdit(c.publicEdit);
          const eds = await sanitizeEditors(env, c.editors, existing ? existing.owner_id : sess.userId);
          const before = new Set(approvedEditors(stored).map(e => Number(e.id)));
          editorsAdded = eds.list.filter(e => !before.has(Number(e.id)));
          editorsUnknown = eds.unknown;
          c.editors = eds.list;
        }
        if (!c.publicEdit) delete c.publicEdit;
        if (!c.editors || !c.editors.length) delete c.editors;
        // Curata is admin-only: never trust the client, always carry the
        // stored value forward. /api/admin/curata is the only way to set it.
        c.curata = existing ? !!parseData(existing).curata : false;
        /* Declining it, though, belongs to the page's creator: the mark says
           the wiki is showing this page off, and that is theirs to refuse.
           It is the owner's call and no guest's, so a public or approved
           edit carries the stored answer forward exactly as `curata` is. */
        if (perm === 'owner') {
          if (c.curataOptOut) c.curataOptOut = true; else delete c.curataOptOut;
        } else if (stored && stored.curataOptOut) {
          c.curataOptOut = true;
        } else {
          delete c.curataOptOut;
        }
        c.jinxes = sanitizeJinxes(c.jinxes);
        if (!c.jinxes.length) delete c.jinxes;
        // "Appears in" derived from collection membership is worked out on
        // every read and belongs to no row. A client echoing back a page it
        // read out of characters.json must not freeze it into the record.
        delete c.appearsInFrom;
        // An incomplete character cannot go live: it needs a name, an icon,
        // an ability and tags. Publishing attempts are saved as drafts
        // instead so nothing is lost — the editor shows what is missing.
        const needed = Classify.missingForPublish(c);
        // A page opened to other people can be improved, not taken down. The
        // demotion below is meant for a creator saving their own unfinished
        // work; applied to a guest's save it would let anybody unpublish a
        // live page by clearing one field. Refuse that save instead.
        if (existing && perm !== 'owner' && status === 'published' && needed.length) {
          return jsonResponse({
            error: 'That edit would leave the page without ' + Classify.listPhrase(needed) +
              ', which a published page needs. Put that back and save again.',
            missingForPublish: needed
          }, { status: 400 });
        }
        let iconBlocked = false;
        if (status === 'published' && needed.length) {
          status = 'draft';
          iconBlocked = true;
        }
        if (existing) await saveRevision(env, sess, 'character', existing);
        await env.DB.prepare(
          `INSERT INTO characters (slug,name,team,creator,owner_id,tags,appears_in,data,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             name=excluded.name, team=excluded.team, creator=excluded.creator,
             tags=excluded.tags, appears_in=excluded.appears_in,
             data=excluded.data, status=excluded.status, updated_at=datetime('now')`
        ).bind(c.slug, c.name, c.team, c.creator || null, sess.userId,
               c.tags || null, c.appearsIn || null, JSON.stringify(c), status).run();
        // The address this page's name and set now ask for, recomputed on every
        // save — that is what makes renaming automatic, and what moves a
        // character's URL when it joins or leaves a collection. setCharAddress
        // leaves a 301 behind whenever it actually moves.
        let address = charAddress(existing) || c.slug;
        let movedFrom = null;
        try {
          const prevAddress = charAddress(existing);
          address = await characterAddress(
            env, c.slug, c,
            existing ? existing.owner_id : sess.userId,
            prevAddress
          );
          const changed = await setCharAddress(env, c.slug, address);
          // A page that had an address and now has a different one has moved,
          // and the editor says so. A page getting its first one has not.
          if (changed && prevAddress && prevAddress !== address) movedFrom = prevAddress;
        } catch {
          // Never lose a save over an address. The page is still reachable at
          // /c/{identity} until the next save, or the admin backfill, gives it
          // a nested one.
          address = charAddress(existing) || c.slug;
        }
        await logActivity(env, sess, existing ? 'update' : 'create', 'character', c.slug, c.name);
        if (existing && perm !== 'owner') {
          ctx.waitUntil(notifyPageEdit(env, {
            fromId: sess.userId, ownerId: existing.owner_id, type: 'character', slug: c.slug,
            what: perm === 'tags' ? 'changed the tags on' : 'edited',
            name: c.name, path: '/c/' + address, origin: url.origin
          }));
        }
        if (editorsAdded.length) {
          ctx.waitUntil(notifyEditorsAdded(env, {
            fromId: sess.userId, added: editorsAdded, name: c.name,
            path: '/c/' + address, origin: url.origin
          }));
        }
        if (movedFrom) {
          await logActivity(env, sess, 'rename', 'character', c.slug, c.name + ' (was /c/' + movedFrom + ')');
        }
        const savedRow = await getEntityRow(env, 'character', c.slug);
        return jsonResponse({
          ok: true, slug: c.slug, page: 'c/' + address, address,
          // The address it used to have, when this save moved it.
          movedFrom, status, renamedFrom: movedFrom || renamedFrom, renamedArt,
          updatedAt: savedRow ? savedRow.updated_at : null,
          classification: Classify.classifyCharacter(c),
          missing: Classify.missingBits(c),
          editors: c.editors || [],
          // Names the owner typed that no account answered to. Dropping them
          // silently would leave them believing they had shared the page.
          editorsUnknown,
          iconBlocked,
          missingForPublish: needed,
          notice: iconBlocked
            ? 'Saved as a draft: a character needs ' + Classify.listPhrase(needed) +
              ' before it can be published. Add that and publish again.'
            : undefined
        });
      }

      // ---- add / edit / remove a single jinx, from the /jinxes page ----
      // A jinx is a relationship, so it can be created from either end: you
      // need to own (or admin) just ONE of the two characters. It is stored on
      // the side you own, and the other page shows it mirrored on read.
      if (path === '/api/jinx') {
        {
          const limited = await writeLimited(env, request, sess, 'character');
          if (limited) return limited;
        }
        const b = await request.json().catch(() => null);
        if (!b || !b.from) return jsonResponse({ error: 'Missing character' }, { status: 400 });
        if (!b.toSlug && !b.toId) {
          return jsonResponse({ error: 'Pick the character this jinx is with.' }, { status: 400 });
        }

        const row = await getEntityRow(env, 'character', String(b.from));
        if (!row) return jsonResponse({ error: 'No such character' }, { status: 404 });
        if (!canEditRow(sess, row)) {
          return jsonResponse({ error: 'That character belongs to another account.' }, { status: 403 });
        }
        if (!sess.isAdmin && await isProtected(env, 'character', row.slug)) {
          return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
        }
        // The other side has to exist: an official id checked against
        // roles.json, a wiki slug against the table. A jinx pointing at
        // nothing is the breakage this feature exists to fix.
        let target;
        if (b.toSlug) {
          const t = await getEntityRow(env, 'character', String(b.toSlug));
          if (!t) return jsonResponse({ error: 'No such character' }, { status: 404 });
          if (t.slug === row.slug) {
            return jsonResponse({ error: 'A character cannot be jinxed with itself.' }, { status: 400 });
          }
          target = { slug: t.slug, name: t.name };
        } else {
          const names = await officialNameMap(env, url.origin).catch(() => ({}));
          const key = Render.slugId(String(b.toId));
          if (!names[key]) {
            return jsonResponse({ error: 'No official character by that name.' }, { status: 404 });
          }
          target = { id: key, name: names[key] };
        }

        const d = parseData(row);
        const list = Array.isArray(d.jinxes) ? d.jinxes.slice() : [];
        // Match on whichever key identifies the target, so editing and
        // removing find the same entry adding created.
        const wanted = Render.normJinxId(target.slug || target.id);
        const at = list.findIndex(j => {
          const k = (j.slug && Render.normJinxId(j.slug)) ||
            Render.normJinxId(j.id || Render.slugId(j.name || ''));
          return k === wanted;
        });

        if (b.remove) {
          if (at === -1) return jsonResponse({ error: 'That jinx is not on this character.' }, { status: 404 });
          list.splice(at, 1);
        } else {
          const entry = {
            name: target.name,
            align: b.align === 'evil' ? 'evil' : 'good',
            text: String(b.text || '')
          };
          if (target.slug) entry.slug = target.slug; else entry.id = target.id;
          if (!entry.text.trim()) {
            return jsonResponse({ error: 'A jinx needs its rule text.' }, { status: 400 });
          }
          if (at === -1) list.push(entry); else list[at] = entry;
        }

        d.jinxes = sanitizeJinxes(list);
        if (!d.jinxes.length) delete d.jinxes;

        await saveRevision(env, sess, 'character', row);
        await env.DB.prepare(
          `UPDATE characters SET data=?, updated_at=datetime('now') WHERE slug=?`
        ).bind(JSON.stringify(d), row.slug).run();
        await logActivity(env, sess, 'update', 'character', row.slug, row.name);
        return jsonResponse({ ok: true, slug: row.slug, jinxes: d.jinxes || [] });
      }

      if (path === '/api/collection') {
        {
          const limited = await writeLimited(env, request, sess, 'collection');
          if (limited) return limited;
        }
        const c = await request.json();
        if (!c || (!c.slug && !c.id && !c.displayName)) {
          return jsonResponse({ error: 'Missing collection name' }, { status: 400 });
        }
        // Resolve the row this write targets: PK slug first, then kebab id
        // (legacy rows have display-string PK slugs, e.g. "The Academy").
        let existing = c.slug ? await getEntityRow(env, 'collection', c.slug) : null;
        if (!existing) existing = await findCollectionRow(env, c.id || c.slug);
        const perm = existing ? await editPermission(env, sess, 'collection', existing) : 'owner';
        if (existing && !perm) {
          return jsonResponse({ error: 'That collection belongs to another account.' }, { status: 403 });
        }
        if (existing && !permCanWrite(perm)) {
          return jsonResponse({ error: SUGGEST_INSTEAD, suggest: true }, { status: 403 });
        }
        if (existing && perm === 'owner' && !sess.isAdmin && await isProtected(env, 'collection', existing.slug)) {
          return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
        }
        {
          const conflict = checkEditConflict(existing, c);
          if (conflict) return conflict;
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
        // The author's hand-arranged roster order: a list of slugs, and only a
        // list of slugs. It is deliberately NOT the membership — membership is
        // still match[]/include[]/exclude[] — so a slug that leaves the
        // collection just stops being found, and a new member that is not in
        // here sorts after the ordered ones (see resolveCollectionMembers's
        // caller in render-page.js). That means neither list has to be kept in
        // step with the other, which is the only reason this is safe to store.
        c.order = Array.isArray(c.order)
          ? [...new Set(c.order.slice(0, 500).map(x => String(x).slice(0, 80)).filter(Boolean))]
          : [];
        if (!c.order.length) delete c.order;
        let status = c.status === 'draft' ? 'draft' : 'published';
        delete c.status;
        const storedColl = existing ? parseData(existing) : null;
        let editorsAdded = [], editorsUnknown = [];
        if (existing && perm !== 'owner') {
          status = existing.status || 'published';
          c.publicEdit = storedColl.publicEdit;
          c.editors = approvedEditors(storedColl);
        } else {
          c.publicEdit = sanitizePublicEdit(c.publicEdit);
          const eds = await sanitizeEditors(env, c.editors, existing ? existing.owner_id : sess.userId);
          const before = new Set(approvedEditors(storedColl).map(e => Number(e.id)));
          editorsAdded = eds.list.filter(e => !before.has(Number(e.id)));
          editorsUnknown = eds.unknown;
          c.editors = eds.list;
        }
        if (!c.publicEdit) delete c.publicEdit;
        if (!c.editors || !c.editors.length) delete c.editors;
        // Admin-only flag: keep whatever is stored, ignore the client.
        c.curata = existing ? !!parseData(existing).curata : false;
        if (existing && perm !== 'owner' && publicEditTooBig(c)) {
          return jsonResponse({ error: 'That edit is too large to save.' }, { status: 413 });
        }
        if (existing) await saveRevision(env, sess, 'collection', existing);
        await env.DB.prepare(
          `INSERT INTO collections (slug,display_name,owner_id,data,status,created_at,updated_at)
           VALUES (?,?,?,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             display_name=excluded.display_name, data=excluded.data, status=excluded.status, updated_at=datetime('now')`
        ).bind(pkSlug, c.displayName, sess.userId, JSON.stringify(c), status).run();
        await logActivity(env, sess, existing ? 'update' : 'create', 'collection', pkSlug, c.displayName);
        if (existing && perm !== 'owner') {
          ctx.waitUntil(notifyPageEdit(env, {
            fromId: sess.userId, ownerId: existing.owner_id, type: 'collection', slug: pkSlug,
            what: 'edited', name: c.displayName, path: '/collection/' + (c.id || pkSlug), origin: url.origin
          }));
        }
        if (editorsAdded.length) {
          ctx.waitUntil(notifyEditorsAdded(env, {
            fromId: sess.userId, added: editorsAdded, name: c.displayName,
            path: '/collection/' + (c.id || pkSlug), origin: url.origin
          }));
        }
        return jsonResponse({ ok: true, slug: pkSlug, id: c.id, status,
                              editors: c.editors || [], editorsUnknown });
      }

      if (path === '/api/script') {
        {
          const limited = await writeLimited(env, request, sess, 'script');
          if (limited) return limited;
        }
        const s = await request.json();
        if (!s || !s.slug) return jsonResponse({ error: 'Missing slug' }, { status: 400 });
        if (!/^[a-z0-9-]{1,80}$/.test(String(s.slug))) {
          return jsonResponse({ error: 'Invalid script slug.' }, { status: 400 });
        }
        const existing = await getEntityRow(env, 'script', s.slug);
        const perm = existing ? await editPermission(env, sess, 'script', existing) : 'owner';
        if (existing && !perm) {
          return jsonResponse({ error: 'That script belongs to another account.' }, { status: 403 });
        }
        if (existing && !permCanWrite(perm)) {
          return jsonResponse({ error: SUGGEST_INSTEAD, suggest: true }, { status: 403 });
        }
        if (existing && perm === 'owner' && !sess.isAdmin && await isProtected(env, 'script', existing.slug)) {
          return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
        }
        {
          const conflict = checkEditConflict(existing, s);
          if (conflict) return conflict;
        }
        sanitizePageFields(s, 'scripts/' + s.slug);
        s.characters = Array.isArray(s.characters)
          ? s.characters.slice(0, 100).map(x => String(x).slice(0, 80))
          : [];
        // The owner's hand-arranged night order: two lists of roster slugs.
        // Like a collection's `order[]` it is kept apart from the roster, so
        // neither list has to be kept in step with the other: a slug that has
        // left the script never matches, and a character it has not heard of
        // slots in by its own night number (sortNightItems in render-page.js).
        s.nightOrder = sanitizeNightOrder(s.nightOrder);
        if (!s.nightOrder) delete s.nightOrder;
        s.jinxEdits = sanitizeJinxEdits(s.jinxEdits);
        if (!s.jinxEdits) delete s.jinxEdits;
        if (existing && perm !== 'owner' && publicEditTooBig(s)) {
          return jsonResponse({ error: 'That edit is too large to save.' }, { status: 413 });
        }
        // The rest of what the official app reads out of the exported JSON:
        // _meta.bootlegger / almanac / hideTitle (schema at
        // github.com/ThePandemoniumInstitute/botc-release). The background and
        // logo are the page's own, already validated by sanitizePageFields.
        s.bootlegger = Array.isArray(s.bootlegger)
          ? s.bootlegger.slice(0, 20).map(r => String(r).slice(0, 300).trim()).filter(Boolean)
          : [];
        if (!s.bootlegger.length) delete s.bootlegger;
        s.almanac = typeof s.almanac === 'string' && /^https?:\/\//i.test(s.almanac.trim())
          ? s.almanac.trim().slice(0, 300) : '';
        if (!s.almanac) delete s.almanac;
        if (s.hideTitle) s.hideTitle = true; else delete s.hideTitle;
        let status = s.status === 'draft' ? 'draft' : 'published';
        delete s.status;
        const storedScript = existing ? parseData(existing) : null;
        let editorsAdded = [], editorsUnknown = [];
        if (existing && perm !== 'owner') {
          // Publishing, and who may edit, belong to the creator.
          status = existing.status || 'published';
          s.publicEdit = storedScript.publicEdit;
          s.editors = approvedEditors(storedScript);
        } else {
          s.publicEdit = sanitizePublicEdit(s.publicEdit);
          const eds = await sanitizeEditors(env, s.editors, existing ? existing.owner_id : sess.userId);
          const before = new Set(approvedEditors(storedScript).map(e => Number(e.id)));
          editorsAdded = eds.list.filter(e => !before.has(Number(e.id)));
          editorsUnknown = eds.unknown;
          s.editors = eds.list;
        }
        if (!s.publicEdit) delete s.publicEdit;
        if (!s.editors || !s.editors.length) delete s.editors;
        // Admin-only flag: keep whatever is stored, ignore the client.
        s.curata = existing ? !!parseData(existing).curata : false;
        if (existing) await saveRevision(env, sess, 'script', existing);
        await env.DB.prepare(
          `INSERT INTO scripts (slug,name,author,owner_id,data,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             name=excluded.name, author=excluded.author, data=excluded.data, status=excluded.status, updated_at=datetime('now')`
        ).bind(s.slug, s.name || s.slug, s.author || null, sess.userId, JSON.stringify(s), status).run();
        await logActivity(env, sess, existing ? 'update' : 'create', 'script', s.slug, s.name || s.slug);
        if (existing && perm !== 'owner') {
          ctx.waitUntil(notifyPageEdit(env, {
            fromId: sess.userId, ownerId: existing.owner_id, type: 'script', slug: s.slug,
            what: 'edited', name: s.name || s.slug, path: '/s/' + s.slug, origin: url.origin
          }));
        }
        if (editorsAdded.length) {
          ctx.waitUntil(notifyEditorsAdded(env, {
            fromId: sess.userId, added: editorsAdded, name: s.name || s.slug,
            path: '/s/' + s.slug, origin: url.origin
          }));
        }
        return jsonResponse({ ok: true, slug: s.slug, status,
                              editors: s.editors || [], editorsUnknown });
      }

      // ---- custom wiki pages (text-first pages under a script/collection) ----
      // Who may write one: the owner of the parent script/collection, or an
      // admin. The page is then owned by whoever created it, and only they (or
      // an admin) can edit it afterwards.
      if (path === '/api/wiki-page') {
        {
          const limited = await writeLimited(env, request, sess, 'wikipage');
          if (limited) return limited;
        }
        await ensurePagesTable(env);
        const b = await request.json().catch(() => ({}));
        const kebab = s => String(s || '').toLowerCase().normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '').slice(0, 70);

        if (b.action === 'delete') {
          const row = await env.DB.prepare('SELECT * FROM pages WHERE slug=?')
            .bind(String(b.slug || '')).first().catch(() => null);
          if (!row) return jsonResponse({ error: 'Page not found.' }, { status: 404 });
          if (!canEditRow(sess, row)) return jsonResponse({ error: 'That page belongs to another account.' }, { status: 403 });
          await saveRevision(env, sess, 'wikipage', row);
          await env.DB.prepare('DELETE FROM pages WHERE slug=?').bind(row.slug).run();
          await ensureCommentTables(env);
          await env.DB.prepare("DELETE FROM comments WHERE entity_type='wikipage' AND slug=?").bind(row.slug).run();
          await logActivity(env, sess, 'delete', 'wikipage', row.slug, row.title);
          return jsonResponse({ ok: true, deleted: row.slug });
        }

        const title = String(b.title || '').trim().slice(0, 160);
        if (!title) return jsonResponse({ error: 'Give the page a title.' }, { status: 400 });
        if (!String(b.body || '').trim()) {
          return jsonResponse({ error: 'Write something in the page body first.' }, { status: 400 });
        }

        const existing = b.slug
          ? await env.DB.prepare('SELECT * FROM pages WHERE slug=?').bind(String(b.slug)).first().catch(() => null)
          : null;
        if (b.slug && !existing) return jsonResponse({ error: 'That page no longer exists.' }, { status: 404 });
        if (existing && !canEditRow(sess, existing)) {
          return jsonResponse({ error: 'That page belongs to another account.' }, { status: 403 });
        }

        // The parent never changes once a page is created — its URL and the
        // link back to it would both break.
        const parent = existing
          ? await wikiParentRow(env, existing.parent_type, existing.parent_slug)
          : await wikiParentRow(env, String(b.parentType || ''), String(b.parentSlug || ''));
        if (!parent) return jsonResponse({ error: 'That script or collection could not be found.' }, { status: 404 });
        if (!existing && !canEditRow(sess, { owner_id: parent.ownerId })) {
          return jsonResponse({ error: 'Only the owner of "' + parent.name + '" can add pages to it.' }, { status: 403 });
        }
        if (!sess.isAdmin && await isProtected(env, parent.type, parent.slug)) {
          return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
        }

        // Slug is derived from the title once, then frozen so links keep
        // working. A clash with someone else's page gets a numeric suffix.
        let slug = existing ? existing.slug : kebab(title);
        if (!slug) return jsonResponse({ error: 'Could not build a URL from that title.' }, { status: 400 });
        if (!existing) {
          const taken = async s => !!(await env.DB.prepare('SELECT 1 FROM pages WHERE slug=?')
            .bind(s).first().catch(() => null));
          let candidate = slug;
          for (let i = 2; i < 60 && await taken(candidate); i++) candidate = slug + '-' + i;
          // The upsert below would overwrite an existing page, so never save
          // onto a slug that is still taken — ask for a different title first.
          if (await taken(candidate)) {
            return jsonResponse({ error: 'Too many pages already use that title. Give this one a different name.' }, { status: 409 });
          }
          slug = candidate;
        }

        const page = {
          slug, title,
          subtitle: b.subtitle, blurb: b.blurb, author: b.author,
          body: b.body, header: b.header, images: b.images,
          boxes: b.boxes, infobox: b.infobox, theme: b.theme,
          toc: b.toc, comments: b.comments
        };
        sanitizeWikiFields(page, 'pages/' + slug + '-', 'pages/' + slug);
        page.parentType = parent.type;
        page.parentSlug = parent.slug;
        if (!page.blurb) page.blurb = WikiRender.autoSummary(page.body, 140);

        const status = b.status === 'published' ? 'published' : 'draft';
        if (existing) await saveRevision(env, sess, 'wikipage', existing);
        await env.DB.prepare(
          `INSERT INTO pages (slug,title,parent_type,parent_slug,author,owner_id,data,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             title=excluded.title, author=excluded.author, data=excluded.data,
             status=excluded.status, updated_at=datetime('now')`
        ).bind(slug, title, parent.type, parent.slug, page.author || null,
               existing ? existing.owner_id : sess.userId, JSON.stringify(page), status).run();
        await logActivity(env, sess, existing ? 'update' : 'create', 'wikipage', slug, title);
        return jsonResponse({
          ok: true, slug, status,
          parentType: parent.type, parentKey: parent.key, parentName: parent.name
        });
      }

      // ---- publish / unpublish a page ----
      if (path === '/api/publish') {
        {
          const limited = await writeLimited(env, request, sess, 'publish');
          if (limited) return limited;
        }
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || 'character');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        let row = await getEntityRow(env, type, String(b.slug || ''));
        // Legacy collections have display-string PK slugs; the URL uses the id.
        if (!row && type === 'collection') row = await findCollectionRow(env, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        if (!canEditRow(sess, row)) return jsonResponse({ error: 'That page belongs to another account.' }, { status: 403 });
        if (row.status === 'deleted') return jsonResponse({ error: 'That page is deleted. An admin can restore it from the dashboard.' }, { status: 400 });
        if (!sess.isAdmin && await isProtected(env, type, row.slug)) {
          return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
        }
        const status = b.status === 'draft' ? 'draft' : 'published';
        // Same rule as /api/character: a name, an icon, an ability and tags.
        const pubData = type === 'character' ? parseData(row) : null;
        const pubMissing = type === 'character' ? Classify.missingForPublish(pubData) : [];
        if (status === 'published' && pubMissing.length) {
          return jsonResponse({
            error: 'This character needs ' + Classify.listPhrase(pubMissing) +
                   ' before it can be published. Open the editor and add that.',
            needsIcon: true, missingForPublish: pubMissing
          }, { status: 400 });
        }
        await env.DB.prepare(`UPDATE ${t.table} SET status=?, updated_at=datetime('now') WHERE slug=?`)
          .bind(status, row.slug).run();
        await logActivity(env, sess, status === 'published' ? 'publish' : 'unpublish', type, row.slug, row.name);
        return jsonResponse({ ok: true, slug: row.slug, status });
      }

      // ---- delete a page (SOFT delete) ----
      // The row is not removed — its status is flipped to 'deleted' so it drops
      // out of the whole site (public JSON, SSR pages, search, the owner's
      // account list) but can still be restored, or purged for good, from the
      // admin Deleted Content panel. This keeps scripts/JSON that reference a
      // character from silently breaking on an accidental delete. The prior
      // status + who/when is stashed in the data blob (no schema migration).
      if (path === '/api/delete') {
        {
          const limited = await writeLimited(env, request, sess, 'publish');
          if (limited) return limited;
        }
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || 'character');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        let row = await getEntityRow(env, type, String(b.slug || ''));
        // Legacy collections have display-string PK slugs; the URL uses the id.
        if (!row && type === 'collection') row = await findCollectionRow(env, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        if (!canEditRow(sess, row)) return jsonResponse({ error: 'That page belongs to another account.' }, { status: 403 });
        if (!sess.isAdmin && await isProtected(env, type, row.slug)) {
          return jsonResponse({ error: PROTECTED_MSG }, { status: 423 });
        }
        if (row.status === 'deleted') return jsonResponse({ ok: true, slug: row.slug });
        let data;
        try { data = foldLegacyCurata(JSON.parse(row.data)); } catch { data = {}; }
        let byName = null;
        try {
          const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
          byName = u ? u.username : null;
        } catch { /* non-fatal */ }
        data._deleted = { at: new Date().toISOString(), by: byName, from: row.status || 'published' };
        await env.DB.prepare(`UPDATE ${t.table} SET status='deleted', data=?, updated_at=datetime('now') WHERE slug=?`)
          .bind(JSON.stringify(data), row.slug).run();
        await logActivity(env, sess, 'delete', type, row.slug, row.name);
        return jsonResponse({ ok: true, slug: row.slug });
      }

      // ---- admin: restore a soft-deleted page ----
      // Puts the row back to the status it had before deletion (published or
      // draft) and clears the _deleted marker.
      if (path === '/api/admin/restore') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        let row = await getEntityRow(env, type, String(b.slug || ''));
        if (!row && type === 'collection') row = await findCollectionRow(env, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        if (row.status !== 'deleted') return jsonResponse({ error: 'That page is not deleted.' }, { status: 400 });
        let data;
        try { data = foldLegacyCurata(JSON.parse(row.data)); } catch { data = {}; }
        const from = (data._deleted && data._deleted.from) || 'published';
        const status = from === 'draft' ? 'draft' : 'published';
        delete data._deleted;
        await env.DB.prepare(`UPDATE ${t.table} SET status=?, data=?, updated_at=datetime('now') WHERE slug=?`)
          .bind(status, JSON.stringify(data), row.slug).run();
        await logActivity(env, sess, 'restore', type, row.slug, row.name);
        return jsonResponse({ ok: true, slug: row.slug, status });
      }

      // ---- admin: permanently purge a soft-deleted page ----
      // Only removes rows already in the 'deleted' state, so a page can never be
      // hard-deleted without first passing through the recoverable trash.
      if (path === '/api/admin/purge') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        let row = await getEntityRow(env, type, String(b.slug || ''));
        if (!row && type === 'collection') row = await findCollectionRow(env, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        if (row.status !== 'deleted') return jsonResponse({ error: 'Purge only removes already-deleted pages. Delete it first.' }, { status: 400 });
        await env.DB.prepare(`DELETE FROM ${t.table} WHERE slug=?`).bind(row.slug).run();
        // A purged page is gone for good — drop its version history too.
        try {
          await env.DB.prepare('DELETE FROM revisions WHERE entity_type=? AND slug=?').bind(type, row.slug).run();
        } catch { /* revisions table may not exist yet */ }
        await logActivity(env, sess, 'purge', type, row.slug, row.name);
        return jsonResponse({ ok: true, slug: row.slug });
      }

      // ---- admin: roll a page back to an earlier revision ----
      // Body: {type, slug, id} where id is a revision id from
      // /api/admin/revisions. The current version is snapshotted first, so a
      // rollback can itself be rolled back. Publish status and ownership are
      // left as they are — only the page content moves.
      if (path === '/api/admin/rollback') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        if (!REVISABLE[type]) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        const row = await revisableRow(env, type, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        if (row.status === 'deleted') {
          return jsonResponse({ error: 'That page is in the trash. Restore it from Deleted Content first, then roll it back.' }, { status: 400 });
        }
        await ensureRevisionsTable(env);
        const rev = await env.DB.prepare(
          'SELECT id, ts, data FROM revisions WHERE id=? AND entity_type=? AND slug=?'
        ).bind(parseInt(b.id, 10) || 0, type, row.slug).first();
        if (!rev) return jsonResponse({ error: 'No such revision for that page.' }, { status: 404 });
        let d;
        try { d = foldLegacyCurata(JSON.parse(rev.data)); } catch { d = null; }
        if (!d) return jsonResponse({ error: 'That revision is corrupt and cannot be restored.' }, { status: 500 });
        delete d._deleted;
        await saveRevision(env, sess, type, row); // make the rollback undoable
        try { await applyRollback(env, type, row, d); }
        catch (e) { return jsonResponse({ error: (e && e.message) || 'Could not restore that revision.' }, { status: 500 }); }
        await logActivity(env, sess, 'rollback', type, row.slug, d.name || d.displayName || d.title || row.name);
        return jsonResponse({ ok: true, slug: row.slug, restoredFrom: rev.ts });
      }

      // ---- admin: link a creator name to an account (or unlink it) ----
      // Body: {name, username} to link, {name, username: null} to pin the name
      // as deliberately unlinked, {name, clear: true} to go back to deciding by
      // ownership. This is what covers bulk-imported pages, which have no owner
      // and so can never prove who made them. The control lives on the creator
      // page itself, where you notice the problem.
      if (path === '/api/admin/creator-alias') {
        const b = await request.json().catch(() => ({}));
        const name = String(b.name || '').trim();
        if (!name) return jsonResponse({ error: 'Missing creator name' }, { status: 400 });
        const key = creatorAliasKey(name);
        if (b.clear) {
          await env.DB.prepare('DELETE FROM settings WHERE key=?').bind(key).run();
          const acct = await resolveCreatorAccount(env, name);
          return jsonResponse({ ok: true, username: acct ? acct.username : null, cleared: true });
        }
        const uname = String(b.username || '').trim();
        if (uname) {
          // findUserByUsername, not a raw query: typing the creator's accented
          // spelling into this box has to reach their ASCII handle.
          const u = await findUserByUsername(env, uname);
          if (!u) return jsonResponse({ error: 'No account with that username.' }, { status: 404 });
          await env.DB.prepare(
            'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
          ).bind(key, u.username).run();
          await logActivity(env, sess, 'update', 'creator', name, u.username);
          return jsonResponse({ ok: true, username: u.username });
        }
        // Empty value = "this name has no account", overruling any ownership match.
        await env.DB.prepare(
          'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
        ).bind(key, '').run();
        await logActivity(env, sess, 'update', 'creator', name, null);
        return jsonResponse({ ok: true, username: null });
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
          const u = await findUserByUsername(env, uname);
          if (!u) return jsonResponse({ error: 'No user named "' + uname + '".' }, { status: 404 });
          ownerId = u.id;
        }
        await env.DB.prepare(`UPDATE ${t.table} SET owner_id=?, updated_at=datetime('now') WHERE slug=?`)
          .bind(ownerId, row.slug).run();
        await logActivity(env, sess, 'assign-owner', type, row.slug, row.name);
        // A script or collection carries its characters with it, unless
        // somebody already owns them (see waterfallOwner).
        const spread = await waterfallOwner(env, sess, type, row, ownerId);
        return jsonResponse({
          ok: true, slug: row.slug, owner: uname || null,
          characters: spread.claimed, charactersHeld: spread.held
        });
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

      // ---- contact the admins (bug reports, suggestions, anything) ----
      if (path === '/api/contact') {
        if (await rateLimited(env, request, 'contact', 5, 3600)) {
          return tooManyResponse('Too many messages in a row. Try again in a bit.', 3600);
        }
        const b = await request.json().catch(() => ({}));
        const category = ['bug', 'suggestion', 'question', 'other'].includes(b.category) ? b.category : 'other';
        const body = String(b.body || '').trim().slice(0, 2000);
        if (body.length < 5) return jsonResponse({ error: 'Please write a message first.' }, { status: 400 });
        await ensureMessagesTable(env);
        let uname = null;
        try {
          const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
          uname = u ? u.username : null;
        } catch { /* non-fatal */ }
        await env.DB.prepare(
          'INSERT INTO messages (user_id, username, category, body) VALUES (?,?,?,?)'
        ).bind(sess.userId, uname, category, body).run();
        await logActivity(env, sess, 'contact', 'message', null, category);
        return jsonResponse({ ok: true, message: 'Message sent — the admins will see it on their dashboard.' });
      }

      // ---- direct messages: send ----
      if (path === '/api/messages/send') {
        if (acctFlags.banned) {
          return jsonResponse({ error: 'This account is suspended and cannot send messages. You can contact the admins from your account page.' }, { status: 403 });
        }
        if (await rateLimited(env, request, 'dm', 20, 300)) {
          return tooManyResponse('You are sending messages very quickly — wait a minute and try again.', 300);
        }
        const b = await request.json().catch(() => ({}));
        const to = String(b.to || '').trim();
        const body = String(b.body || '').trim().slice(0, 3000);
        if (!to) return jsonResponse({ error: 'Missing recipient.' }, { status: 400 });
        if (!body) return jsonResponse({ error: 'Write a message first.' }, { status: 400 });
        await ensureDmTables(env);
        const target = await findUserByUsername(env, to);
        if (!target) return jsonResponse({ error: 'No user is named “' + to + '”.' }, { status: 404 });
        if (target.id === sess.userId) return jsonResponse({ error: "You can't message yourself." }, { status: 400 });
        // Blocks stop regular users; admins bypass them so the admin <-> user
        // channel (warnings, appeals) always works.
        if (!sess.isAdmin) {
          const blocked = await env.DB.prepare(
            'SELECT 1 FROM dm_blocks WHERE user_id=? AND blocked_id=?'
          ).bind(target.id, sess.userId).first();
          if (blocked) return jsonResponse({ error: 'This user is not accepting messages from you.' }, { status: 403 });
        }
        const ins = await env.DB.prepare(
          'INSERT INTO dms (sender_id, recipient_id, body) VALUES (?,?,?)'
        ).bind(sess.userId, target.id, body).run();
        return jsonResponse({ ok: true, id: ins.meta.last_row_id });
      }

      // ---- direct messages: block / unblock a user ----
      if (path === '/api/messages/block') {
        const b = await request.json().catch(() => ({}));
        await ensureDmTables(env);
        const target = await findUserByUsername(env, String(b.user || '').trim());
        if (!target) return jsonResponse({ error: 'No such user.' }, { status: 404 });
        if (target.id === sess.userId) return jsonResponse({ error: "You can't block yourself." }, { status: 400 });
        if (b.blocked) {
          await env.DB.prepare('INSERT OR IGNORE INTO dm_blocks (user_id, blocked_id) VALUES (?,?)')
            .bind(sess.userId, target.id).run();
        } else {
          await env.DB.prepare('DELETE FROM dm_blocks WHERE user_id=? AND blocked_id=?')
            .bind(sess.userId, target.id).run();
        }
        return jsonResponse({ ok: true, blocked: !!b.blocked });
      }

      // ---- direct messages: hide a whole conversation for yourself ----
      // The other person keeps their copy; rows hidden by both sides are
      // permanently purged.
      if (path === '/api/messages/delete') {
        const b = await request.json().catch(() => ({}));
        await ensureDmTables(env);
        const target = await findUserByUsername(env, String(b.with || '').trim());
        if (!target) return jsonResponse({ error: 'No such user.' }, { status: 404 });
        await env.DB.batch([
          env.DB.prepare('UPDATE dms SET sender_deleted=1 WHERE sender_id=? AND recipient_id=?')
            .bind(sess.userId, target.id),
          env.DB.prepare('UPDATE dms SET recipient_deleted=1 WHERE recipient_id=? AND sender_id=?')
            .bind(sess.userId, target.id),
          env.DB.prepare('DELETE FROM dms WHERE sender_deleted=1 AND recipient_deleted=1')
        ]);
        return jsonResponse({ ok: true });
      }

      // ---- direct messages: report a conversation to the admins ----
      // Creating a report is what unlocks the conversation for admin review
      // (GET /api/admin/dm-thread refuses un-reported pairs).
      if (path === '/api/messages/report') {
        if (await rateLimited(env, request, 'dmreport', 5, 3600)) {
          return tooManyResponse('Too many reports in a row. Try again later.', 3600);
        }
        const b = await request.json().catch(() => ({}));
        await ensureDmTables(env);
        const target = await findUserByUsername(env, String(b.with || '').trim());
        if (!target) return jsonResponse({ error: 'No such user.' }, { status: 404 });
        if (target.id === sess.userId) return jsonResponse({ error: "You can't report yourself." }, { status: 400 });
        const convo = await env.DB.prepare(
          `SELECT 1 FROM dms
           WHERE (sender_id=?1 AND recipient_id=?2 AND sender_deleted=0)
              OR (sender_id=?2 AND recipient_id=?1 AND recipient_deleted=0)
           LIMIT 1`
        ).bind(sess.userId, target.id).first();
        if (!convo) return jsonResponse({ error: 'There are no messages with this user to report.' }, { status: 400 });
        const already = await env.DB.prepare(
          "SELECT 1 FROM dm_reports WHERE reporter_id=? AND reported_id=? AND status='open'"
        ).bind(sess.userId, target.id).first();
        if (!already) {
          const reason = String(b.reason || '').trim().slice(0, 500) || null;
          await env.DB.prepare(
            'INSERT INTO dm_reports (reporter_id, reported_id, reason) VALUES (?,?,?)'
          ).bind(sess.userId, target.id, reason).run();
          await logActivity(env, sess, 'report', 'dm', null, target.username);
        }
        return jsonResponse({ ok: true, message: 'Reported. The admins can now review this conversation.' });
      }

      // ---- admin: manage a user (ban/unban/promote/demote/reset link) ----
      if (path === '/api/admin/user') {
        await ensureBanColumn(env);
        const b = await request.json().catch(() => ({}));
        const action = String(b.action || '');
        const target = await env.DB.prepare(
          'SELECT id, username, is_admin, COALESCE(banned,0) AS banned FROM users WHERE id=?'
        ).bind(parseInt(b.id, 10) || 0).first();
        if (!target) return jsonResponse({ error: 'No such user.' }, { status: 404 });
        if (target.id === sess.userId && (action === 'ban' || action === 'demote')) {
          return jsonResponse({ error: "You can't " + (action === 'ban' ? 'ban' : 'demote') + ' your own account.' }, { status: 400 });
        }
        // Ban and take their pages down in one action. Banning a spam account
        // that has already published forty pages used to leave forty pages up,
        // and the only way to clear them was the bulk tool, one type at a time.
        // Unpublishing is deliberately reversible — nothing is deleted, so a
        // wrong call is undone by unbanning and republishing.
        // `dryRun` returns the counts without touching anything, so the button
        // can say exactly what it is about to do before it does it.
        if (action === 'ban-purge' || (action === 'ban' && b.purge)) {
          if (target.is_admin) return jsonResponse({ error: 'Admins cannot be banned. Remove admin first.' }, { status: 400 });
          const counts = {};
          let total = 0;
          for (const [type, meta] of Object.entries(CONTENT)) {
            const r = await env.DB.prepare(
              `SELECT COUNT(*) AS n FROM ${meta.table} WHERE owner_id=? AND status='published'`
            ).bind(target.id).first().catch(() => null);
            counts[type] = r ? Number(r.n) || 0 : 0;
            total += counts[type];
          }
          if (b.dryRun) {
            return jsonResponse({ ok: true, dryRun: true, username: target.username, counts, total });
          }
          await env.DB.prepare('UPDATE users SET banned=1 WHERE id=?').bind(target.id).run();
          await revokeSessions(env, target.id);
          // One statement per table rather than per page: the bulk tools issue
          // a query per slug and would blow the subrequest limit on an account
          // that has published a few hundred pages.
          for (const meta of Object.values(CONTENT)) {
            await env.DB.prepare(
              `UPDATE ${meta.table} SET status='draft' WHERE owner_id=? AND status='published'`
            ).bind(target.id).run().catch(() => {});
          }
          await logActivity(env, sess, 'ban', 'user', null,
            target.username + ' (+ unpublished ' + total + ' page' + (total === 1 ? '' : 's') + ')');
          return jsonResponse({ ok: true, banned: true, counts, total });
        }
        if (action === 'ban') {
          if (target.is_admin) return jsonResponse({ error: 'Admins cannot be banned. Remove admin first.' }, { status: 400 });
          await env.DB.prepare('UPDATE users SET banned=1 WHERE id=?').bind(target.id).run();
          await revokeSessions(env, target.id);
          await logActivity(env, sess, 'ban', 'user', null, target.username);
        } else if (action === 'unban') {
          await env.DB.prepare('UPDATE users SET banned=0 WHERE id=?').bind(target.id).run();
          await logActivity(env, sess, 'unban', 'user', null, target.username);
        } else if (action === 'promote') {
          await env.DB.prepare('UPDATE users SET is_admin=1, banned=0 WHERE id=?').bind(target.id).run();
          await logActivity(env, sess, 'promote', 'user', null, target.username);
        } else if (action === 'demote') {
          await env.DB.prepare('UPDATE users SET is_admin=0 WHERE id=?').bind(target.id).run();
          await logActivity(env, sess, 'demote', 'user', null, target.username);
        } else if (action === 'reset-link') {
          // One-time password reset link (24 h) the admin can hand to the
          // user directly — works even when email isn't configured.
          const token = randomToken();
          await env.SESSIONS.put('pwreset:' + token, String(target.id), { expirationTtl: 86400 });
          await logActivity(env, sess, 'reset-link', 'user', null, target.username);
          return jsonResponse({ ok: true, resetLink: url.origin + '/reset-password?token=' + token });
        } else {
          return jsonResponse({ error: 'Unknown action.' }, { status: 400 });
        }
        return jsonResponse({ ok: true });
      }

      // ---- admin: inbox message actions ----
      if (path === '/api/admin/message') {
        await ensureMessagesTable(env);
        const b = await request.json().catch(() => ({}));
        const id = parseInt(b.id, 10) || 0;
        const action = String(b.action || '');
        if (action === 'delete') {
          await env.DB.prepare('DELETE FROM messages WHERE id=?').bind(id).run();
        } else if (action === 'resolve' || action === 'reopen') {
          await env.DB.prepare('UPDATE messages SET status=? WHERE id=?')
            .bind(action === 'resolve' ? 'resolved' : 'open', id).run();
        } else if (action === 'reply') {
          // Answering a contact message. The answer goes out as a direct
          // message from the admin who wrote it, which is what makes it
          // reachable: it lands in the person's /messages, bumps the unread
          // count on /api/me, lights the mail flag site.js puts on "My
          // Account", and they can simply write back — none of which a reply
          // stored only on this row would do.
          const body = String(b.body || '').trim().slice(0, 3000);
          if (body.length < 2) return jsonResponse({ error: 'Write a reply first.' }, { status: 400 });
          const msg = await env.DB.prepare('SELECT id, user_id, username FROM messages WHERE id=?')
            .bind(id).first().catch(() => null);
          if (!msg) return jsonResponse({ error: 'That message no longer exists.' }, { status: 404 });
          if (!msg.user_id) {
            return jsonResponse({ error: 'This message has no account attached, so there is nobody to reply to.' }, { status: 400 });
          }
          if (msg.user_id === sess.userId) {
            return jsonResponse({ error: "That's your own message — you can't reply to yourself." }, { status: 400 });
          }
          await ensureDmTables(env);
          // Deliberately NOT checking dm_blocks: admins bypass blocks
          // everywhere else for exactly this reason, and somebody who wrote to
          // the admins is owed the answer whatever their block list says.
          await env.DB.prepare(
            'INSERT INTO dms (sender_id, recipient_id, body) VALUES (?,?,?)'
          ).bind(sess.userId, msg.user_id, body).run();
          // The session carries only {userId, isAdmin} — the name is looked up,
          // the same way logActivity does it.
          let adminName = null;
          try {
            const a = await env.DB.prepare('SELECT username FROM users WHERE id=?')
              .bind(sess.userId).first();
            adminName = a ? a.username : null;
          } catch { /* the record is still worth writing without a name */ }
          await env.DB.prepare(
            "UPDATE messages SET last_reply=?, replied_at=datetime('now'), replied_by=? WHERE id=?"
          ).bind(body, adminName, id).run();
          await logActivity(env, sess, 'reply', 'message', String(id), msg.username || null);
          return jsonResponse({ ok: true, sentTo: msg.username || null });
        } else {
          return jsonResponse({ error: 'Unknown action.' }, { status: 400 });
        }
        return jsonResponse({ ok: true });
      }

      // ---- admin: resolve/reopen/delete a reported DM conversation ----
      if (path === '/api/admin/dm-report') {
        await ensureDmTables(env);
        const b = await request.json().catch(() => ({}));
        const id = parseInt(b.id, 10) || 0;
        const action = String(b.action || '');
        if (action === 'delete') {
          await env.DB.prepare('DELETE FROM dm_reports WHERE id=?').bind(id).run();
        } else if (action === 'resolve' || action === 'reopen') {
          await env.DB.prepare('UPDATE dm_reports SET status=? WHERE id=?')
            .bind(action === 'resolve' ? 'resolved' : 'open', id).run();
        } else {
          return jsonResponse({ error: 'Unknown action.' }, { status: 400 });
        }
        return jsonResponse({ ok: true });
      }

      // ---- admin: protect / unprotect one page ----
      if (path === '/api/admin/protect') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        if (!CONTENT[type]) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        let row = await getEntityRow(env, type, String(b.slug || ''));
        if (!row && type === 'collection') row = await findCollectionRow(env, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        if (b.protected) {
          await env.DB.prepare(
            `INSERT INTO settings (key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'`
          ).bind(protectKey(type, row.slug)).run();
          await logActivity(env, sess, 'protect', type, row.slug, row.name);
        } else {
          await env.DB.prepare('DELETE FROM settings WHERE key=?').bind(protectKey(type, row.slug)).run();
          await logActivity(env, sess, 'unprotect', type, row.slug, row.name);
        }
        return jsonResponse({ ok: true, slug: row.slug, protected: !!b.protected });
      }

      // ---- admin: create / update / delete a news article ----
      // {slug?, title, author?, summary?, body, image?, pinned?, status}
      // The slug is derived from the title on first save and then frozen, so
      // published article URLs never move under readers' feet.
      if (path === '/api/admin/news') {
        await ensureNewsTable(env);
        const b = await request.json().catch(() => ({}));
        const kebab = s => String(s || '').toLowerCase().normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '').slice(0, 80);

        if (b.action === 'delete') {
          const slug = String(b.slug || '');
          const row = await env.DB.prepare('SELECT title FROM news WHERE slug=?').bind(slug).first().catch(() => null);
          if (!row) return jsonResponse({ error: 'Article not found.' }, { status: 404 });
          await env.DB.prepare('DELETE FROM news WHERE slug=?').bind(slug).run();
          await ensureCommentTables(env);
          await env.DB.prepare("DELETE FROM comments WHERE entity_type='news' AND slug=?").bind(slug).run();
          await logActivity(env, sess, 'delete', 'news', slug, row.title);
          return jsonResponse({ ok: true, deleted: slug });
        }

        const title = String(b.title || '').trim().slice(0, 160);
        if (!title) return jsonResponse({ error: 'Give the article a title.' }, { status: 400 });
        const body = String(b.body || '').replace(/\r\n/g, '\n').slice(0, 40000);
        if (!body.trim()) return jsonResponse({ error: 'Write the article body first.' }, { status: 400 });

        let slug = kebab(b.slug) || kebab(title);
        if (!slug) return jsonResponse({ error: 'Could not build a URL from that title.' }, { status: 400 });
        const existing = await env.DB.prepare('SELECT * FROM news WHERE slug=?').bind(slug).first().catch(() => null);
        // A brand-new article (no slug sent) whose title happens to kebab down
        // to an article that already exists must NOT overwrite it.
        if (existing && !b.slug) {
          return jsonResponse({
            error: 'An article with that title already exists — open it from the list below to edit it, or change the title.'
          }, { status: 409 });
        }

        const image = String(b.image || '').trim().slice(0, 300);
        const article = {
          slug, title,
          author: String(b.author || '').trim().slice(0, 80) || null,
          summary: String(b.summary || '').trim().slice(0, 300) || null,
          body,
          // Hero images live in the R2 news/scripts/collections areas or are
          // remote URLs; anything else is dropped rather than half-trusted.
          image: (/^https?:\/\//i.test(image) || /^(news|scripts|collections|art)\/[a-z0-9._ -]+\.(png|jpe?g|webp)$/i.test(image))
            ? image : null,
          pinned: !!b.pinned,
          // Images uploaded for this article, so the editor can list them again.
          images: Array.isArray(b.images)
            ? b.images.slice(0, 40).map(x => String(x))
                .filter(s => s.indexOf('news/' + slug + '-') === 0 && s.indexOf('..') === -1 &&
                             /^[a-z0-9/._ -]+\.(png|jpe?g|webp)$/i.test(s))
            : [],
          // Same page furniture the custom wiki pages get: contents box,
          // side boxes, fact box and the theme kit.
          toc: !!b.toc,
          boxes: sanitizeBoxes(b.boxes),
          infobox: sanitizeInfobox(b.infobox),
          theme: PageRender.sanitizeTheme(b.theme, 'news/' + slug)
        };
        if (!article.infobox) delete article.infobox;
        if (!article.theme) delete article.theme;
        const status = b.status === 'published' ? 'published' : 'draft';
        // published_at is stamped once, the first time it goes live, so
        // editing an old article doesn't jump it to the top of the list.
        const publishedAt = status === 'published'
          ? ((existing && existing.published_at) || new Date().toISOString().replace('T', ' ').slice(0, 19))
          : (existing ? existing.published_at : null);

        await env.DB.prepare(
          `INSERT INTO news (slug,title,owner_id,data,status,created_at,updated_at,published_at)
           VALUES (?,?,?,?,?,datetime('now'),datetime('now'),?)
           ON CONFLICT(slug) DO UPDATE SET
             title=excluded.title, data=excluded.data, status=excluded.status,
             updated_at=datetime('now'), published_at=excluded.published_at`
        ).bind(slug, title, sess.userId, JSON.stringify(article), status, publishedAt).run();
        await logActivity(env, sess, existing ? 'update' : 'create', 'news', slug, title);
        return jsonResponse({ ok: true, slug, status });
      }

      // ---- admin: act on one comment ----
      // remove/restore the comment itself, or clear its report queue entry.
      if (path === '/api/admin/comment') {
        await ensureCommentTables(env);
        const b = await request.json().catch(() => ({}));
        const id = parseInt(b.id, 10);
        const action = String(b.action || '');
        if (!id) return jsonResponse({ error: 'Missing comment id.' }, { status: 400 });
        const row = await env.DB.prepare('SELECT * FROM comments WHERE id=?').bind(id).first().catch(() => null);
        if (!row) return jsonResponse({ error: 'Comment not found.' }, { status: 404 });
        if (action === 'remove' || action === 'restore') {
          const removing = action === 'remove';
          let by = null;
          try {
            const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
            by = u ? u.username : null;
          } catch { /* non-fatal */ }
          if (removing) await removeCommentCascade(env, row, by);
          else await restoreCommentCascade(env, row);
          await logActivity(env, sess, removing ? 'comment-remove' : 'comment-restore',
            row.entity_type, row.slug, 'comment #' + id);
        } else if (action === 'resolve') {
          await env.DB.prepare("UPDATE comment_reports SET status='resolved' WHERE comment_id=?").bind(id).run();
        } else if (action === 'purge') {
          // Permanent: drops the row, its replies, and all their reports.
          const ids = [id];
          if (!row.parent_id) {
            const { results } = await env.DB.prepare('SELECT id FROM comments WHERE parent_id=?')
              .bind(id).all().catch(() => ({ results: [] }));
            for (const r of results || []) ids.push(r.id);
          }
          for (const cid of ids) {
            await env.DB.prepare('DELETE FROM comment_reports WHERE comment_id=?').bind(cid).run();
            await env.DB.prepare('DELETE FROM comments WHERE id=?').bind(cid).run();
          }
          await logActivity(env, sess, 'comment-purge', row.entity_type, row.slug,
            'comment #' + id + (ids.length > 1 ? ' + ' + (ids.length - 1) + ' repl' + (ids.length === 2 ? 'y' : 'ies') : ''));
        } else {
          return jsonResponse({ error: 'Unknown action.' }, { status: 400 });
        }
        return jsonResponse({ ok: true, id, action });
      }

      // ---- admin: Curata status ----
      // Curata is the only stored half of the classification system: a
      // boolean in the page's data JSON that only this endpoint can write.
      // It works on characters, collections and scripts alike.
      if (path === '/api/admin/curata') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        let row = await getEntityRow(env, type, String(b.slug || ''));
        if (!row && type === 'collection') row = await findCollectionRow(env, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        const on = !!b.curata;
        const d = parseData(row);
        /* The creator may have declined the mark on their own page. The grant
           is still recorded — it is the admins' decision and taking it away
           silently would lose it — but the answer says so, or an admin sees a
           successful grant and a page with no wreath and re-grants it. */
        const optOut = !!d.curataOptOut;
        if (!!d.curata === on) return jsonResponse({ ok: true, slug: row.slug, curata: on, optOut });
        d.curata = on;
        if (!on) delete d.curata;
        await env.DB.prepare(`UPDATE ${t.table} SET data=?, updated_at=datetime('now') WHERE slug=?`)
          .bind(JSON.stringify(d), row.slug).run();
        await logActivity(env, sess, on ? 'curata' : 'uncurata', type, row.slug, row.name);
        return jsonResponse({ ok: true, slug: row.slug, curata: on, optOut });
      }

      // ---- admin: gather one creator's characters into a collection ----
      // Membership is normally auto-matched on the character's "Appears in"
      // text, but a creator's back catalogue does not share one — so this
      // writes the roster into the collection's explicit include[] list.
      // Creates the collection when it does not exist yet. {dryRun:true}
      // reports what it would gather without writing anything.
      if (path === '/api/admin/collect-creator') {
        const b = await request.json().catch(() => ({}));
        const creator = String(b.creator || '').trim();
        const collName = String(b.collection || '').trim();
        if (!creator || !collName) {
          return jsonResponse({ error: 'Need both a creator and a collection name.' }, { status: 400 });
        }
        // One credit can name several people, so match a comma-separated
        // segment rather than the whole column (see creditMatchSQL).
        const { results } = await env.DB.prepare(
          `SELECT slug, name FROM characters
            WHERE status IS NOT 'deleted' AND ${creditMatchSQL('creator')}
            ORDER BY name`
        ).bind(normCreator(creator)).all().catch(() => ({ results: [] }));
        const slugs = (results || []).map(r => r.slug);
        const existing = await findCollectionRow(env, collName);
        if (b.dryRun) {
          return jsonResponse({
            ok: true, dryRun: true, creator, collection: collName,
            exists: !!existing, count: slugs.length,
            pages: (results || []).slice(0, 300)
          });
        }
        if (!slugs.length) return jsonResponse({ error: 'That creator has no pages.' }, { status: 404 });
        const kebab = x => String(x || '').toLowerCase().normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '').slice(0, 80);
        const d = existing ? parseData(existing) : {};
        const id = d.id || kebab(collName);
        const pk = existing ? existing.slug : id;
        d.id = id;
        d.slug = pk;
        d.displayName = d.displayName || collName;
        d.author = d.author || creator;
        d.description = d.description || ('Everything ' + creator + ' has made for the wiki.');
        d.match = Array.isArray(d.match) ? d.match : [];
        d.exclude = Array.isArray(d.exclude) ? d.exclude : [];
        // include[] is capped at 500 by sanitizePageFields; 258 fits today.
        d.include = [...new Set([...(Array.isArray(d.include) ? d.include : []), ...slugs])];
        d.curata = existing ? !!parseData(existing).curata : false;
        sanitizePageFields(d, 'collections/' + id);
        if (existing) await saveRevision(env, sess, 'collection', existing);
        await env.DB.prepare(
          `INSERT INTO collections (slug,display_name,owner_id,data,status,created_at,updated_at)
           VALUES (?,?,?,?, 'published', datetime('now'), datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             display_name=excluded.display_name, data=excluded.data, updated_at=datetime('now')`
        ).bind(pk, d.displayName, sess.userId, JSON.stringify(d)).run();
        await logActivity(env, sess, existing ? 'update' : 'create', 'collection', pk,
          d.displayName + ' (' + slugs.length + ' from ' + creator + ')');
        return jsonResponse({ ok: true, id, slug: pk, count: d.include.length, added: slugs.length });
      }

      // ---- admin: rules constructs stop being characters ----
      // States, Conditions, Calls, Alignments and Properties were imported as
      // Fabled characters, but they are reference text, not people you can
      // put on a script. This rewrites each one as a wiki page under a parent
      // collection and soft-deletes the character it came from (recoverable
      // from Deleted Content, and its last version is in revisions).
      // {dryRun:true} shows exactly what it would write.
      if (path === '/api/admin/concepts-to-pages') {
        await ensurePagesTable(env);
        const b = await request.json().catch(() => ({}));
        const from = String(b.from || '').trim();          // an "Appears in" value
        const parentKey = String(b.parent || '').trim();   // collection id/slug
        if (!from || !parentKey) {
          return jsonResponse({ error: 'Need both the source “Appears in” value and the parent collection.' }, { status: 400 });
        }
        const parent = await wikiParentRow(env, 'collection', parentKey);
        if (!parent) return jsonResponse({ error: 'No collection called “' + parentKey + '”.' }, { status: 404 });
        const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        const { results } = await env.DB.prepare(
          "SELECT slug, name, data FROM characters WHERE status IS NOT 'deleted'"
        ).all().catch(() => ({ results: [] }));
        const hits = (results || []).filter(r => norm(parseData(r).appearsIn) === norm(from));

        // A character's almanac, rewritten as wiki-page markup. Only the
        // fields that hold anything; the order matches how /c/ reads.
        const bodyFor = d => {
          const out = [];
          const lines = v => (Array.isArray(v) ? v : [v]).filter(x => typeof x === 'string' && x.trim());
          if (d.quote && String(d.quote).trim()) out.push('> ' + String(d.quote).trim());
          if (d.lede && String(d.lede).trim()) out.push('*' + String(d.lede).trim() + '*');
          if (d.ability && String(d.ability).trim()) out.push('**' + String(d.ability).trim() + '**');
          const section = (title, v) => {
            const l = lines(v);
            if (l.length) out.push('## ' + title + '\n' + l.map(x => '- ' + x.trim()).join('\n'));
          };
          section('Summary', d.summaryBullets);
          const how = lines(d.howToRun);
          if (how.length) out.push('## How to Run\n' + how.map(x => x.trim()).join('\n\n'));
          section('Examples', d.examples);
          section('Tips', d.tips);
          if (d.callout && String(d.callout).trim()) out.push('::: ' + String(d.callout).trim());
          return out.join('\n\n');
        };
        const kebab = x => String(x || '').toLowerCase().normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '').slice(0, 70);

        const plan = [];
        for (const r of hits) {
          const d = parseData(r);
          const body = bodyFor(d);
          let slug = kebab(r.name) || kebab(r.slug);
          plan.push({ from: r.slug, name: r.name, slug, body, hasBody: !!body.trim(), author: d.creator || null });
        }
        if (b.dryRun) {
          return jsonResponse({
            ok: true, dryRun: true, parent: parent.name, count: plan.length,
            pages: plan.map(p => ({ from: p.from, name: p.name, slug: p.slug, hasBody: p.hasBody,
                                    preview: p.body.slice(0, 220) }))
          });
        }
        if (!plan.length) return jsonResponse({ error: 'Nothing matched that “Appears in” value.' }, { status: 404 });
        let made = 0;
        const skipped = [];
        for (const p of plan) {
          // Never write over a page that already exists on that slug.
          const taken = await env.DB.prepare('SELECT 1 FROM pages WHERE slug=?').bind(p.slug).first().catch(() => null);
          if (taken) { skipped.push(p.slug); continue; }
          if (!p.hasBody) { skipped.push(p.slug + ' (nothing to write)'); continue; }
          const page = {
            slug: p.slug, title: p.name, subtitle: '', blurb: '', author: p.author,
            body: p.body, header: '', images: [], boxes: [], toc: true, comments: true
          };
          sanitizeWikiFields(page, 'pages/' + p.slug + '-', 'pages/' + p.slug);
          page.parentType = 'collection';
          page.parentSlug = parent.slug;
          if (!page.blurb) page.blurb = WikiRender.autoSummary(page.body, 140);
          await env.DB.prepare(
            `INSERT INTO pages (slug,title,parent_type,parent_slug,author,owner_id,data,status,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?, 'published', datetime('now'), datetime('now'))`
          ).bind(p.slug, p.name, 'collection', parent.slug, p.author, sess.userId, JSON.stringify(page)).run();
          // Retire the character it came from — soft, so Deleted Content can
          // put it back if any of this turns out wrong.
          const row = await getEntityRow(env, 'character', p.from);
          if (row) {
            await saveRevision(env, sess, 'character', row);
            const cd = parseData(row);
            cd._deleted = { at: new Date().toISOString(), by: null, from: row.status || 'published',
                            note: 'converted to wiki page /p/' + p.slug };
            await env.DB.prepare("UPDATE characters SET status='deleted', data=?, updated_at=datetime('now') WHERE slug=?")
              .bind(JSON.stringify(cd), row.slug).run();
          }
          made++;
        }
        await logActivity(env, sess, 'create', 'wikipage', null,
          made + ' rules page(s) converted from characters');
        return jsonResponse({ ok: true, made, skipped, parent: parent.name });
      }

      // ---- admin: grant Curata to everything one account owns ----
      // Curata is what says "an admin has looked at this", and it also
      // lifts a page out of Partial. Doing that one page at a time through
      // Bulk actions is 200 tick-boxes at a time; this is the same write in
      // one press. Idempotent — pages that already have it are skipped — so
      // it can be re-run after adding more. {dryRun:true} just counts.
      if (path === '/api/admin/curata-owner') {
        const b = await request.json().catch(() => ({}));
        const uname = String(b.username || '').trim();
        if (!uname) return jsonResponse({ error: 'Which account?' }, { status: 400 });
        const u = await findUserByUsername(env, uname);
        if (!u) return jsonResponse({ error: 'No account named "' + uname + '".' }, { status: 404 });
        const { results } = await env.DB.prepare(
          "SELECT slug, name, data FROM characters WHERE owner_id=? AND status IS NOT 'deleted'"
        ).bind(u.id).all();
        const hits = (results || []).filter(r => !parseData(r).curata);
        if (b.dryRun) {
          return jsonResponse({
            ok: true, dryRun: true, username: u.username,
            owned: (results || []).length, count: hits.length,
            pages: hits.slice(0, 300).map(r => ({ slug: r.slug, name: r.name }))
          });
        }
        for (const r of hits) {
          const d = parseData(r);
          d.curata = true;
          await env.DB.prepare("UPDATE characters SET data=?, updated_at=datetime('now') WHERE slug=?")
            .bind(JSON.stringify(d), r.slug).run();
        }
        await logActivity(env, sess, 'curata', 'character', null,
          hits.length + ' page(s) owned by ' + u.username);
        return jsonResponse({ ok: true, username: u.username, count: hits.length });
      }

      /* ---- admin: open tag editing on one account's untagged characters ----
         A bulk import leaves hundreds of pages owned by one account with no
         tags, and tags are the one thing a page needs that a stranger can
         supply correctly without knowing the character: they are picked from a
         fixed list (tags.js), and 'tags' is the narrowest sharing mode there
         is. The save handler rebuilds the stored page and takes ONLY the tags
         from the request, so opening this costs nothing else.

         Two rules keep it safe to run:
         - Only pages with no tags at all. A page somebody already tagged is
           left shut; this is for filling a gap, not for reopening finished work.
         - Only pages with no sharing mode set. A page already on 'all',
           'suggest' or 'approved' keeps what its owner chose — this must never
           quietly NARROW an open page to tags-only.
         Re-runnable, and reversible one page at a time from the editor. */
      if (path === '/api/admin/tags-open-owner') {
        const b = await request.json().catch(() => ({}));
        const uname = String(b.username || '').trim();
        if (!uname) return jsonResponse({ error: 'Which account?' }, { status: 400 });
        const u = await findUserByUsername(env, uname);
        if (!u) return jsonResponse({ error: 'No account named "' + uname + '".' }, { status: 404 });
        const { results } = await env.DB.prepare(
          "SELECT slug, name, tags, data FROM characters WHERE owner_id=? AND status IS NOT 'deleted'"
        ).bind(u.id).all();
        const owned = results || [];
        /* parseData() answers {} for a blob it cannot read, which is right for
           rendering and wrong for a read-modify-write: this handler writes the
           object back, so a row whose JSON is broken would come out as
           {"publicEdit":"tags"} with the whole character gone. Parse it here
           instead and skip anything that is not a readable object. */
        const readData = r => {
          if (!r || !r.data) return null;
          try {
            const d = JSON.parse(r.data);
            return (d && typeof d === 'object' && !Array.isArray(d)) ? d : null;
          } catch { return null; }
        };
        // The tags column and the blob can disagree on a hand-written row, so a
        // page counts as tagged if EITHER says so.
        const untagged = (r, d) => !String(r.tags || '').trim() && !String(d.tags || '').trim();
        const hits = [], skipped = [];
        let alreadyOpen = 0, untaggedTotal = 0;
        for (const r of owned) {
          const d = readData(r);
          if (!d) { skipped.push(r.slug); continue; }
          if (!untagged(r, d)) continue;
          untaggedTotal++;
          if (publicEditMode(d)) { alreadyOpen++; continue; }
          hits.push({ row: r, data: d });
        }
        if (b.dryRun !== false) {
          return jsonResponse({
            ok: true, dryRun: true, username: u.username,
            owned: owned.length,
            untagged: untaggedTotal,
            alreadyOpen,
            skipped,
            count: hits.length,
            pages: hits.slice(0, 300).map(h => ({ slug: h.row.slug, name: h.row.name }))
          });
        }
        for (const h of hits) {
          h.data.publicEdit = 'tags';
          await env.DB.prepare("UPDATE characters SET data=?, updated_at=datetime('now') WHERE slug=?")
            .bind(JSON.stringify(h.data), h.row.slug).run();
        }
        await logActivity(env, sess, 'tags-open', 'character', null,
          'tag editing opened on ' + hits.length + ' untagged page(s) owned by ' + u.username);
        return jsonResponse({ ok: true, username: u.username, count: hits.length, alreadyOpen, skipped });
      }

      // ---- admin: sweep published characters that miss the publish bar ----
      // ---- give every character a nested address ----
      // Retroactive /c/{set}/{character} for the whole wiki, so no page keeps a
      // bare first-come URL: the first Priest stops owning /c/priest and every
      // Priest is filed under the set (or the author) it belongs to.
      //
      // ALWAYS dry-run it first: {dryRun:true} reports what it would do,
      // including the qualifier each page resolved to, and writes nothing.
      //
      // Everything is resolved from maps built once, not per row: 1,647
      // characters × a collection scan each would be thousands of queries.
      // `taken` is held in memory for the same reason, and because two rows in
      // the same run must not be handed the same address.
      //
      // Re-runnable. Rows that already sit at the address they ask for are left
      // alone, so a second pass after registering a collection only moves the
      // pages that collection just claimed.
      if (path === '/api/admin/nest-urls') {
        const b = await request.json().catch(() => ({}));
        const dryRun = b.dryRun !== false;
        const limit = Math.max(1, Math.min(5000, Number(b.limit) || 5000));
        await ensureUrlSlugColumn(env);
        await ensureRedirectsTable(env);

        // --- lookup maps, built once ---
        const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        const setKey = new Map();       // normalised set name -> {q, kind}
        const includedIn = new Map();   // character identity -> qualifier
        try {
          const { results } = await env.DB.prepare('SELECT slug, data FROM collections').all();
          for (const r of results || []) {
            let d = {};
            try { d = foldLegacyCurata(JSON.parse(r.data)); } catch { /* skip bad rows */ }
            const q = kebab(d.id || r.slug);
            if (!q) continue;
            for (const k of [r.slug, d.id, d.displayName, d.name]) {
              if (k && !setKey.has(norm(k))) setKey.set(norm(k), { q, kind: 'collection' });
            }
            for (const s of (Array.isArray(d.include) ? d.include : [])) {
              if (typeof s === 'string' && !includedIn.has(s)) includedIn.set(s, q);
            }
          }
        } catch { /* no collections is survivable */ }
        try {
          const { results } = await env.DB.prepare('SELECT slug, data FROM scripts').all();
          for (const r of results || []) {
            let d = {};
            try { d = JSON.parse(r.data); } catch { /* skip bad rows */ }
            const q = kebab(r.slug);
            if (!q) continue;
            // Collections win outright, so a name both claim keeps the
            // collection it already resolved to.
            for (const k of [r.slug, d.id, d.displayName, d.name]) {
              if (k && !setKey.has(norm(k))) setKey.set(norm(k), { q, kind: 'script' });
            }
          }
        } catch { /* no scripts is survivable */ }
        // Rosters, for characters with no "Appears in" of their own that a
        // script plainly owns (the Blood on the TARDIS cast).
        try {
          const { results } = await env.DB.prepare(
            'SELECT slug, data FROM scripts ORDER BY created_at, slug'
          ).all();
          for (const r of results || []) {
            const q = kebab(r.slug);
            if (!q) continue;
            let d = {};
            try { d = JSON.parse(r.data); } catch { continue; }
            for (const x of (Array.isArray(d.characters) ? d.characters : [])) {
              // Collections were indexed first and keep the character.
              if (typeof x === 'string' && !x.startsWith('off-') && !includedIn.has(x)) {
                includedIn.set(x, q);
              }
            }
          }
        } catch { /* no rosters is survivable */ }
        const userName = new Map();
        try {
          const { results } = await env.DB.prepare('SELECT id, username FROM users').all();
          for (const r of results || []) userName.set(Number(r.id), kebab(r.username));
        } catch { /* fall through to the misc bucket */ }

        // --- every character, oldest first, so a run is deterministic ---
        const { results: rows } = await env.DB.prepare(
          `SELECT slug, url_slug, name, creator, appears_in, owner_id, status
             FROM characters ORDER BY created_at, slug`
        ).all();

        // Addresses already spoken for, plus every address any page has ever
        // had — taking one of those back would hijack a live redirect.
        const taken = new Set();
        for (const r of rows || []) if (r.url_slug) taken.add(String(r.url_slug));
        try {
          const { results } = await env.DB.prepare(
            "SELECT from_slug FROM redirects WHERE entity_type='character'"
          ).all();
          for (const r of results || []) if (r.from_slug) taken.add(String(r.from_slug));
        } catch { /* nothing has ever moved */ }

        const kinds = { collection: 0, script: 0, unregistered: 0, listed: 0, creator: 0, account: 0, fallback: 0 };
        const plan = [];
        for (const r of rows || []) {
          const segs = String(r.appears_in || '').split(',').map(x => x.trim()).filter(Boolean);
          let q = '', kind = '';
          for (const s of segs) {
            const hit = setKey.get(norm(s));
            if (hit && hit.kind === 'collection') { q = hit.q; kind = 'collection'; break; }
          }
          if (!q) for (const s of segs) {
            const hit = setKey.get(norm(s));
            if (hit) { q = hit.q; kind = hit.kind; break; }
          }
          // A set this wiki has no page for is still a set, and reads far
          // better than scattering its characters under their authors.
          if (!q && segs.length) { q = kebab(segs[0]); if (q) kind = 'unregistered'; }
          // Listed by hand in a collection, or on a script's roster.
          if (!q && includedIn.has(String(r.slug))) {
            q = includedIn.get(String(r.slug)); kind = 'listed';
          }
          if (!q) {
            const cred = creditNames(r.creator || '')[0];
            q = kebab(cred); if (q) kind = 'creator';
          }
          if (!q && r.owner_id != null) {
            q = userName.get(Number(r.owner_id)) || ''; if (q) kind = 'account';
          }
          if (!q) { q = CHAR_ADDR_FALLBACK; kind = 'fallback'; }

          const base = kebab(r.name) || kebab(r.slug) || 'character';
          const first = q + '/' + base;
          const current = r.url_slug ? String(r.url_slug) : '';
          // Already filed correctly, including as a numbered duplicate.
          const settled = current === first ||
            (!!current && current.startsWith(first + '-') &&
             /^\d+$/.test(current.slice(first.length + 1)));
          // Nothing to do, and nothing a re-run could improve: a settled row
          // already sits under the qualifier and name it resolves to.
          if (settled) { kinds[kind]++; continue; }

          let address = first;
          if (taken.has(address)) {
            for (let i = 2; i < 500; i++) {
              if (!taken.has(first + '-' + i)) { address = first + '-' + i; break; }
            }
          }
          if (taken.has(address)) continue;   // 500 of one name in one set: leave it
          // Reserved for good, including the address this page is leaving:
          // that one is about to become a redirect pointing here, and
          // handing it to another character in the same run would send
          // every old link to the wrong page.
          taken.add(address);
          if (current) taken.add(current);
          kinds[kind]++;
          plan.push({ slug: String(r.slug), from: current, to: address, kind });
          if (plan.length >= limit) break;
        }

        if (dryRun) {
          return jsonResponse({
            ok: true, dryRun: true, scanned: (rows || []).length,
            wouldChange: plan.length, kinds,
            samples: plan.slice(0, 40)
          });
        }

        let changed = 0;
        for (let i = 0; i < plan.length; i += 40) {
          const chunk = plan.slice(i, i + 40);
          const stmts = [];
          for (const p of chunk) {
            stmts.push(env.DB.prepare('UPDATE characters SET url_slug=? WHERE slug=?')
              .bind(p.to, p.slug));
            // Only a real previous ADDRESS needs remembering. A page that has
            // never had one is still reachable at /c/{identity} through the
            // primary key, so the first nesting needs no redirect row at all.
            if (p.from) {
              stmts.push(env.DB.prepare(
                `INSERT INTO redirects (entity_type, from_slug, to_slug) VALUES ('character',?,?)
                 ON CONFLICT(entity_type, from_slug) DO UPDATE SET to_slug=excluded.to_slug`
              ).bind(p.from, p.slug));
            }
            stmts.push(env.DB.prepare(
              "DELETE FROM redirects WHERE entity_type='character' AND from_slug=?"
            ).bind(p.to));
          }
          try { await env.DB.batch(stmts); changed += chunk.length; }
          catch { /* keep going: a failed chunk is retried by the next run */ }
        }
        // Written straight to D1, so the feeds and the in-isolate caches have
        // to be told, or every page keeps serving its old address.
        await bumpContentVersion(env);
        await logActivity(env, sess, 'nest-urls', 'character', '', changed + ' addresses');
        return jsonResponse({
          ok: true, dryRun: false, scanned: (rows || []).length,
          changed, kinds, samples: plan.slice(0, 40)
        });
      }

      // The bar (name, icon, ability, tags — Classify.missingForPublish) only
      // bites on save/publish, so this catches the pages that went live before
      // it existed or before it was raised. Every affected page becomes a
      // draft — nothing is deleted, and re-publishing is one click once its
      // owner fills the gap. ALWAYS dry-run it first: {dryRun:true} returns
      // the count and the reasons without touching anything.
      // The old /api/admin/demote-no-icon path still works.
      if (path === '/api/admin/demote-incomplete' || path === '/api/admin/demote-no-icon') {
        const b = await request.json().catch(() => ({}));
        const { results } = await env.DB.prepare(
          "SELECT slug, name, data FROM characters WHERE status='published'"
        ).all();
        // Fabled rules pages (States/Conditions/Calls) have no icon and no
        // tags by nature — missingForPublish() keeps them out of this.
        const hits = [];
        for (const r of results || []) {
          const missing = Classify.missingForPublish(parseData(r));
          if (missing.length) hits.push({ slug: r.slug, name: r.name, missing });
        }
        // How many pages each requirement accounts for, so the dashboard can
        // say "231 of these are only missing tags" before anything is moved.
        const byReason = {};
        for (const h of hits) for (const m of h.missing) byReason[m] = (byReason[m] || 0) + 1;
        if (b.dryRun) {
          return jsonResponse({
            ok: true, dryRun: true, count: hits.length, byReason,
            pages: hits.slice(0, 300)
          });
        }
        // One awaited UPDATE per hit blew the Worker's 1,000-subrequest limit:
        // this sweep is unbounded, and on a wiki with thousands of characters
        // it would die partway through with no way to tell how far it got.
        // IN (...) chunks instead — D1 caps bound parameters at 100, so 90.
        for (let i = 0; i < hits.length; i += 90) {
          const chunk = hits.slice(i, i + 90).map(h => h.slug);
          const marks = chunk.map(() => '?').join(',');
          await env.DB.prepare(
            `UPDATE characters SET status='draft', updated_at=datetime('now')
              WHERE slug IN (${marks})`
          ).bind(...chunk).run();
        }
        await logActivity(env, sess, 'unpublish', 'character', null,
          hits.length + ' incomplete page(s) moved to draft');
        return jsonResponse({ ok: true, count: hits.length, byReason, pages: hits.map(h => h.slug) });
      }

      /* ---- official characters that have slipped onto the wiki ----
         This wiki is for homebrew. A page that IS an official character is a
         duplicate of one the official wiki already has, hosts art that is not
         ours, and takes the name from anyone writing a real homebrew character
         of it. /api/character refuses to make another one; this finds the ones
         made before that guard existed.

         Two lists, and only one of them is ever acted on:
           exact  name AND ability are the official character's. These are
                  repointed and retired.
           named  the name is shared, the ability is not. Reported only — this
                  wiki has a Pope and a Nightwatchman that are nothing like the
                  official ones, and telling a reworked character from a
                  retyped one is a judgement no comparison should make alone.

         Retiring one is a SOFT delete, the same one /api/delete does, so it
         sits in the dashboard's deleted list and can be restored. Nothing is
         purged and no art is removed. Always {dryRun:true} first. */
      if (path === '/api/admin/official-cleanup') {
        const b = await request.json().catch(() => ({}));
        const roster = await loadOfficialRoles(env, url.origin);
        if (!roster.length) {
          return jsonResponse({ error: 'The official roster could not be loaded, so nothing was compared.' }, { status: 503 });
        }
        const { results } = await env.DB.prepare(
          "SELECT slug, name, status, owner_id, data FROM characters WHERE status != 'deleted'"
        ).all();
        const exact = [], named = [];
        for (const r of results || []) {
          const d = parseData(r);
          const graded = OfficialRoles.officialMatch(roster, { name: r.name, ability: d.ability });
          if (!graded) continue;
          const row = {
            slug: r.slug, name: r.name, status: r.status || 'published',
            creator: d.creator || '', officialId: graded.role.id,
            officialSlug: graded.role.slug, usedBy: []
          };
          (graded.match === 'exact' ? exact : named).push(row);
        }

        // Which scripts and collections point at each one, so the report can
        // say what moves and the run knows what to rewrite. Both tables are
        // small (tens of rows), so one scan each is cheaper than a query per
        // hit.
        const bySlug = new Map(exact.map(h => [h.slug, h]));
        const scriptRows = bySlug.size
          ? (await env.DB.prepare("SELECT slug, name, data FROM scripts WHERE status != 'deleted'").all()).results || []
          : [];
        const collRows = bySlug.size
          ? (await env.DB.prepare("SELECT slug, display_name, data FROM collections WHERE status != 'deleted'").all()).results || []
          : [];
        const scriptEdits = [], collEdits = [];
        for (const sc of scriptRows) {
          const d = parseData(sc);
          const list = Array.isArray(d.characters) ? d.characters : [];
          if (!list.some(x => bySlug.has(String(x)))) continue;
          // The roster keeps the character: the slug is swapped for the
          // official one ('off-{id}'), which is what every other script on the
          // wiki already uses, so the page still lists it and the name links
          // to the official wiki instead of to a page that is about to go.
          const next = [];
          for (const x of list) {
            const hit = bySlug.get(String(x));
            const val = hit ? hit.officialSlug : String(x);
            if (!next.includes(val)) next.push(val);
          }
          d.characters = next;
          scriptEdits.push({ slug: sc.slug, name: sc.name, data: d });
          for (const x of list) { const h = bySlug.get(String(x)); if (h) h.usedBy.push('script:' + sc.slug); }
        }
        for (const cl of collRows) {
          const d = parseData(cl);
          let touched = false;
          // A collection holds pages on THIS wiki, and 'off-' resolves to none
          // of them — so here the character is dropped rather than swapped.
          for (const field of ['include', 'exclude', 'order']) {
            if (!Array.isArray(d[field])) continue;
            const next = d[field].filter(x => !bySlug.has(String(x)));
            if (next.length !== d[field].length) { d[field] = next; touched = true; }
          }
          if (!touched) continue;
          collEdits.push({ slug: cl.slug, name: cl.display_name, data: d });
          for (const field of ['include', 'exclude', 'order']) {
            for (const x of (parseData(cl)[field] || [])) {
              const h = bySlug.get(String(x));
              if (h && !h.usedBy.includes('collection:' + cl.slug)) h.usedBy.push('collection:' + cl.slug);
            }
          }
        }

        if (b.dryRun) {
          return jsonResponse({
            ok: true, dryRun: true,
            exact, named,
            scripts: scriptEdits.map(e => ({ slug: e.slug, name: e.name })),
            collections: collEdits.map(e => ({ slug: e.slug, name: e.name }))
          });
        }
        if (!exact.length) {
          return jsonResponse({ ok: true, exact: [], named, scripts: [], collections: [] });
        }
        for (const e of scriptEdits) {
          await env.DB.prepare("UPDATE scripts SET data=?, updated_at=datetime('now') WHERE slug=?")
            .bind(JSON.stringify(e.data), e.slug).run();
        }
        for (const e of collEdits) {
          await env.DB.prepare("UPDATE collections SET data=?, updated_at=datetime('now') WHERE slug=?")
            .bind(JSON.stringify(e.data), e.slug).run();
        }
        // Retire the pages the same way /api/delete does, so they land in the
        // dashboard's deleted list and can be put back.
        let byName = null;
        try {
          const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
          byName = u ? u.username : null;
        } catch { /* non-fatal */ }
        for (const h of exact) {
          const row = await getEntityRow(env, 'character', h.slug);
          if (!row) continue;
          const d = parseData(row);
          d._deleted = {
            at: new Date().toISOString(), by: byName, from: row.status || 'published',
            reason: 'official character (' + h.officialId + ')'
          };
          await env.DB.prepare(
            "UPDATE characters SET status='deleted', data=?, updated_at=datetime('now') WHERE slug=?"
          ).bind(JSON.stringify(d), row.slug).run();
        }
        await logActivity(env, sess, 'delete', 'character', null,
          exact.length + ' official character page(s) retired');
        return jsonResponse({
          ok: true, exact, named,
          scripts: scriptEdits.map(e => ({ slug: e.slug, name: e.name })),
          collections: collEdits.map(e => ({ slug: e.slug, name: e.name }))
        });
      }

      // ---- admin: one-time Odyssey text cleanup ----
      // Strips the translation's em dashes and rewrites its gendered pronouns
      // to they/them/their across the Odyssey almanacs, leaving `ability` and
      // the flavour quote's pronouns alone. The rules live in
      // migration/odyssey-cleanup.js so the same code can be dry-run locally.
      // Remove this block, the import at the top and the dashboard card once
      // it has been run.
      if (path === '/api/admin/cleanup-odyssey') {
        const b = await request.json().catch(() => ({}));
        // translatedBy is the Odyssey import's own marker: it matches those 119
        // rows and nothing else on the wiki.
        const { results } = await env.DB.prepare(
          "SELECT slug, name, status, data FROM characters WHERE json_extract(data,'$.translatedBy')='DJ_DJ_DJ'"
        ).all();
        const rows = results || [];
        const plan = [], flags = [];
        for (const row of rows) {
          const res = OdysseyCleanup.cleanCharacter(parseData(row));
          res.flags.forEach(f => flags.push({ slug: row.slug, field: f.field, flag: f.flag }));
          if (res.changed) plan.push({ row, data: res.data, n: res.changed });
        }
        if (b.dryRun) {
          return jsonResponse({
            ok: true, dryRun: true, scanned: rows.length,
            pages: plan.length, fields: plan.reduce((a, p) => a + p.n, 0),
            flags
          });
        }
        // A flagged case means the rules met something they were not built for.
        // Refuse rather than write half-checked prose.
        if (flags.length) {
          return jsonResponse({ error: flags.length + ' flagged case(s); nothing was changed.', flags }, { status: 400 });
        }
        for (const p of plan) {
          await saveRevision(env, sess, 'character', p.row);
          await env.DB.prepare("UPDATE characters SET data=?, updated_at=datetime('now') WHERE slug=?")
            .bind(JSON.stringify(p.data), p.row.slug).run();
        }
        await logActivity(env, sess, 'update', 'character', null,
          'Odyssey text cleanup: ' + plan.length + ' page(s)');
        return jsonResponse({
          ok: true, scanned: rows.length, pages: plan.length,
          fields: plan.reduce((a, p) => a + p.n, 0), flags: []
        });
      }

      // ---- admin: site-wide announcement banner ----
      if (path === '/api/admin/announce') {
        const b = await request.json().catch(() => ({}));
        // Roomier than it looks: [label](https://…) link markup eats
        // characters that the reader never sees.
        const text = String(b.text || '').trim().slice(0, 600);
        if (!text) {
          await env.DB.prepare("DELETE FROM settings WHERE key='announcement'").run();
          await logActivity(env, sess, 'announce', 'wiki', null, 'cleared');
          return jsonResponse({ ok: true, announcement: null });
        }
        let by = null;
        try {
          const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
          by = u ? u.username : null;
        } catch { /* non-fatal */ }
        const ann = { text, at: new Date().toISOString(), by };
        await env.DB.prepare(
          `INSERT INTO settings (key,value) VALUES ('announcement',?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value`
        ).bind(JSON.stringify(ann)).run();
        await logActivity(env, sess, 'announce', 'wiki', null, text.slice(0, 60));
        return jsonResponse({ ok: true, announcement: ann });
      }

      // ---- admin: rewrite one of the site's own strings (/text-editor) ----
      // {original, replacement, scope, source}. A replacement equal to the
      // original — or an empty one, or {action:'revert'} — drops the row and
      // puts the wording in the source file back in charge. Nothing is ever
      // written to a page: this is a lookup site.js applies in the browser,
      // so an override can always be undone by deleting the row.
      if (path === '/api/admin/site-text') {
        await ensureSiteTextTable(env);
        const b = await request.json().catch(() => ({}));
        const original = String(b.original || '');
        const scope = String(b.scope || '*').slice(0, 200) || '*';
        if (!original) return jsonResponse({ error: 'Nothing to change: no original text.' }, { status: 400 });
        if (original.length > SITE_TEXT_MAX) {
          return jsonResponse({ error: 'That string is too long to override.' }, { status: 400 });
        }
        if (scope !== '*' && !/^\/[\w./-]*$/.test(scope)) {
          return jsonResponse({ error: 'Bad scope.' }, { status: 400 });
        }
        const replacement = String(b.replacement == null ? '' : b.replacement).slice(0, SITE_TEXT_MAX);
        const revert = b.action === 'revert' || !replacement.trim() || replacement === original;

        if (revert) {
          await env.DB.prepare('DELETE FROM site_text WHERE scope=? AND original=?')
            .bind(scope, original).run();
          _siteTextCache = null;
          await logActivity(env, sess, 'site-text', 'wiki', null, 'reverted: ' + original.slice(0, 50));
          return jsonResponse({ ok: true, reverted: true, items: await siteTextItems(env) });
        }

        const existing = await env.DB.prepare(
          'SELECT id FROM site_text WHERE scope=? AND original=?'
        ).bind(scope, original).first();
        if (!existing) {
          const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM site_text').first();
          if (c && c.n >= SITE_TEXT_ROWS) {
            return jsonResponse({ error: 'Too many text overrides already saved.' }, { status: 400 });
          }
        }
        let by = null;
        try {
          const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
          by = u ? u.username : null;
        } catch { /* non-fatal */ }
        await env.DB.prepare(
          `INSERT INTO site_text (scope, source, original, replacement, updated_at, updated_by)
           VALUES (?,?,?,?,datetime('now'),?)
           ON CONFLICT(scope, original) DO UPDATE SET
             replacement=excluded.replacement,
             source=excluded.source,
             updated_at=excluded.updated_at,
             updated_by=excluded.updated_by`
        ).bind(scope, String(b.source || '').slice(0, 500) || null, original, replacement, by).run();
        _siteTextCache = null;
        await logActivity(env, sess, 'site-text', 'wiki', null, original.slice(0, 60));
        return jsonResponse({ ok: true, items: await siteTextItems(env) });
      }

      // ---- admin: delete orphaned images picked from /api/admin/orphans ----
      if (path === '/api/admin/purge-images') {
        if (!env.ART) return jsonResponse({ error: 'Image storage (R2) is not configured' }, { status: 500 });
        const b = await request.json().catch(() => ({}));
        const keys = (Array.isArray(b.keys) ? b.keys : []).slice(0, 100).filter(k =>
          typeof k === 'string' && !k.includes('..') &&
          ['art/', 'scripts/', 'collections/', 'avatars/'].some(p => k.startsWith(p))
        );
        if (!keys.length) return jsonResponse({ error: 'No image keys given.' }, { status: 400 });
        for (const k of keys) {
          try { await env.ART.delete(k); } catch { /* best-effort */ }
        }
        await logActivity(env, sess, 'purge-images', 'wiki', null, keys.length + ' images');
        return jsonResponse({ ok: true, deleted: keys.length });
      }

      // ---- admin: strip broken character refs from one script/collection ----
      if (path === '/api/admin/clean-refs') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        if (type !== 'script' && type !== 'collection') return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        let row = await getEntityRow(env, type, String(b.slug || ''));
        if (!row && type === 'collection') row = await findCollectionRow(env, String(b.slug || ''));
        if (!row) return jsonResponse({ error: 'Not found' }, { status: 404 });
        const rm = new Set((Array.isArray(b.remove) ? b.remove : []).map(String));
        if (!rm.size) return jsonResponse({ error: 'Nothing to remove.' }, { status: 400 });
        let d;
        try { d = foldLegacyCurata(JSON.parse(row.data)); } catch { return jsonResponse({ error: 'Page data is corrupt.' }, { status: 500 }); }
        await saveRevision(env, sess, type, row);
        let removed = 0;
        function strip(list) {
          const before = (list || []).length;
          const out = (list || []).filter(s => !rm.has(String(s)));
          removed += before - out.length;
          return out;
        }
        if (type === 'script') {
          d.characters = strip(d.characters);
          await env.DB.prepare(`UPDATE scripts SET data=?, updated_at=datetime('now') WHERE slug=?`)
            .bind(JSON.stringify(d), row.slug).run();
        } else {
          d.include = strip(d.include);
          d.exclude = strip(d.exclude);
          await env.DB.prepare(`UPDATE collections SET data=?, updated_at=datetime('now') WHERE slug=?`)
            .bind(JSON.stringify(d), row.slug).run();
        }
        await logActivity(env, sess, 'clean-refs', type, row.slug, row.name);
        return jsonResponse({ ok: true, slug: row.slug, removed });
      }

      // ---- admin: restore one page from a nightly backup ----
      // The current version (if any) is snapshotted to history first. Also
      // recovers pages that were purged — the row is re-created.
      if (path === '/api/admin/restore-page') {
        if (!env.ART) return jsonResponse({ error: 'Image storage (R2) is not configured' }, { status: 500 });
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        const date = String(b.date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonResponse({ error: 'Bad backup date.' }, { status: 400 });
        const rows = await readBackupTable(env, date, t.table);
        if (!rows) return jsonResponse({ error: 'No backup of ' + t.table + ' for ' + date + ', or the file is corrupt.' }, { status: 404 });
        const want = String(b.slug || '');
        const hit = (rows || []).find(r => r && r.slug === want) ||
                    (rows || []).find(r => r && String(r.slug).toLowerCase() === want.toLowerCase());
        if (!hit) return jsonResponse({ error: 'No page with that slug in the ' + date + ' backup.' }, { status: 404 });
        const current = await getEntityRow(env, type, hit.slug);
        if (current) await saveRevision(env, sess, type, current);
        const status = ['published', 'draft', 'deleted'].includes(hit.status) ? hit.status : 'published';
        if (type === 'character') {
          await env.DB.prepare(
            `INSERT INTO characters (slug,name,team,creator,owner_id,tags,appears_in,data,status,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,COALESCE(?,datetime('now')),datetime('now'))
             ON CONFLICT(slug) DO UPDATE SET
               name=excluded.name, team=excluded.team, creator=excluded.creator,
               owner_id=excluded.owner_id, tags=excluded.tags, appears_in=excluded.appears_in,
               data=excluded.data, status=excluded.status, updated_at=datetime('now')`
          ).bind(hit.slug, hit.name, hit.team, hit.creator || null, hit.owner_id || null,
                 hit.tags || null, hit.appears_in || null, hit.data, status, hit.created_at || null).run();
        } else if (type === 'collection') {
          await env.DB.prepare(
            `INSERT INTO collections (slug,display_name,owner_id,data,status,created_at,updated_at)
             VALUES (?,?,?,?,?,COALESCE(?,datetime('now')),datetime('now'))
             ON CONFLICT(slug) DO UPDATE SET
               display_name=excluded.display_name, owner_id=excluded.owner_id,
               data=excluded.data, status=excluded.status, updated_at=datetime('now')`
          ).bind(hit.slug, hit.display_name || hit.slug, hit.owner_id || null, hit.data, status, hit.created_at || null).run();
        } else {
          await env.DB.prepare(
            `INSERT INTO scripts (slug,name,author,owner_id,data,status,created_at,updated_at)
             VALUES (?,?,?,?,?,?,COALESCE(?,datetime('now')),datetime('now'))
             ON CONFLICT(slug) DO UPDATE SET
               name=excluded.name, author=excluded.author, owner_id=excluded.owner_id,
               data=excluded.data, status=excluded.status, updated_at=datetime('now')`
          ).bind(hit.slug, hit.name || hit.slug, hit.author || null, hit.owner_id || null, hit.data, status, hit.created_at || null).run();
        }
        await logActivity(env, sess, 'restore-backup', type, hit.slug, hit.name || hit.display_name || hit.slug);
        return jsonResponse({ ok: true, slug: hit.slug, status, date });
      }

      // ---- admin: bulk actions across many pages ----
      // Body: {action, type, slugs[], username?, tag?}. Actions: publish,
      // unpublish, delete, restore, assign-owner, clear-owner, add-tag,
      // remove-tag (tags are characters only).
      if (path === '/api/admin/bulk') {
        const b = await request.json().catch(() => ({}));
        const type = String(b.type || '');
        const t = CONTENT[type];
        if (!t) return jsonResponse({ error: 'Unknown type' }, { status: 400 });
        const action = String(b.action || '');
        const ACTIONS = ['publish', 'unpublish', 'delete', 'restore', 'assign-owner', 'clear-owner',
                        'add-tag', 'remove-tag', 'curata', 'uncurata'];
        if (!ACTIONS.includes(action)) return jsonResponse({ error: 'Unknown action.' }, { status: 400 });
        const slugs = (Array.isArray(b.slugs) ? b.slugs : []).slice(0, 200).map(String);
        if (!slugs.length) return jsonResponse({ error: 'No pages selected.' }, { status: 400 });
        let ownerId = null;
        if (action === 'assign-owner') {
          const u = await findUserByUsername(env, String(b.username || '').trim());
          if (!u) return jsonResponse({ error: 'No user named "' + String(b.username || '') + '".' }, { status: 404 });
          ownerId = u.id;
        }
        const tag = String(b.tag || '').trim().slice(0, 40);
        if ((action === 'add-tag' || action === 'remove-tag')) {
          if (type !== 'character') return jsonResponse({ error: 'Tags only apply to characters.' }, { status: 400 });
          if (!tag) return jsonResponse({ error: 'Enter a tag first.' }, { status: 400 });
        }
        let adminName = null;
        try {
          const u = await env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sess.userId).first();
          adminName = u ? u.username : null;
        } catch { /* non-fatal */ }
        let done = 0, claimed = 0, held = 0;
        // One read of the character table for the whole batch (see
        // rosterCharacterSlugs), however many collections it assigns.
        const rosterCache = {};
        const failed = [];
        for (const slug of slugs) {
          try {
            let row = await getEntityRow(env, type, slug);
            if (!row && type === 'collection') row = await findCollectionRow(env, slug);
            if (!row) { failed.push(slug); continue; }
            if (action === 'publish' || action === 'unpublish') {
              if (row.status === 'deleted') { failed.push(slug); continue; }
              await env.DB.prepare(`UPDATE ${t.table} SET status=?, updated_at=datetime('now') WHERE slug=?`)
                .bind(action === 'publish' ? 'published' : 'draft', row.slug).run();
            } else if (action === 'delete') {
              if (row.status === 'deleted') { done++; continue; }
              let data; try { data = foldLegacyCurata(JSON.parse(row.data)); } catch { data = {}; }
              data._deleted = { at: new Date().toISOString(), by: adminName, from: row.status || 'published' };
              await env.DB.prepare(`UPDATE ${t.table} SET status='deleted', data=?, updated_at=datetime('now') WHERE slug=?`)
                .bind(JSON.stringify(data), row.slug).run();
            } else if (action === 'restore') {
              if (row.status !== 'deleted') { done++; continue; }
              let data; try { data = foldLegacyCurata(JSON.parse(row.data)); } catch { data = {}; }
              const from = (data._deleted && data._deleted.from) || 'published';
              delete data._deleted;
              await env.DB.prepare(`UPDATE ${t.table} SET status=?, data=?, updated_at=datetime('now') WHERE slug=?`)
                .bind(from === 'draft' ? 'draft' : 'published', JSON.stringify(data), row.slug).run();
            } else if (action === 'assign-owner' || action === 'clear-owner') {
              await env.DB.prepare(`UPDATE ${t.table} SET owner_id=?, updated_at=datetime('now') WHERE slug=?`)
                .bind(action === 'assign-owner' ? ownerId : null, row.slug).run();
              if (action === 'assign-owner') {
                const spread = await waterfallOwner(env, sess, type, row, ownerId, rosterCache);
                claimed += spread.claimed;
                held += spread.held;
              }
            } else if (action === 'curata' || action === 'uncurata') {
              const on = action === 'curata';
              const d = parseData(row);
              if (!!d.curata !== on) {
                d.curata = on;
                if (!on) delete d.curata;
                await env.DB.prepare(`UPDATE ${t.table} SET data=?, updated_at=datetime('now') WHERE slug=?`)
                  .bind(JSON.stringify(d), row.slug).run();
              }
            } else {
              // add-tag / remove-tag: tags are a comma-separated string kept
              // in both the indexed column and the data JSON.
              let d; try { d = foldLegacyCurata(JSON.parse(row.data)); } catch { failed.push(slug); continue; }
              const tags = String(d.tags || '').split(',').map(s => s.trim()).filter(Boolean);
              const has = tags.some(x => x.toLowerCase() === tag.toLowerCase());
              let next = tags;
              if (action === 'add-tag' && !has) next = tags.concat([tag]);
              if (action === 'remove-tag') next = tags.filter(x => x.toLowerCase() !== tag.toLowerCase());
              const joined = next.join(', ');
              if (joined !== String(d.tags || '')) {
                await saveRevision(env, sess, 'character', row);
                d.tags = joined;
                await env.DB.prepare(`UPDATE characters SET tags=?, data=?, updated_at=datetime('now') WHERE slug=?`)
                  .bind(joined || null, JSON.stringify(d), row.slug).run();
              }
            }
            done++;
          } catch { failed.push(slug); }
        }
        await logActivity(env, sess, 'bulk-' + action, type, null, done + ' page' + (done === 1 ? '' : 's'));
        return jsonResponse({ ok: true, done, failed, characters: claimed, charactersHeld: held });
      }

      return jsonResponse({ error: 'Unknown endpoint' }, { status: 404 });
    }

    // ---------- STATIC ASSETS (pass through to Pages) ----------
    // env.ASSETS is the static site binding (Cloudflare Pages / Workers Assets)
    return assetsOrNotFound(env, request);
  },

  // Nightly cron (see [triggers] in wrangler.toml): back up D1 to R2, and
  // prune page-view analytics older than 180 days.
  async scheduled(event, env, ctx) {
    // Backup first, retention after — pruning is worthless if the snapshot it
    // is trimming behind never got written.
    ctx.waitUntil((async () => {
      try {
        const res = await runBackup(env);
        if (res && !res.ok) {
          console.error('[cron] backup finished with failures:', JSON.stringify(res.failed));
        }
      } catch (e) {
        console.error('[cron] backup threw:', (e && e.message) || e);
      }

      // Retention. page_views(day) is indexed now, so this is a range delete
      // rather than the nightly full scan of the largest table it used to be.
      const prune = [
        ["DELETE FROM page_views WHERE day < date('now', '-180 day')", 'page_views'],
        // activity_log had no retention at all and grew forever, while
        // /api/admin/activity runs an unbounded COUNT(*) over it on every
        // load. A year is well past the point where an admin is still
        // investigating something.
        ["DELETE FROM activity_log WHERE ts < datetime('now', '-365 day')", 'activity_log'],
        // Contact-form messages that were dealt with long ago.
        ["DELETE FROM messages WHERE status='resolved' AND ts < datetime('now', '-180 day')", 'messages']
      ];
      for (const [sql, label] of prune) {
        try { await env.DB.prepare(sql).run(); }
        catch (e) { console.error(`[cron] prune ${label} failed:`, (e && e.message) || e); }
      }
    })());
  }
};
