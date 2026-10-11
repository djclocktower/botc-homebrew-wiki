/* bloodstar.js — reading a Bloodstar project into this wiki's shapes.
 *
 * Bloodstar is where a lot of homebrew is actually written, and a finished
 * project publishes two files side by side:
 *
 *   .../p/{User}/{Project}/script.json    the official-schema script export
 *   .../p/{User}/{Project}/almanac.html   the almanac, as a generated page
 *
 * The JSON alone is what mass-upload.html already takes, and it carries the
 * mechanics — name, team, ability, art, reminders, night order. Everything a
 * reader actually comes to an almanac for (the flavour, the overview, the
 * examples, the how-to-run, the tips) is in the HTML and nowhere else, so
 * importing from the JSON alone throws away the half of the work that takes
 * the longest to write, and every imported page lands Partial.
 *
 * This module reads BOTH and hands back one normalized bundle. It is
 * Worker-only (worker/ is excluded from the asset upload) and deliberately
 * has no DOM: Workers have no DOMParser, and the almanac is machine-generated
 * from a fixed template, so a targeted scanner is both possible and more
 * predictable than a general HTML parse.
 *
 * What the generated almanac looks like, which is all this relies on:
 *
 *   <ol class="almanac-viewport">
 *     <li class="page" id="synopsis"><div class="page-contents"> … </div></li>
 *     <li class="page" id="overview"> …
 *     <li class="page" id="{characterId}">
 *       <div class="page-contents {team}">
 *         <img class="characterImage" …>
 *         <h2>Name</h2>
 *         <p class="ability">…</p><hr>
 *         <div class="flavor">“…”</div>
 *         <div class="overview"><p>…</p></div>
 *         <h3>Examples</h3><div class="example"><p>• …</p></div>
 *         <h3>How to Run</h3><div class="how-to-run"><p>…</p></div>
 *         <div class="tip"><p>…</p></div>
 *         <p class="team">Townsfolk</p>
 *     <li class="page" id="nightOrder"> …
 *
 * Jinx entries are pages like any other, with team "jinxes" and a name of the
 * form "A / B"; they appear in script.json too, with the same team, which is
 * how they are told apart from characters without reading the HTML at all.
 *
 * A project may inject its own <style> (and its own fonts and background) into
 * the first page. That is stripped before anything is read, and the background
 * URL is kept separately as a hint the importer may offer to bring across.
 */

/* Bloodstar is the only host this module will read from. It is also the only
   host worker.js will copy art from, and that is on purpose: the URL comes
   from whoever is using the tool, and an unrestricted server-side fetch is a
   way to make the Worker knock on doors it was never meant to reach.

   It is two hosts because Bloodstar itself is two: the reworked tool is
   published at bloodstar.clocktica.com and the original is still up at
   bloodstar.xyz, with years of projects on it that people are still linking
   to. Nothing else about a project differs — same /p/{User}/{Project}/
   layout, same script.json, same generated almanac — so the host is the
   whole of the difference, and both are read. */
import OfficialRoles from '../assets/official-roles.js';

/* An accepted host -> the spelling of it that actually answers. Both are
   taken because people paste both, and NEITHER site answers on both: only
   www.bloodstar.xyz has an address on the old side and only the bare
   bloodstar.clocktica.com on the new one. A link is moved onto the spelling
   that serves before anything is fetched, or half the links pasted here come
   back as "Bloodstar may be down" when Bloodstar is perfectly well. */
const BLOODSTAR_HOST_CANON = {
  'bloodstar.clocktica.com': 'bloodstar.clocktica.com',
  'www.bloodstar.clocktica.com': 'bloodstar.clocktica.com',
  'bloodstar.xyz': 'www.bloodstar.xyz',
  'www.bloodstar.xyz': 'www.bloodstar.xyz'
};

export const BLOODSTAR_HOSTS = Object.keys(BLOODSTAR_HOST_CANON);

/* Own properties only. A bare index into the object answered 'constructor'
   and '__proto__' with Object's own members — truthy — so a hostname of
   either passed the pin. */
export function isBloodstarHost(host) {
  return !!bloodstarHost(host);
}

/* The host to actually ask, or '' for anywhere that is not Bloodstar. */
export function bloodstarHost(host) {
  const key = String(host || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(BLOODSTAR_HOST_CANON, key) ? BLOODSTAR_HOST_CANON[key] : '';
}

/* Whatever the person pasted -> the two URLs we actually need.
   Accepts the almanac, the script.json, the folder, or the bare path, with or
   without a scheme, because all four are things people copy out of a browser
   bar or a Discord message. */
export function bloodstarSource(input) {
  let raw = String(input || '').trim();
  if (!raw) return { error: 'Paste a Bloodstar link first.' };
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw.replace(/^\/+/, '');
  let u;
  try { u = new URL(raw); } catch { return { error: 'That does not look like a link.' }; }
  const host = bloodstarHost(u.hostname);
  if (!host) {
    return { error: 'That is not a Bloodstar link. Use a link from bloodstar.clocktica.com or bloodstar.xyz.' };
  }
  // /p/{user}/{project}/[file]
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'p' || parts.length < 3) {
    return { error: 'That link is missing the project. It should look like https://bloodstar.clocktica.com/p/Author/ProjectName/almanac.html' };
  }
  // The segments come out of URL parsing already percent-encoded, so they are
  // used as they are — encoding them again turned a project called "Some
  // Project" into "Some%2520Project" and 404'd every one with a space in it.
  const user = parts[1], project = parts[2];
  // /p/User/almanac.html has a file where the project belongs, and would
  // otherwise be read as a project called "almanac.html".
  if (/\.(html?|json)$/i.test(project)) {
    return { error: 'That link is missing the project. It should look like https://bloodstar.clocktica.com/p/Author/ProjectName/almanac.html' };
  }
  if ([user, project].some(seg => seg === '.' || seg === '..' || seg.includes('%2f') || seg.includes('%2F'))) {
    return { error: 'That link has something odd in the project path.' };
  }
  const base = 'https://' + host + '/p/' + user + '/' + project + '/';
  return {
    base, user, project,
    scriptUrl: base + 'script.json',
    almanacUrl: base + 'almanac.html'
  };
}

/* Fetch from Bloodstar and nowhere else. `redirect: 'follow'` let whatever
   answered send the Worker on to any address it liked, which is the one thing
   the host pin exists to prevent, so redirects are followed by hand: a few
   hops at most, and every hop has to land back on a Bloodstar host (moved
   onto the spelling that serves, exactly as a pasted link is), over https,
   with no port or credentials. Resolves with the final Response; throws when
   a hop leaves Bloodstar or there are too many of them. */
const MAX_REDIRECTS = 3;
// The most of script.json or almanac.html that is ever read. A generated
// almanac for a 40-character script is ~180 KB; a file past this is not one.
export const BLOODSTAR_FILE_MAX = 4 * 1024 * 1024;
export async function fetchBloodstar(url, init) {
  let u = new URL(String(url));
  for (let hop = 0; ; hop++) {
    const host = bloodstarHost(u.hostname);
    if (!host || (u.protocol !== 'https:' && u.protocol !== 'http:')) throw new Error('That address is not on Bloodstar.');
    u.protocol = 'https:'; u.hostname = host; u.port = ''; u.username = ''; u.password = '';
    const res = await fetch(u.toString(), { ...(init || {}), redirect: 'manual' });
    const next = res.status >= 300 && res.status < 400 && res.headers.get('Location');
    if (!next) return res;
    try { if (res.body) await res.body.cancel(); } catch { /* nothing to free */ }
    if (hop >= MAX_REDIRECTS) throw new Error('Bloodstar redirected too many times.');
    u = new URL(next, u);
  }
}

/* A response body, never more than `max` bytes of it. Content-Length is only
   a promise and is often absent, so the body is read as a stream and given up
   on the moment it passes the cap, rather than read whole and measured after.
   Resolves with the bytes, or null when the body is too large. */
export async function readCapped(res, max) {
  if ((parseInt(res.headers.get('Content-Length'), 10) || 0) > max) {
    try { if (res.body) await res.body.cancel(); } catch { /* nothing to free */ }
    return null;
  }
  if (!res.body) {
    const whole = new Uint8Array(await res.arrayBuffer());
    return whole.length > max ? null : whole;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch { /* nothing to free */ }
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/* ---------------------------------------------------------------- *
 * HTML -> text
 * ---------------------------------------------------------------- */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', rsquo: '\u2019',
  lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022',
  times: '\u00d7', deg: '\u00b0', frac12: '\u00bd', trade: '\u2122'
};

export function decodeEntities(s) {
  // Decimal digits only after a bare '#': '&#12ab;' is not an entity, and
  // reading it as one decoded the 12 and threw the rest away.
  return String(s || '').replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code) : m;
    }
    const name = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : m;
  });
}

/* A '<' that never reaches a '>' before the next '<' is text, not a tag.
   Escaping it first is what keeps every `<tag[^>]*>` below bounded by the tag
   it is reading: left alone, a page of '<b <b <b …' with no '>' sent each one
   scanning to the end of the file, which is quadratic in the page. */
function escapeStrayLt(html) {
  return String(html || '').replace(/<(?=[^<>]*(?:<|$))/g, '&lt;');
}

/* Every <open>…<close> pair, found the way a lazy `<open>([\s\S]*?)<close>`
   regex finds them, but in one pass. That regex re-scans to the end of the
   file from EVERY opener that has no closer, so a page of unclosed tags cost
   quadratic time. Here a closer that is missing after one opener is known to
   be missing after every later one of the same kind (the search only moves
   forward), so it is looked for once. `close(m)` gives the closer's pattern
   for an opener; visit(m, innerStart, innerEnd, end) sees each pair. */
function scanPairs(html, open, close, visit) {
  const closers = new Map(), missing = new Set();
  open.lastIndex = 0;
  let m;
  while ((m = open.exec(html))) {
    const src = close(m);
    if (missing.has(src)) continue;
    let c = closers.get(src);
    if (!c) { c = new RegExp(src, 'gi'); closers.set(src, c); }
    c.lastIndex = open.lastIndex;
    const e = c.exec(html);
    if (!e) { missing.add(src); continue; }
    if (visit(m, open.lastIndex, e.index, e.index + e[0].length) === false) return;
    open.lastIndex = e.index + e[0].length;
  }
}

function replacePairs(html, open, close, fn) {
  let out = '', pos = 0;
  scanPairs(html, open, close, (m, a, b, end) => {
    out += html.slice(pos, m.index) + fn(m, html.slice(a, b));
    pos = end;
  });
  return out + html.slice(pos);
}

/* Drop everything a reader would never see, and everything that could carry
   markup of its own. Runs before any structural scan. */
function stripInert(html) {
  // Comments go first: a '<' inside one is not a tag either, and escaping it
  // would break the comment open rather than strip it.
  let s = replacePairs(String(html || ''), /<!--/g, () => '-->', () => '');
  s = escapeStrayLt(s);
  s = replacePairs(s, /<script\b[^>]*>/gi, () => '<\\/script>', () => '');
  return replacePairs(s, /<style\b[^>]*>/gi, () => '<\\/style>', () => '');
}

/* One HTML fragment -> one string.
 *
 * `mode` is 'plain' or 'wiki', and the difference matters: most character
 * fields (examples, how-to-run, tips, the flavour line) are printed ESCAPED by
 * render.js, so `*emphasis*` in one of those would show its asterisks. Only a
 * /p/ wiki page, a custom box and jinx rule text go through render-wiki.js and
 * can carry marks. So the same almanac paragraph converts one way for a
 * character page and another for a wiki page.
 */
export function htmlToText(html, mode) {
  const wiki = mode === 'wiki';
  let s = stripInert(html);
  // Bloodstar's editor writes <em> for the parenthetical asides that run
  // through almanac prose, and <strong> for the odd emphasised term.
  if (wiki) {
    const closeSame = m => '<\\/\\s*' + m[1] + '\\s*>';
    s = replacePairs(s, /<\s*(b|strong)\b[^>]*>/gi, closeSame, (m, inner) => wrapMark(inner, '**'));
    s = replacePairs(s, /<\s*(i|em)\b[^>]*>/gi, closeSame, (m, inner) => wrapMark(inner, '*'));
    s = replacePairs(s, /<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>/gi, () => '<\\/a>',
      (m, inner) => {
        const label = htmlToText(inner, 'plain').trim();
        // A ')' would end the link early, and a '(' or a space can stop the
        // wiki reading it as one at all; percent-encoded, the address is the
        // same address.
        const url = decodeEntities(m[1]).trim().replace(/[()\s]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
        return (label && url && /^(https?:|mailto:|\/)/i.test(url)) ? '[' + label + '](' + url + ')' : label;
      });
  }
  // An image that OPENS a block is standing in for words — the almanac's
  // overview page starts with the script logo where its name belongs ("<logo>
  // is a late 1800s frontier script"), and dropping it leaves a sentence with
  // no subject. Its alt text is that name. An image anywhere else is
  // illustration inside a sentence (a QR code, a reference sheet) and its alt
  // would read as an interruption, so those go.
  s = s.replace(/^(\s*(?:<\s*(?:p|div|li|h[1-6])\b[^>]*>\s*)?)<img\b([^>]*)>/i, (m, lead, attrs) => {
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(attrs);
    return lead + (alt && alt[1].trim() ? decodeEntities(alt[1]).trim() + ' ' : '');
  });
  s = s
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    // Cells on one row are separate words, not one run-together one.
    .replace(/<\s*\/\s*t[dh]\s*>/gi, ' ')
    .replace(/<\s*li\b[^>]*>/gi, wiki ? '\n- ' : '\n\u2022 ')
    .replace(/<\s*(p|div|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(line => line.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* `**bold**` only works when the marks sit against the words. Emphasis that
   starts or ends on a space (Bloodstar writes "<em> (like this) </em>" often
   enough) has to keep the space OUTSIDE the marks or the mark never fires. */
function wrapMark(inner, mark) {
  const text = htmlToText(inner, 'wiki');
  // htmlToText trims, so the edge spaces are read off the raw HTML and put
  // back outside the marks ("wakes.<em> (aside) </em>Then" keeps both).
  const lead = /^(?:\s|&nbsp;|&#160;)/i.test(inner) ? ' ' : '';
  const trail = /(?:\s|&nbsp;|&#160;)$/i.test(inner) ? ' ' : '';
  if (!text) return lead || trail;
  return lead + mark + text + mark + trail;
}

/* A block of prose -> one line per paragraph. Used for every list field on a
   character page (examples, how-to-run, tips, summary bullets). */
export function htmlToLines(html, mode) {
  const text = htmlToText(html, mode);
  if (!text) return [];
  return text.split(/\n+/)
    // Bloodstar's example blocks open each entry with a bullet character; the
    // wiki draws its own, so a kept one shows up doubled.
    .map(l => l.replace(/^[\u2022\u00b7*\-\u2013\u2014]\s*/, '').trim())
    .filter(Boolean);
}

/* Prose meant for a script or collection page (synopsis, gameplay): those go
   through render-page.js's prose(), which splits on blank lines and escapes
   the rest, so paragraphs are separated by one blank line. */
export function htmlToProse(html, mode) {
  const text = htmlToText(html, mode);
  return text ? text.split(/\n+/).map(l => l.trim()).filter(Boolean).join('\n\n') : '';
}

/* ---------------------------------------------------------------- *
 * scanning the generated almanac
 * ---------------------------------------------------------------- */

/* The inner HTML of the first <div class="…{cls}…"> in `html`, found by
   counting <div>s rather than by a lazy regex — an almanac's overview can
   itself hold a div, and `[\s\S]*?</div>` would stop at the wrong one. */
function divBlock(html, cls) {
  const one = divSpan(html, cls, 0);
  return one ? html.slice(one.start, one.end) : '';
}

/* Where the next <div class="…{cls}…"> at or after `from` opens and closes:
   {start, end} of its inner HTML and `next`, the index just past it. */
function divSpan(html, cls, from) {
  const open = new RegExp('<div\\b[^>]*\\bclass\\s*=\\s*["\'][^"\']*\\b' + cls + '\\b[^"\']*["\'][^>]*>', 'gi');
  open.lastIndex = from;
  const m = open.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  const tag = /<div\b[^>]*>|<\/div\s*>/gi;
  tag.lastIndex = start;
  let depth = 1, hit;
  while ((hit = tag.exec(html))) {
    if (hit[0][1] === '/') { depth--; if (!depth) return { start, end: hit.index, next: hit.index + hit[0].length }; }
    else depth++;
  }
  return { start, end: html.length, next: html.length };
}

/* Every <div class="…{cls}…"> in `html`, in order. A character page can carry
   more than one tip, and each is its own div. Walked by position: an empty
   block used to end the walk (so every tip after it was lost), and finding
   the next one by searching for the text of the last could land on an
   earlier block with the same words. */
function divBlocks(html, cls) {
  const out = [];
  let from = 0;
  for (let guard = 0; guard < 40; guard++) {
    const one = divSpan(html, cls, from);
    if (!one) break;
    if (one.end > one.start) out.push(html.slice(one.start, one.end));
    from = one.next;
  }
  return out;
}

/* The inner HTML of the first <{tag} class="…{cls}…">…</{tag}>. A closer that
   is not there after the first opener is not there after any later one, so
   there is nothing further to try (see scanPairs). */
function firstTag(html, tag, cls) {
  const attr = cls ? '[^>]*\\bclass\\s*=\\s*["\'][^"\']*\\b' + cls + '\\b[^"\']*["\']' : '';
  let found = '';
  scanPairs(html, new RegExp('<' + tag + '\\b' + attr + '[^>]*>', 'gi'), () => '<\\/' + tag + '\\s*>',
    (m, a, b) => { found = html.slice(a, b); return false; });
  return found;
}

/* The <li class="page" id="…"> blocks, in document order. */
function almanacPages(html) {
  const re = /<li\b[^>]*\bclass\s*=\s*["'][^"']*\bpage\b[^"']*["'][^>]*\bid\s*=\s*["']([^"']*)["'][^>]*>/gi;
  const marks = [];
  let m;
  while ((m = re.exec(html))) marks.push({ id: decodeEntities(m[1]), start: m.index + m[0].length });
  return marks.map((mark, i) => ({
    id: mark.id,
    html: html.slice(mark.start, i + 1 < marks.length ? marks[i + 1].start : html.length)
  }));
}

const META_PAGE_IDS = new Set(['synopsis', 'overview', 'changelog', 'nightorder']);

/* An address written in the almanac -> one the importer can actually fetch.
   The generated page links its own images root-relative
   ('/p/User/Project/witch.png'), which is a path and not a place: the tool
   copies art BY URL, and a path with no host in front of it copies nothing —
   on the wiki's side it would name the wiki's own missing file. So everything
   read out of the HTML is resolved against the project's own URL first.
   Anything that is not http(s) after that is dropped rather than carried:
   these strings end up in an <img src> on somebody's character page. */
function absoluteUrl(src, base) {
  const raw = decodeEntities(String(src || '')).trim();
  if (!raw) return '';
  let u;
  try { u = base ? new URL(raw, base) : new URL(raw); } catch { return ''; }
  return (u.protocol === 'https:' || u.protocol === 'http:') ? u.toString() : '';
}

/* The project's own <style>, if it injected one: the background image is the
   only thing worth keeping, and it is offered as the page background rather
   than applied to anything automatically. */
function backgroundFromStyle(html, base) {
  const styles = [];
  scanPairs(String(html || ''), /<style\b[^>]*>/gi, () => '<\\/style>', (m, a, b) => { styles.push(html.slice(a, b)); });
  for (const block of styles) {
    const body = /body\s*\{([\s\S]*?)\}/i.exec(block);
    const scope = body ? body[1] : block;
    const url = /background(?:-image)?\s*:[^;{}]*url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(scope);
    if (url) {
      const src = absoluteUrl(url[1], base);
      if (src) return src;
    }
  }
  return '';
}

/* One almanac page -> what it says. `id` decides how it is read: the four meta
   ids are prose pages, and everything else is a character or a jinx. */
function readAlmanacPage(page, base) {
  const html = page.html;
  const contents = divBlock(html, 'page-contents') || html;
  const teamClass = (/<div\b[^>]*\bclass\s*=\s*["']([^"']*\bpage-contents\b[^"']*)["']/i.exec(html) || [])[1] || '';
  const team = teamClass.replace(/\bpage-contents\b/, '').trim().split(/\s+/)[0] || '';
  const img = (/<img\b[^>]*\bclass\s*=\s*["'][^"']*\bcharacterImage\b[^"']*["'][^>]*\bsrc\s*=\s*["']([^"']*)["']/i.exec(html) ||
               /<img\b[^>]*\bsrc\s*=\s*["']([^"']*)["'][^>]*\bclass\s*=\s*["'][^"']*\bcharacterImage\b/i.exec(html) || [])[1] || '';

  // The flavour line is quoted by the template; the wiki adds its own quotes.
  const flavourRaw = htmlToText(divBlock(contents, 'flavor'), 'plain');
  const flavour = flavourRaw.replace(/^["'\u201c\u2018]+/, '').replace(/["'\u201d\u2019]+$/, '').trim();

  return {
    id: page.id,
    team,
    name: htmlToText(firstTag(contents, 'h2'), 'plain'),
    ability: htmlToText(firstTag(contents, 'p', 'ability'), 'plain'),
    image: absoluteUrl(img, base),
    flavour,
    overview: htmlToLines(divBlock(contents, 'overview'), 'plain'),
    overviewWiki: htmlToProse(divBlock(contents, 'overview'), 'wiki'),
    examples: divBlocks(contents, 'example').flatMap(b => htmlToLines(b, 'plain')),
    howToRun: divBlocks(contents, 'how-to-run').flatMap(b => htmlToLines(b, 'plain')),
    tips: divBlocks(contents, 'tip').flatMap(b => htmlToLines(b, 'plain'))
  };
}

/* The two night lists on the generated Night Order page, as names. Bloodstar
   prints them as an icon plus a .nightOrderListName per entry, in order. */
function readNightOrder(html) {
  const col = cls => {
    // "otherNightsColumn" is plural in the generated page and "firstNightColumn"
    // is not; both spellings are accepted rather than depending on that.
    const block = divBlock(html, cls) || divBlock(html, cls.replace('Column', 'sColumn'));
    if (!block) return [];
    const re = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bnightOrderListName\b[^"']*["'][^>]*>/gi;
    const out = [];
    scanPairs(block, re, () => '<\\/div>', (m, a, b) => {
      const name = htmlToText(block.slice(a, b), 'plain');
      if (name) out.push(name);
    });
    return out;
  };
  return { first: col('firstNightColumn'), other: col('otherNightColumn') };
}

/* almanac.html -> everything it holds, keyed by page id. `base` is the
   project's own folder URL (bloodstarSource().base), used to resolve the
   addresses the page writes relative to itself. */
export function parseAlmanac(html, base) {
  const source = escapeStrayLt(html);
  // The background is read from the project's own <style> before anything is
  // stripped, because that block is the only place it exists. Everything after
  // this point works on a copy with the styles and scripts already gone: a
  // project can inject CSS into the first page, that CSS sits INSIDE the
  // page's own <div class="page-contents">, and a stray '</div>' in a
  // selector or a content: string would close a block the scan is counting.
  const background = backgroundFromStyle(source, base);
  const viewport = stripInert(source.slice(Math.max(0, source.indexOf('almanac-viewport'))));
  const out = {
    background: background,
    prose: {},          // synopsis / overview / changelog, as {plain, wiki}
    entries: {},        // page id -> the almanac half of a character or jinx
    extras: [],         // pages the template does not know about
    nightOrder: { first: [], other: [] }
  };
  for (const page of almanacPages(viewport)) {
    const key = page.id.toLowerCase();
    if (key === 'nightorder') { out.nightOrder = readNightOrder(page.html); continue; }
    if (META_PAGE_IDS.has(key)) {
      const contents = divBlock(page.html, 'page-contents') || page.html;
      // The prose pages carry an <h2> title and, on the synopsis, the script
      // logo — neither belongs in the text.
      const body = contents.replace(/<h2\b[^>]*>[\s\S]*?<\/h2>/i, '').replace(/<hr\s*\/?>/gi, '');
      out.prose[key] = {
        title: htmlToText(firstTag(contents, 'h2'), 'plain') || key,
        plain: htmlToProse(body, 'plain'),
        wiki: htmlToProse(body, 'wiki')
      };
      continue;
    }
    const entry = readAlmanacPage(page, base);
    if (!entry.name) continue;
    out.entries[page.id] = entry;
    if (!/^(townsfolk|outsider|minion|demon|traveller|traveler|fabled|loric|jinxes)$/i.test(entry.team)) {
      out.extras.push(entry);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- *
 * merging with script.json
 * ---------------------------------------------------------------- */

export function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const TEAM_ALIAS = {
  townsfolk: 'townsfolk', outsider: 'outsider', minion: 'minion', demon: 'demon',
  traveller: 'traveller', traveler: 'traveller', fabled: 'fabled', loric: 'loric'
};
function normTeam(t) {
  return TEAM_ALIAS[String(t || '').toLowerCase().trim()] || '';
}

/* "The Chambermaid was created by The Pandemonium Institute." — Bloodstar
   writes this into `attribution` when an author drops an official character
   into their script. It is a strong hint and never a proof: an author can
   rename one (this script's Agent is the Spy), and the credit still names the
   character it came FROM, which is not the character on the page. */
function looksOfficialCredit(attribution) {
  return /pandemonium\s+institute|\bTPI\b/i.test(String(attribution || ''));
}

/* Two lists side by side -> one list of characters, each carrying both halves.
 *
 * `official` is the official roster (roles.json as the wiki already loads it),
 * used only to work out which entries are official characters riding along in
 * somebody's script. That question is graded rather than answered yes/no:
 *   'exact'  the name AND the ability match a real official character. The
 *            script is carrying the official character; the roster can point
 *            straight at it and no page needs making.
 *   'named'  the name matches but the ability does not. It is a REWORKED
 *            official character, which is a different character with a
 *            familiar name, so the default is to make a page for it.
 *   'credit' only the attribution says so — usually a rename (Agent/Spy).
 *   ''       homebrew.
 */
export function buildBundle(scriptJson, almanac, source, official) {
  const rows = Array.isArray(scriptJson) ? scriptJson : [];
  const alm = almanac || { prose: {}, entries: {}, extras: [], nightOrder: { first: [], other: [] } };
  const warnings = [];

  const officialByName = new Map();
  for (const r of (official || [])) {
    if (r && r.name) officialByName.set(normKey(r.name), r);
  }

  let meta = { name: '', author: '', logo: '', almanac: '' };
  const characters = [];
  const jinxes = [];
  const seen = new Set();
  // Almanac page ids some row already speaks for. Kept apart from `seen`,
  // which de-duplicates ROWS: a page matched by name must not make a later
  // row whose id happens to be that page's id look like a repeat.
  const accounted = new Set();
  // The project's own folder: script.json may name its images relative to
  // itself, exactly as the almanac does, and they get the same treatment
  // (absoluteUrl) — resolved, and dropped unless they come out http(s).
  const base = (source && source.base) || '';
  const img = (image, i) => absoluteUrl(pickImage(image, i), base);

  for (const row of rows) {
    if (typeof row === 'string') {
      // A bare id is an official character carried by reference. Nothing to
      // import, but the roster still wants it.
      const hit = officialByName.get(normKey(row)) ||
                  (official || []).find(r => normKey(r.id) === normKey(row));
      characters.push(bareOfficial(row, hit));
      // Its almanac page (if the author wrote one) is accounted for: without
      // this every official character carried by id was reported as "has an
      // almanac page but is not in script.json".
      accounted.add(row);
      if (hit && hit.id) accounted.add(hit.id);
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    if (row.id === '_meta') {
      meta = {
        name: String(row.name || ''), author: String(row.author || ''),
        logo: absoluteUrl(row.logo, base), almanac: String(row.almanac || ''),
        background: absoluteUrl(row.background, base),
        bootlegger: Array.isArray(row.bootlegger) ? row.bootlegger.map(String) : [],
        hideTitle: !!row.hideTitle
      };
      continue;
    }
    const id = String(row.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const page = alm.entries[id] || matchAlmanacEntry(alm, row) || {};
    // Matched by name under another id: that page is this row's, not a
    // character left out of script.json.
    if (page.id) accounted.add(page.id);

    if (String(row.team || '').toLowerCase() === 'jinxes' || page.team === 'jinxes') {
      jinxes.push(readJinx(row, page, base));
      continue;
    }
    const team = normTeam(row.team) || normTeam(page.team);
    if (!team) warnings.push('“' + (row.name || id) + '” has no team the wiki recognises; it was filed as Townsfolk.');

    // One test, shared with the character editors, /api/character's guard and
    // the admin sweep — see officialMatch() in assets/official-roles.js. It
    // reads '&' and 'and' as the same word, which a plain punctuation strip
    // does not: the official Dreamer came through here as homebrew because
    // "1 good & 1 evil" and "1 good and 1 evil" did not compare equal.
    const graded = OfficialRoles.officialMatch(official || [], row);
    const off = graded ? graded.role : null;
    let match = graded ? graded.match : '';
    if (!match && looksOfficialCredit(row.attribution)) match = 'credit';

    characters.push({
      id,
      name: String(row.name || page.name || id),
      team: team || 'townsfolk',
      ability: String(row.ability || page.ability || ''),
      image: img(row.image) || page.image || '',
      imageAlt: img(row.image, 1),
      // A traveller's third icon: [unaligned, good, evil] in the official
      // schema, so this is its evil token (see "A character's three icons").
      imageAlt2: img(row.image, 2),
      flavour: String(row.flavor || page.flavour || ''),
      overview: page.overview || [],
      overviewWiki: page.overviewWiki || '',
      examples: page.examples || [],
      howToRun: page.howToRun || [],
      tips: page.tips || [],
      attribution: String(row.attribution || ''),
      edition: String(row.edition || ''),
      firstNight: Number(row.firstNight) || 0,
      otherNight: Number(row.otherNight) || 0,
      firstNightReminder: cleanNightReminder(row.firstNightReminder),
      otherNightReminder: cleanNightReminder(row.otherNightReminder),
      reminders: strList(row.reminders),
      remindersGlobal: strList(row.remindersGlobal),
      setup: !!row.setup,
      special: Array.isArray(row.special) ? row.special : [],
      official: match ? { id: off ? off.id : '', slug: off ? off.slug : '', match } : null,
      // Lengths, not the arrays: an empty almanac page parses to [] for each
      // list, and [] is truthy, so every matched page used to read "yes".
      hasAlmanac: !!((page.overview || []).length || (page.examples || []).length ||
        (page.howToRun || []).length || (page.tips || []).length || page.flavour)
    });
  }

  // An almanac page with no row in script.json: an author can leave a
  // character out of the export and still write its almanac entry. Nothing
  // can be published from prose alone, so it is reported rather than dropped
  // silently.
  for (const key of Object.keys(alm.entries)) {
    if (seen.has(key) || accounted.has(key)) continue;
    const e = alm.entries[key];
    if (e.team === 'jinxes') { if (!jinxes.some(j => j.id === key)) jinxes.push(readJinx({ id: key }, e)); continue; }
    warnings.push('“' + e.name + '” has an almanac page but is not in script.json, so it was left out.');
  }

  return {
    source: source || {},
    meta,
    background: alm.background || meta.background || '',
    prose: alm.prose || {},
    nightOrderNames: alm.nightOrder || { first: [], other: [] },
    characters,
    jinxes,
    warnings
  };
}

function bareOfficial(id, hit) {
  return {
    id: String(id), name: hit ? hit.name : String(id), team: hit ? hit.team : '',
    ability: hit ? hit.ability : '', image: '', flavour: '',
    overview: [], examples: [], howToRun: [], tips: [],
    reminders: [], remindersGlobal: [], special: [],
    firstNight: hit ? hit.firstNight : 0, otherNight: hit ? hit.otherNight : 0,
    firstNightReminder: '', otherNightReminder: '', setup: false,
    attribution: '', edition: '', bare: true, hasAlmanac: false,
    official: { id: hit ? hit.id : String(id), slug: hit ? hit.slug : '', match: 'exact' }
  };
}

function readJinx(row, page, base) {
  const title = String(page.name || row.name || '');
  const parts = title.split(/\s*[\/\u2044]\s*/).map(s => s.trim()).filter(Boolean);
  return {
    id: String(row.id || page.id || ''),
    title,
    a: parts[0] || '',
    b: parts[1] || '',
    text: String(row.ability || page.ability || ''),
    overview: (page.overview || []).join('\n\n'),
    image: absoluteUrl(pickImage(row.image), base) || page.image || ''
  };
}

/* An almanac page whose id does not match the script row's — rare, but a
   project renamed mid-writing can end up that way. Fall back to the name. */
function matchAlmanacEntry(alm, row) {
  const want = normKey(row.name);
  if (!want) return null;
  for (const key of Object.keys(alm.entries)) {
    if (normKey(alm.entries[key].name) === want) return alm.entries[key];
  }
  return null;
}

function pickImage(image, index) {
  const i = index || 0;
  if (Array.isArray(image)) return typeof image[i] === 'string' ? image[i] : '';
  return i === 0 && typeof image === 'string' ? image : '';
}

function strList(v) {
  return Array.isArray(v) ? v.map(x => String(x)).filter(Boolean) : [];
}

/* Bloodstar lets an author put anything in the night reminder, and some use it
   for a note to themselves ("THIS IS NOT THE SCRIPT. The script is linked
   here: …" runs through every character of the sample project). A reminder
   that is a bare link, or an all-caps notice carrying one, is not a night
   instruction and would print on 40 wiki pages as if it were. */
function cleanNightReminder(s) {
  const text = String(s || '').trim();
  if (!text) return '';
  if (/https?:\/\//i.test(text) && /THIS IS NOT|^\s*https?:\/\//i.test(text)) return '';
  return text;
}
