// The wiki's colours, as variables. Dark mode is this table and nothing else.
//
//   node migration/theme-vars.mjs           rewrite bare colours to variables and
//                                           regenerate the two tables in styles.css
//   node migration/theme-vars.mjs --check   change nothing; exit 1 if a file still
//                                           holds a bare colour or the tables are stale
//   node migration/theme-vars.mjs --report  list what is skipped and why
//
// Run it after adding CSS that names a colour. A colour written as
// `color: #6b5d49` becomes `color: var(--fg-6b5d49)`: the name is the ROLE the
// colour plays (fg text, bg surface, bd border, sh shadow) and its light value,
// so the light theme is the value in the name, exactly, and the dark theme is
// darkOf(role, value) below unless DARK names it by hand.
//
// The role matters because one colour does opposite jobs: #5b1f21 is body text
// on parchment (dark mode: light) and a button's fill under white text (dark
// mode: still dark). A colour that must not follow the theme is written with a
// keep mark and is left alone:  background: #fff /*keep*/;
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.env.BOTC_BUILD_ROOT || fileURLToPath(new URL('../', import.meta.url)));
const CHECK = process.argv.includes('--check');
const REPORT = process.argv.includes('--report');

// ── which files ──────────────────────────────────────────────────────────
const CSS_FILES = ['styles.css', 'editor.css', 'comments.css', 'redesign-create.css'];
const TABLE_FILE = 'assets/styles.css';
// Pages that are not the wiki's own look: redirect stubs carry no styles, and
// these are self-contained.
const SKIP_HTML = new Set(['character.html', 'edit-collection.html', 'register-collection.html']);
// Scripts whose style="" strings are the wiki's markup. Anything that draws on
// a canvas, writes an email or builds a poster keeps its own colours and is
// not listed.
const JS_FILES = [
  'assets/render.js', 'assets/render-page.js', 'assets/render-wiki.js', 'assets/render-news.js',
  'assets/site.js', 'assets/comments.js', 'assets/attach.js', 'assets/charpage.js', 'assets/pageview.js',
  'assets/wikipage.js', 'assets/card-filters.js', 'assets/char-filters.js', 'assets/card-actions.js',
  'assets/favorites.js', 'assets/search-page.js', 'assets/home.js', 'assets/classify.js',
  'assets/creators.js', 'assets/mark-editor.js', 'assets/editor-notices.js', 'assets/approved-editors.js',
  'assets/jinx-picker.js', 'assets/jinx-editor.js', 'assets/night-order-editor.js', 'assets/night-order-picker.js',
  'assets/related-editor.js', 'assets/special-editor.js', 'assets/almanac-alt.js', 'assets/wiki-editor.js',
  'assets/theme-editor.js', 'assets/custom-url.js', 'assets/tag-suggest.js', 'assets/tags.js',
  'assets/suggest.js', 'assets/art-adjust.js', 'assets/art-labels.js', 'assets/starlit.js',
  'assets/starlit-picker.js', 'assets/char-icon-save.js', 'assets/logo-admin.js', 'assets/text-live.js',
  'assets/token-auto.js', 'assets/viewport.js', 'assets/reading-lazy.js', 'assets/page-viewer.js',
  'assets/system-text.js', 'assets/did-you-mean.js', 'assets/importer.js', 'assets/rules.js',
  'worker/home-page.js', 'worker/list-pages.js',
];

// The variables the stylesheet already had. Each keeps its name for the role it
// mostly plays and takes a suffix for the others (--maroon is text; a maroon
// button is --maroon-bg).
const NAMED = {
  'purple-deep': '#1a0820', 'purple-mid': '#4a2548',
  'parch': '#f0e8d5', 'parch-edge': '#e0d0b0', 'parch-frame': '#bda89a',
  'card': '#f7f6f2', 'card-edge': '#d7c9ab',
  'ex-bg': '#ded3cd', 'ex-frame': '#bcae93',
  'maroon': '#5b1f21', 'ink': '#000',
  'good': '#2c7bd0', 'good-name': '#2f6fb8', 'evil': '#9a0d12',
  'outsider': '#1a6a80', 'minion': '#b5441a', 'fabled': '#8f6d1a', 'loric': '#2f6b3f',
  'other': '#4a2548', 'rule': '#b79c6f',
};
const NAMED_HOME = {
  'purple-deep': 'bg', 'purple-mid': 'bg', 'parch': 'bg', 'parch-edge': 'bd', 'parch-frame': 'bd',
  'card': 'bg', 'card-edge': 'bd', 'ex-bg': 'bg', 'ex-frame': 'bd',
  'maroon': 'fg', 'ink': 'fg', 'good': 'fg', 'good-name': 'fg', 'evil': 'fg',
  'outsider': 'fg', 'minion': 'fg', 'fabled': 'fg', 'loric': 'fg', 'other': 'fg', 'rule': 'bd',
};

// ── colour maths ─────────────────────────────────────────────────────────
function parseColor(s) {
  s = s.trim().toLowerCase();
  if (s === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? Math.round(parseInt(h.slice(6, 8), 16) / 255 * 1000) / 1000 : 1,
    };
  }
  m = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(s);
  if (m) {
    let a = m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]), a };
  }
  return null;
}
const hex2 = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
function hex6(c) {
  const h = hex2(c.r) + hex2(c.g) + hex2(c.b);
  return (h[0] === h[1] && h[2] === h[3] && h[4] === h[5]) ? h[0] + h[2] + h[4] : h;
}
// The part of a variable's name that IS its light value: "6b5d49", "fff-a50".
function keyOf(c) {
  if (c.a >= 1) return hex6(c);
  let pct = String(Math.round(c.a * 1000));           // .15 -> 150, .045 -> 45
  pct = pct.padStart(3, '0').replace(/0$/, '');        // 150 -> 15, 045 -> 045, 500 -> 50
  if (pct.length < 2) pct = pct.padStart(2, '0');
  return hex6(c) + '-a' + pct;
}
function colorOfKey(key) {
  const m = /^([0-9a-f]{3}|[0-9a-f]{6})(?:-a(\d{2,3}))?$/.exec(key);
  if (!m) return null;
  const c = parseColor('#' + m[1]);
  if (m[2]) c.a = m[2].length === 3 ? +m[2] / 1000 : +m[2] / 100;
  return c;
}
function cssOf(c) {
  if (c.a >= 1) return '#' + hex6(c);
  const a = String(Math.round(c.a * 1000) / 1000).replace(/^0\./, '.');
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
}
function toHsl(c) {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > .5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}
function fromHsl(h, s, l, a) {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
  const k = n => (n + h / 30) % 12, f = n => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255), a: a == null ? 1 : a };
}
// Perceived lightness, 0..1 (the L of Lab, near enough).
function lum(c) {
  const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
  const y = .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b);
  return y <= .008856 ? y * 9.033 : 1.16 * Math.cbrt(y) - .16;
}
// Move a colour to a target perceived lightness, keeping hue and saturation.
function withLum(h, s, target, a) {
  let lo = 0, hi = 1, c;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    c = fromHsl(h, s, mid, a);
    if (lum(c) < target) lo = mid; else hi = mid;
  }
  return c;
}

// ── the dark theme ───────────────────────────────────────────────────────
// Purple is the house colour: warm neutrals (parchment, tan, brown) take this
// hue; a colour that means something (team blue, evil red, a green tick, gold)
// keeps its own.
const PURPLE = 286;
const PANEL_L = .155;      // the night parchment, where the cream one was
const PARCH_L = lum(parseColor('#f0e8d5'));
// Parchment creams, tans and browns: a warm hue with little colour in it.
// Chroma, not HSL saturation, which reads a pale cream as "70% saturated";
// gold and amber sit in the same hue range and must stay gold.
function isWarmNeutral(c, h) {
  const chroma = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  return chroma < 22 || (h >= 14 && h <= 64 && chroma < 80);
}
// The wiki's maroon (#5b1f21 and its neighbours), not the evil team's red.
function isMaroon(h, s) { return (h >= 340 || h <= 14) && s > .25 && s < .7; }

function darkOf(role, c) {
  const { h, s } = toHsl(c), L = lum(c), a = c.a;
  const neutral = isWarmNeutral(c, h);
  if (role === 'bg') {
    if (a < 1) {
      // A wash. White lifts parchment; here it lifts the night panel, gently.
      if (L > .6) return neutral ? { ...fromHsl(PURPLE, .45, .78), a: Math.min(a, .5) * .22 } : withLum(h, Math.min(s, .7), .62, a * .5);
      if (L < .12) return c;                               // a black scrim stays a scrim
      // a tinted wash (maroon at 10%): the tint, lightened so it shows on dark
      return neutral || isMaroon(h, s) ? { ...fromHsl(PURPLE, .5, .72), a: a * .9 } : withLum(h, Math.min(s, .75), .62, a);
    }
    if (L <= .34) {
      // Already dark. Maroon fills lean purple; the rest is left alone.
      if (isMaroon(h, s)) return withLum(PURPLE + 6, .46, Math.max(L, .2) + .09);
      return c;
    }
    if (neutral) {
      // Surfaces. Lighter than parchment = raised above the panel; darker
      // than parchment (tans, stripes) = a step further up still.
      const d = L - PARCH_L;
      const t = d >= 0 ? PANEL_L + d * .75 : PANEL_L + Math.min(.16, -d * .42);
      const sat = d >= 0 ? .34 : .36 + Math.min(.12, -d * .5);
      return withLum(PURPLE, sat, t);
    }
    // A coloured fill (a green notice, a gold chip, a red warning): same hue,
    // deep enough to carry light text.
    return withLum(h, Math.min(s, .6), L > .7 ? .2 : .27);
  }
  if (role === 'fg') {
    if (a < 1) {
      if (L > .6) return c;                                 // light text on the dark page, as it was
      const base = darkOf('fg', { ...c, a: 1 });
      return { ...base, a: Math.min(1, a + .08) };
    }
    if (L >= .62) return c;                                 // already light
    if (neutral) {
      // ink and browns: the darker it was, the brighter it reads now
      const t = .93 - L * .62;
      return withLum(PURPLE - 6, .22 + L * .25, t);
    }
    if (isMaroon(h, s) && L < .32) return withLum(PURPLE + 10, .5, .84 - L * .3);
    return withLum(h, Math.min(1, s * .9 + .1), Math.max(.68, .9 - L * .45));
  }
  if (role === 'bd') {
    if (L < .12 && a < 1) return { ...fromHsl(PURPLE, .5, .8), a: Math.min(.5, a * 1.4) };
    if (a < 1 && L > .6) return neutral ? { ...fromHsl(PURPLE, .5, .8), a: a * .35 } : withLum(h, s, .6, a);
    if (neutral || (isMaroon(h, s) && L < .32)) {
      // contrast against parchment becomes contrast against the night panel
      const d = Math.abs(L - PARCH_L);
      return withLum(PURPLE, .3 + d * .15, PANEL_L + .1 + d * .62, a);
    }
    return withLum(h, Math.min(s, .7), Math.max(.5, .82 - L * .4), a);
  }
  if (role === 'sh') {
    // Only light ones reach here: the white line inside a parchment frame,
    // which becomes a faint lilac one, and coloured rings, which stay.
    if (neutral || L > .9) return { ...fromHsl(PURPLE, .5, .82), a: a * .32 };
    return c;
  }
  return c;
}

// Named by hand. Key: the variable's name without the dashes in front.
// Value: any CSS colour.
const DARK = {
  // the frame round every panel, and the rules inside it: purple, not neon
  'parch-frame': '#70487f', 'ex-frame': '#6c4579', 'rule': '#7b4f8b', 'card-edge': '#5c3a68',
  // headings and accents (the maroon ink)
  'maroon': '#dcb4ee',
};

// ── reading CSS ──────────────────────────────────────────────────────────
// Blank out comments, strings and url() bodies so a colour-shaped run inside
// one is never touched. Same length as the input, so offsets carry over.
function mask(css) {
  let out = '', i = 0;
  const n = css.length;
  while (i < n) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      let j = css.indexOf('*/', i + 2); j = j < 0 ? n : j + 2;
      const body = css.slice(i, j);
      // A keep mark survives as a marker the declaration scan can see.
      out += /^\/\*\s*keep\s*\*\/$/.test(body) ? '\u0001'.repeat(body.length) : ' '.repeat(body.length);
      i = j; continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && css[j] !== ch) { if (css[j] === '\\') j++; j++; }
      j = Math.min(n, j + 1);
      out += ch + ' '.repeat(Math.max(0, j - i - 2)) + (j - i >= 2 ? ch : '');
      i = j; continue;
    }
    if ((ch === 'u' || ch === 'U') && /^url\(/i.test(css.slice(i, i + 4))) {
      let j = css.indexOf(')', i); j = j < 0 ? n : j + 1;
      const inner = css.slice(i + 4, j - 1).trim();
      if (!/^['"]/.test(inner)) { out += 'url(' + ' '.repeat(j - i - 5) + ')'; i = j; continue; }
    }
    out += ch; i++;
  }
  return out;
}

const ROLE_OF = prop => {
  if (/^(color|fill|stroke|caret-color|-webkit-text-fill-color|-webkit-text-stroke(-color)?|text-decoration(-color)?|text-emphasis(-color)?)$/.test(prop)) return 'fg';
  if (/^(background|background-color|background-image|accent-color)$/.test(prop)) return 'bg';
  if (/^(border|border-(top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end)(-color)?|border-color|outline|outline-color|column-rule(-color)?)$/.test(prop)) return 'bd';
  if (/^(box-shadow|text-shadow|filter|-webkit-filter|backdrop-filter)$/.test(prop)) return 'sh';
  return '';
};

const TOKEN = /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])|rgba?\([^()]*\)|\b(?:white|black)\b(?![-(])|var\(--([a-z0-9-]+)\)/g;
const OURS = /^(fg|bg|bd|sh)-((?:[0-9a-f]{3}|[0-9a-f]{6})(?:-a\d{2,3})?)$/;
const NAMED_ROLE = /^(.+)-(fg|bg|bd)$/;

const used = new Map();          // variable name -> { role, light: colour }
const skipped = [];
function note(file, why, text) { skipped.push(file + ': ' + why + ': ' + text.trim().slice(0, 90)); }

function useVar(name, role, light) { if (!used.has(name)) used.set(name, { role, light }); return 'var(--' + name + ')'; }

// One run of declarations (a stylesheet, a <style> block, or a style=""
// attribute, which has no braces). Returns the rewritten text.
function convert(css, file, attr) {
  const m = mask(css);
  let out = '', last = 0, hit;
  TOKEN.lastIndex = 0;
  while ((hit = TOKEN.exec(m))) {
    const at = hit.index, tok = hit[0];
    // Where the declaration starts and ends.
    let s = at;
    while (s > 0 && !'{};'.includes(m[s - 1])) s--;
    let e = at + tok.length, depth = 0;
    while (e < m.length) {
      const ch = m[e];
      if (ch === '(') depth++; else if (ch === ')') depth--;
      else if (depth <= 0 && '{};'.includes(ch)) break;
      e++;
    }
    if (!attr && m[e] === '{') continue;                       // a selector (#add) or an at-rule
    const decl = m.slice(s, e);
    const colon = decl.indexOf(':');
    if (colon < 0 || s + colon > at) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1);
    if (decl.includes('\u0001')) continue;                     // marked keep
    if (!attr) {
      // A rule written FOR the dark theme says what it means already.
      let b = s - 1;
      while (b > 0 && m[b] !== '{' && m[b] !== '}') b--;
      if (m[b] === '{') {
        let a = b - 1;
        while (a > 0 && !'{};'.includes(m[a - 1])) a--;
        if (m.slice(a, b).includes('data-theme')) continue;
      }
    }
    if (prop.startsWith('--')) {
      if (!hit[1] && !NAMED[prop.slice(2)]) note(file, 'a variable of its own', css.slice(s, e));
      continue;
    }
    if (/--pg-|--cmt-/.test(value) && hit[1] == null) { continue; }
    const role = ROLE_OF(prop);
    let rep = null;
    if (hit[1] != null) {
      // one of the wiki's variables
      let name = hit[1], base = name, r = role;
      if (OURS.test(name)) {
        const mm = OURS.exec(name);
        useVar(name, mm[1], colorOfKey(mm[2]));
        continue;
      }
      const nr = NAMED_ROLE.exec(name);
      if (nr && NAMED[nr[1]]) { useVar(name, nr[2], parseColor(NAMED[nr[1]])); continue; }
      if (!NAMED[base]) continue;
      if (/--pg-/.test(value)) { useVar(base, NAMED_HOME[base], parseColor(NAMED[base])); continue; }
      if (!r || r === 'sh') r = NAMED_HOME[base];
      const full = r === NAMED_HOME[base] ? base : base + '-' + r;
      rep = useVar(full, r, parseColor(NAMED[base]));
    } else {
      const c = parseColor(tok);
      if (!c) { continue; }
      if (c.a === 0) continue;
      if (!role) { note(file, 'unknown property "' + prop + '"', css.slice(s, e)); continue; }
      if (role === 'sh' && lum(c) < .45) continue;             // an ordinary dark shadow
      rep = useVar(role + '-' + keyOf(c), role, c);
    }
    if (rep === tok) continue;
    out += css.slice(last, at) + rep;
    last = at + tok.length;
  }
  return out + css.slice(last);
}

// ── the tables ───────────────────────────────────────────────────────────
const BEGIN = '/* ─── Colour table: generated by migration/theme-vars.mjs, never hand-edited ─── */';
const END = '/* ─── end of the colour table ─── */';
function tables() {
  const names = [...used.keys()].sort((a, b) => {
    const A = used.get(a), B = used.get(b);
    const na = OURS.test(a) ? 1 : 0, nb = OURS.test(b) ? 1 : 0;
    return na - nb || A.role.localeCompare(B.role) || a.localeCompare(b);
  });
  const light = [], dark = [];
  for (const name of names) {
    const v = used.get(name);
    light.push('--' + name + ':' + cssOf(v.light));
    const d = DARK[name] != null ? DARK[name] : cssOf(darkOf(v.role, v.light));
    if (d !== cssOf(v.light)) dark.push('--' + name + ':' + d);
  }
  const wrap = list => { let s = '', line = ' '; for (const d of list) { if ((line + ' ' + d + ';').length > 110) { s += line + '\n'; line = ' '; } line += ' ' + d + ';'; } return s + line + '\n'; };
  return BEGIN + '\n:root {\n' + wrap(light) + '}\n:root[data-theme="dark"] {\n  color-scheme: dark;\n' + wrap(dark) + '}\n' + END;
}

// ── run ──────────────────────────────────────────────────────────────────
const changed = [];
async function each(path, fn) {
  const before = await readFile(resolve(root, path), 'utf8');
  const after = fn(before);
  if (after !== before) { changed.push(path); if (!CHECK) await writeFile(resolve(root, path), after); }
}
const STYLE_BLOCK = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
// style="…" in markup, and the same thing inside a script's string.
const STYLE_ATTR = /(\bstyle=(\\?)")([^"\\<>]*(?:\\(?!")[^"\\<>]*)*)(\\?")/g;
// Not the ones a page only SHOWS, as text: &lt;span style="color:#8b2c2c"&gt;.
const attrs = (text, file) => text.replace(STYLE_ATTR, (all, open, esc, body, close, at) => {
  if (!/#[0-9a-fA-F]{3}|rgba?\(|var\(--/.test(body)) return all;
  const before = text.slice(Math.max(0, at - 400), at);
  if (before.lastIndexOf('&lt;') > before.lastIndexOf('<')) return all;
  return open + convert(body, file, true) + close;
});

// styles.css holds the tables: take the old ones out, convert, and put fresh
// ones back once every other file has said what it uses.
const tablePath = resolve(root, TABLE_FILE);
const tableBefore = await readFile(tablePath, 'utf8');
let tableBody = tableBefore;
{
  const a = tableBody.indexOf(BEGIN), b = tableBody.indexOf(END);
  if (a >= 0 && b > a) tableBody = tableBody.slice(0, a) + '\u0000' + tableBody.slice(b + END.length);
  else {
    const anchor = tableBody.indexOf('/* ─── Base ');
    if (anchor < 0) throw new Error('styles.css: cannot find where the colour table goes');
    tableBody = tableBody.slice(0, anchor) + '\u0000\n\n' + tableBody.slice(anchor);
  }
  tableBody = convert(tableBody, 'styles.css');
}
for (const f of CSS_FILES) {
  if ('assets/' + f === TABLE_FILE) continue;
  await each('assets/' + f, css => convert(css, f));
}
for (const f of (await readdir(root)).sort()) {
  if (!f.endsWith('.html') || SKIP_HTML.has(f)) continue;
  await each(f, html => attrs(html.replace(STYLE_BLOCK, (all, a, css, z) => a + convert(css, f) + z), f));
}
for (const f of JS_FILES) {
  try { await each(f, js => attrs(js, f)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
{
  const next = tableBody.replace('\u0000', () => tables());
  if (next !== tableBefore) { changed.push(TABLE_FILE); if (!CHECK) await writeFile(tablePath, next); }
}

if (REPORT) for (const line of skipped) console.log(line);
console.log(used.size + ' colour variables; ' + (CHECK ? 'would change ' : 'changed ') + changed.length + ' file(s)' + (changed.length ? ': ' + changed.join(', ') : ''));
if (skipped.length && !REPORT) console.log(skipped.length + ' colour(s) left as written (--report lists them)');
if (CHECK && changed.length) { console.error('Run node migration/theme-vars.mjs and commit the result.'); process.exit(1); }
