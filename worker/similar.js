/* similar.js — "More like this": the characters a /c/ page suggests next.
 *
 * Pure functions, no database and no fetch: worker.js hands in the published
 * GRID feed (the same cached body the browse pages download) and asks for one
 * character's neighbours. The tests call these directly.
 *
 * How alike two characters are is three things, weighted:
 *   - their ABILITY TEXT (0.65): TF-IDF over words and word pairs, so the
 *     words every ability shares ("each", "night", "player") count for next
 *     to nothing and the ones that say what a character DOES ("poisoned",
 *     "vote", "exile", "mad") carry the match;
 *   - their TAGS (0.30): overlap weighted the same way, so sharing
 *     "Misregistration" says more than sharing "Information";
 *   - their TEAM (0.08): a nudge, only for a character already matched on
 *     one of the two above — a team alone is not a resemblance.
 *
 * Partial pages are never suggested (the browse pages hide them too), nor is
 * a page whose ability is word for word the one being read. At most two come
 * from any one creator, so a prolific creator's own set does not fill the
 * strip on every page they wrote.
 */

// Words carrying no mechanic at all. Everything else is left to the IDF,
// which learns from the corpus itself what is common.
const STOP = new Set(('a an and are as at be been but by can could do does for from had has have ' +
  'he her him his how i if in into is it its may me my no nor not of on or our she so ' +
  'than that the their them then there these they this those to was were what when ' +
  'which while who whom why will with would you your').split(' '));

export const SIMILAR_MAX = 6;
const MIN_SCORE = 0.12;
const PER_CREATOR = 2;
const W_TEXT = 0.65, W_TAGS = 0.30, W_TEAM = 0.08;

// A crude stem that is consistent rather than correct: "votes", "voted" and
// "vote" all become "vot"; "dies", "died" and "die" all become "di".
function stem(w) {
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('ing')) w = w.slice(0, -3);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

export function abilityTerms(text) {
  const words = String(text || '').toLowerCase()
    .replace(/[‘’']/g, '')
    .split(/[^a-z]+/)
    .filter(w => w.length > 1 && !STOP.has(w))
    .map(stem)
    .filter(w => w.length > 1);
  const counts = new Map();
  const add = t => counts.set(t, (counts.get(t) || 0) + 1);
  words.forEach((w, i) => {
    add(w);
    if (i) add(words[i - 1] + ' ' + w);
  });
  return counts;
}

function tagSet(c) {
  const raw = Array.isArray(c.tags) ? c.tags : String(c.tags || '').split(',');
  return new Set(raw.map(t => String(t || '').trim().toLowerCase()).filter(Boolean));
}
function firstCreator(s) {
  return String(s || '').split(',')[0].trim().toLowerCase();
}
function abilityKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function buildSimilarIndex(chars) {
  const docs = [];
  const df = new Map(), tagDf = new Map();
  for (const c of chars || []) {
    if (!c || !c.slug || !c.name) continue;
    const terms = abilityTerms(c.ability);
    for (const t of terms.keys()) df.set(t, (df.get(t) || 0) + 1);
    const tags = tagSet(c);
    for (const t of tags) tagDf.set(t, (tagDf.get(t) || 0) + 1);
    docs.push({
      c, terms, tags,
      team: String(c.team || '').toLowerCase(),
      creator: firstCreator(c.creator),
      key: abilityKey(c.ability),
      partial: c.classification === 'partial'
    });
  }
  const n = docs.length;
  const idf = (map, t) => Math.log((n + 1) / ((map.get(t) || 0) + 1)) + 1;
  const inverted = new Map();   // term -> [[doc, weight]], only terms two docs share
  const tagInv = new Map();     // tag  -> [doc]
  const bySlug = new Map();
  docs.forEach((d, i) => {
    bySlug.set(String(d.c.slug), i);
    const w = new Map();
    let norm = 0;
    for (const [t, k] of d.terms) {
      const x = (1 + Math.log(k)) * idf(df, t);
      w.set(t, x);
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, x] of w) {
      const v = x / norm;
      w.set(t, v);
      if ((df.get(t) || 0) > 1) {
        if (!inverted.has(t)) inverted.set(t, []);
        inverted.get(t).push([i, v]);
      }
    }
    d.w = w;
    d.tagW = new Map([...d.tags].map(t => [t, idf(tagDf, t)]));
    for (const t of d.tags) {
      if (!tagInv.has(t)) tagInv.set(t, []);
      tagInv.get(t).push(i);
    }
  });
  return { docs, inverted, tagInv, bySlug };
}

/* The card a suggestion is drawn with: what the grid feed already says about
   the character, and nothing else. */
function card(c) {
  const out = {};
  for (const k of ['slug', 'page', 'name', 'team', 'art', 'image', 'v', 'creator', 'ability', 'curata']) {
    if (c[k] !== undefined && c[k] !== null && c[k] !== '') out[k] = c[k];
  }
  return out;
}

export function similarTo(index, slug, max = SIMILAR_MAX) {
  const qi = index && index.bySlug.get(String(slug || ''));
  if (qi === undefined) return [];
  const q = index.docs[qi];
  const score = new Map();

  for (const [t, v] of q.w) {
    const post = index.inverted.get(t);
    if (!post) continue;
    for (const [i, w] of post) if (i !== qi) score.set(i, (score.get(i) || 0) + W_TEXT * v * w);
  }

  if (q.tags.size) {
    const seen = new Set();
    for (const t of q.tags) for (const i of index.tagInv.get(t) || []) if (i !== qi) seen.add(i);
    for (const i of seen) {
      const d = index.docs[i];
      let shared = 0, union = 0;
      for (const [t, w] of q.tagW) { union += w; if (d.tagW.has(t)) shared += w; }
      for (const [t, w] of d.tagW) if (!q.tagW.has(t)) union += w;
      if (union) score.set(i, (score.get(i) || 0) + W_TAGS * shared / union);
    }
  }

  const ranked = [];
  for (const [i, s] of score) {
    const d = index.docs[i];
    if (d.partial || (q.key && d.key === q.key)) continue;
    const total = s + (q.team && d.team === q.team ? W_TEAM : 0);
    if (total >= MIN_SCORE) ranked.push([i, total]);
  }
  ranked.sort((a, b) => b[1] - a[1] || String(index.docs[a[0]].c.name).localeCompare(String(index.docs[b[0]].c.name)));

  const perCreator = new Map();
  const out = [];
  for (const [i, s] of ranked) {
    const d = index.docs[i];
    const k = d.creator || '';
    if (k && (perCreator.get(k) || 0) >= PER_CREATOR) continue;
    perCreator.set(k, (perCreator.get(k) || 0) + 1);
    const item = card(d.c);
    item.score = Math.round(s * 1000) / 1000;
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}
