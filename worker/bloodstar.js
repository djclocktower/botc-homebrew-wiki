/* bloodstar.js — reading a Bloodstar project into this wiki's shapes.
 *
 * Bloodstar (bloodstar.xyz) is where a lot of homebrew is actually written,
 * and a finished project publishes two files side by side:
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
   way to make the Worker knock on doors it was never meant to reach. */
import OfficialRoles from '../assets/official-roles.js';

export const BLOODSTAR_HOSTS = ['bloodstar.xyz', 'www.bloodstar.xyz'];

export function isBloodstarHost(host) {
  return BLOODSTAR_HOSTS.includes(String(host || '').toLowerCase());
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
  if (!isBloodstarHost(u.hostname)) {
    return { error: 'That is not a bloodstar.xyz link. This tool reads Bloodstar projects only.' };
  }
  // /p/{user}/{project}/[file]
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'p' || parts.length < 3) {
    return { error: 'That link is missing the project. It should look like https://www.bloodstar.xyz/p/Author/ProjectName/almanac.html' };
  }
  // The segments come out of URL parsing already percent-encoded, so they are
  // used as they are — encoding them again turned a project called "Some
  // Project" into "Some%2520Project" and 404'd every one with a space in it.
  const user = parts[1], project = parts[2];
  if ([user, project].some(seg => seg === '.' || seg === '..' || seg.includes('%2f') || seg.includes('%2F'))) {
    return { error: 'That link has something odd in the project path.' };
  }
  const base = 'https://' + u.hostname + '/p/' + user + '/' + project + '/';
  return {
    base, user, project,
    scriptUrl: base + 'script.json',
    almanacUrl: base + 'almanac.html'
  };
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
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code) : m;
    }
    const hit = ENTITIES[body.toLowerCase()];
    return hit === undefined ? m : hit;
  });
}

/* Drop everything a reader would never see, and everything that could carry
   markup of its own. Runs before any structural scan. */
function stripInert(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
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
    s = s.replace(/<\s*(b|strong)\b[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi, (m, t, inner) => wrapMark(inner, '**'));
    s = s.replace(/<\s*(i|em)\b[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi, (m, t, inner) => wrapMark(inner, '*'));
    s = s.replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (m, href, inner) => {
        const label = htmlToText(inner, 'plain').trim();
        const url = decodeEntities(href).trim();
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
  if (!text) return '';
  return mark + text + mark;
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
  const open = new RegExp('<div\\b[^>]*\\bclass\\s*=\\s*["\'][^"\']*\\b' + cls + '\\b[^"\']*["\'][^>]*>', 'i');
  const m = open.exec(html);
  if (!m) return '';
  const start = m.index + m[0].length;
  const tag = /<div\b[^>]*>|<\/div\s*>/gi;
  tag.lastIndex = start;
  let depth = 1, hit;
  while ((hit = tag.exec(html))) {
    if (hit[0][1] === '/') { depth--; if (!depth) return html.slice(start, hit.index); }
    else depth++;
  }
  return html.slice(start);
}

/* Every <div class="…{cls}…"> in `html`, in order. A character page can carry
   more than one tip, and each is its own div. */
function divBlocks(html, cls) {
  const out = [];
  let rest = html;
  for (let guard = 0; guard < 40; guard++) {
    const one = divBlock(rest, cls);
    if (!one) break;
    out.push(one);
    const at = rest.indexOf(one);
    rest = rest.slice(at + one.length);
  }
  return out;
}

function firstTag(html, tag, cls) {
  const attr = cls ? '[^>]*\\bclass\\s*=\\s*["\'][^"\']*\\b' + cls + '\\b[^"\']*["\']' : '';
  const re = new RegExp('<' + tag + '\\b' + attr + '[^>]*>([\\s\\S]*?)<\\/' + tag + '\\s*>', 'i');
  const m = re.exec(html);
  return m ? m[1] : '';
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

/* The project's own <style>, if it injected one: the background image is the
   only thing worth keeping, and it is offered as the page background rather
   than applied to anything automatically. */
function backgroundFromStyle(html) {
  const styles = String(html || '').match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || [];
  for (const block of styles) {
    const body = /body\s*\{([\s\S]*?)\}/i.exec(block);
    const scope = body ? body[1] : block;
    const url = /background(?:-image)?\s*:[^;{}]*url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(scope);
    if (url) {
      const src = decodeEntities(url[1]).trim();
      if (/^https?:\/\//i.test(src)) return src;
    }
  }
  return '';
}

/* One almanac page -> what it says. `id` decides how it is read: the four meta
   ids are prose pages, and everything else is a character or a jinx. */
function readAlmanacPage(page) {
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
    image: decodeEntities(img),
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
    const re = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bnightOrderListName\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
    const out = [];
    let m;
    while ((m = re.exec(block))) {
      const name = htmlToText(m[1], 'plain');
      if (name) out.push(name);
    }
    return out;
  };
  return { first: col('firstNightColumn'), other: col('otherNightColumn') };
}

/* almanac.html -> everything it holds, keyed by page id. */
export function parseAlmanac(html) {
  const source = String(html || '');
  // The background is read from the project's own <style> before anything is
  // stripped, because that block is the only place it exists. Everything after
  // this point works on a copy with the styles and scripts already gone: a
  // project can inject CSS into the first page, that CSS sits INSIDE the
  // page's own <div class="page-contents">, and a stray '</div>' in a
  // selector or a content: string would close a block the scan is counting.
  const background = backgroundFromStyle(source);
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
    const entry = readAlmanacPage(page);
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

  for (const row of rows) {
    if (typeof row === 'string') {
      // A bare id is an official character carried by reference. Nothing to
      // import, but the roster still wants it.
      const hit = officialByName.get(normKey(row)) ||
                  (official || []).find(r => normKey(r.id) === normKey(row));
      characters.push(bareOfficial(row, hit));
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    if (row.id === '_meta') {
      meta = {
        name: String(row.name || ''), author: String(row.author || ''),
        logo: String(row.logo || ''), almanac: String(row.almanac || ''),
        background: String(row.background || ''),
        bootlegger: Array.isArray(row.bootlegger) ? row.bootlegger.map(String) : [],
        hideTitle: !!row.hideTitle
      };
      continue;
    }
    const id = String(row.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const page = alm.entries[id] || matchAlmanacEntry(alm, row) || {};

    if (String(row.team || '').toLowerCase() === 'jinxes' || page.team === 'jinxes') {
      jinxes.push(readJinx(row, page));
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
      image: pickImage(row.image) || page.image || '',
      imageAlt: pickImage(row.image, 1),
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
      hasAlmanac: !!(page.overview || page.examples || page.howToRun || page.flavour)
    });
  }

  // An almanac page with no row in script.json: an author can leave a
  // character out of the export and still write its almanac entry. Nothing
  // can be published from prose alone, so it is reported rather than dropped
  // silently.
  for (const key of Object.keys(alm.entries)) {
    if (seen.has(key)) continue;
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

function readJinx(row, page) {
  const title = String(page.name || row.name || '');
  const parts = title.split(/\s*[\/\u2044]\s*/).map(s => s.trim()).filter(Boolean);
  return {
    id: String(row.id || page.id || ''),
    title,
    a: parts[0] || '',
    b: parts[1] || '',
    text: String(row.ability || page.ability || ''),
    overview: (page.overview || []).join('\n\n'),
    image: pickImage(row.image) || page.image || ''
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
