#!/usr/bin/env node
/*
 * Scrape The Menagerie (sites.google.com/view/botcmenagerie, by Goodpart)
 * into this wiki's import archives. Run with the wiki owner's permission and
 * Goodpart's own — every word in the output comes from the site or its JSON
 * files; nothing is written by the scraper.
 *
 *   node migration/menagerie-scrape.js
 *
 * Produces, next to this file:
 *   menagerie-import.json          83 characters: master-JSON mechanics merged
 *                                  with each almanac page's prose (lede,
 *                                  howToRun, tips, bluffing/fighting, examples)
 *   menagerie-scripts-import.json  the published scripts with their verbatim
 *                                  Scripts-page descriptions and _meta
 *   menagerie-review.txt           a human-readable dump for eyeballing
 *
 * Fetches go through curl so the environment's proxy applies.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SITE = 'https://sites.google.com/view/botcmenagerie';
const MASTER = 'https://menagerie.towerrangers.net/repo/The%20Menagerie%201.17.json';

function fetchText(url) {
  return execFileSync('curl', ['-sSL', '--max-time', '60', url], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
}

function decode(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function textOf(html) {
  return decode(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

// Content blocks on a published Google Site are <p>/<h*> with class zfr3Q.
// Everything, headings included, is a <p>; headings are told apart by their
// text. A block is "bold" when every styled span in it is font-weight 700 —
// that is how the one-line summary (the lede) is marked.
function blocks(html) {
  const out = [];
  const re = /<(p|h[1-6])\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (!/zfr3Q/.test(m[2])) continue;
    const inner = m[3];
    const text = textOf(inner);
    if (!text) continue;
    const spans = [...inner.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)]
      .filter(s => textOf(s[2]));
    const bold = spans.length > 0 &&
      spans.every(s => /font-weight:\s*700/.test(s[1]));
    out.push({ text, bold, inner });
  }
  return out;
}

// ---- master JSON ----
const master = JSON.parse(fetchText(MASTER));
const meta = master.find(e => e.id === '_meta');
const chars = master.filter(e => e.id !== '_meta');
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const byNorm = new Map(chars.map(c => [norm(c.id), c]));
for (const c of chars) byNorm.set(norm(c.name), c);

// ---- find every character page URL (the nav on any page lists them all) ----
const navHtml = fetchText(SITE + '/characters/townsfolk/astrologer');
const urls = [...new Set(
  [...navHtml.matchAll(/\/view\/botcmenagerie\/characters\/[a-z-]+\/[a-z0-9-]+/g)]
    .map(m => m[0])
)];
console.log('character pages found in nav:', urls.length);

// ---- parse one character page ----
function parsePage(html, jsonChar) {
  const bl = blocks(html);
  const out = { howToRun: [], tips: [], bluffing: [], fighting: [], examples: [], credit: '' };
  let mode = 'pre';        // pre | ability | how | tips | bluffing | fighting | jinx
  let exampleOf = '';      // section an Example belongs to
  const howBuf = [];       // paragraphs between STORYTELLER NOTES and Playing as
  for (const b of bl) {
    const t = b.text;
    if (/^©\s*\d{4}/.test(t)) break;
    if (/^ability:?$/i.test(t)) { mode = 'ability'; continue; }
    if (/^storyteller notes:?$/i.test(t)) { mode = 'how'; continue; }
    // Townsfolk pages say "Playing as the X"; Fabled and Loric pages say
    // "Playing with the X".
    if (/^playing (as|with) (the )?/i.test(t) && t.length < 60) { mode = 'tips'; continue; }
    if (/^bluffing as (the )?/i.test(t) && t.length < 60) { mode = 'bluffing'; continue; }
    if (/^fighting (the )?/i.test(t) && t.length < 60) { mode = 'fighting'; continue; }
    if (/^examples?:?$/i.test(t)) { exampleOf = mode; mode = 'example'; continue; }
    if (/^jinxes:?$/i.test(t)) { mode = 'jinx'; continue; }
    if (mode === 'pre') {
      // The credit rides inside the flavour block: "…cosmos? (Additional
      // credit: Vyvvyx)". The flavour itself is already in the JSON.
      const cm = t.match(/\(additional credit:?\s*([^)]+)\)/i);
      if (cm) out.credit = 'Additional credit: ' + cm[1].trim();
      continue; // title, flavour, nav remnants
    }
    if (mode === 'ability') continue;          // verbatim in the JSON already
    if (mode === 'jinx') continue;             // jinx rules come from the JSON
    if (mode === 'how') { howBuf.push(b); continue; }
    if (mode === 'example') { out.examples.push(t); continue; }
    out[mode === 'tips' ? 'tips' : mode].push(t);
  }
  // The bold standalone summary between Storyteller Notes and Playing-as is
  // the lede; the paragraphs before it are the how-to-run.
  if (howBuf.length && howBuf[howBuf.length - 1].bold) {
    out.lede = howBuf.pop().text;
  }
  out.howToRun = howBuf.map(b => b.text);
  void exampleOf;
  return out;
}

const merged = [];
const problems = [];
const seen = new Set();
for (const u of urls) {
  const pageSlug = u.split('/').pop();
  const c = byNorm.get(norm(pageSlug));
  if (!c) { problems.push('page with no JSON entry: ' + u); continue; }
  if (seen.has(c.id)) continue;
  seen.add(c.id);
  const html = fetchText('https://sites.google.com' + u);
  const p = parsePage(html, c);
  merged.push(Object.assign({}, c, {
    almanacUrl: 'https://sites.google.com' + u,
    lede: p.lede || '',
    howToRun: p.howToRun,
    tips: p.tips,
    bluffing: p.bluffing,
    fighting: p.fighting,
    examples: p.examples,
    credit: p.credit
  }));
  process.stdout.write('.');
}
console.log('');
for (const c of chars) {
  if (!seen.has(c.id)) {
    problems.push('JSON-only (no almanac page): ' + c.id);
    merged.push(Object.assign({}, c, {
      lede: '', howToRun: [], tips: [], bluffing: [], fighting: [], examples: [], credit: ''
    }));
  }
}

// ---- the Scripts page: verbatim descriptions ----
// The page runs "Name / description paragraphs / Download" per script; the
// repo-JSON link lives inside the Download block's own markup.
const scriptsHtml = fetchText(SITE + '/home/scripts');
const scripts = [];
let scriptsIntro = [];
{
  let buf = [];
  for (const b of blocks(scriptsHtml)) {
    const t = b.text;
    if (/^©\s*\d{4}/.test(t)) break;
    if (/^scripts$/i.test(t)) continue;
    if (/^download$/i.test(t)) {
      const href = (b.inner.match(/href="([^"]*\/repo\/[^"]+\.json[^"]*)"/) || [])[1];
      if (buf.length && href) {
        const name = buf.shift();
        scripts.push({ name, description: buf.slice(), json: decode(href) });
      }
      buf = [];
      continue;
    }
    if (!scripts.length && !buf.length && /using characters from the menagerie/i.test(t)) {
      scriptsIntro.push(t); continue;
    }
    buf.push(t);
  }
}

// ---- the home page: the site's own intro text, for the collection page ----
const homeHtml = fetchText(SITE + '/home');
const homeBlocks = blocks(homeHtml).map(b => b.text)
  .filter(t => !/^©\s*\d{4}/.test(t));

fs.writeFileSync(path.join(__dirname, 'menagerie-import.json'),
  JSON.stringify({ _meta: meta, scrapedAt: new Date().toISOString(), characters: merged }, null, 1));
fs.writeFileSync(path.join(__dirname, 'menagerie-scripts-import.json'),
  JSON.stringify({ scrapedAt: new Date().toISOString(), scriptsIntro, scripts, home: homeBlocks }, null, 1));

// ---- review dump ----
let rv = '';
for (const c of merged) {
  rv += '==== ' + c.name + ' (' + c.team + ')\n';
  rv += 'LEDE: ' + (c.lede || '(none)') + '\n';
  if (c.credit) rv += 'CREDIT: ' + c.credit + '\n';
  rv += 'HOW: ' + c.howToRun.join(' // ') + '\n';
  rv += 'TIPS: ' + c.tips.join(' // ') + '\n';
  if (c.bluffing.length) rv += 'BLUFF: ' + c.bluffing.join(' // ') + '\n';
  if (c.fighting.length) rv += 'FIGHT: ' + c.fighting.join(' // ') + '\n';
  rv += 'EX: ' + c.examples.join(' // ') + '\n\n';
}
rv += '\n==== SCRIPTS\n';
for (const s of scripts) {
  rv += s.name + ' [' + s.json + ']\n  ' + s.description.join('\n  ') + '\n\n';
}
rv += '\n==== HOME\n' + homeBlocks.join('\n') + '\n';
rv += '\n==== PROBLEMS\n' + problems.join('\n') + '\n';
fs.writeFileSync(path.join(__dirname, 'menagerie-review.txt'), rv);
console.log('characters:', merged.length, '| scripts:', scripts.length, '| problems:', problems.length);
problems.forEach(p => console.log('  !', p));
