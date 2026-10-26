/* Tag suggestions through Workers AI (env.AI).

   A model is handed the wiki's tag list with its descriptions (tags.js, the
   one source of truth), a handful of already-tagged characters whose
   abilities share the most words with this one, and the character itself,
   and asked which tags apply. The answer is filtered back down to the tag
   list, so nothing the model invents can ever become a tag.

   Nothing here writes. /api/suggest-tags hands the answer to the editor,
   where a person ticks or unticks it before saving, and
   /api/admin/autotag-eval scores it against pages people already tagged.

   The examples are what teach the wiki's own sense of a tag ("Loud" vs
   "Public", what counts as "Death"), which the one-line descriptions cannot.
   They come from the grid feed the Worker already caches, so finding them
   costs no query. */
import Tags from '../assets/tags.js';

// Cheapest capable model on Workers AI that the free plan also allows
// (~25 neurons a call, so the 10,000 free a day is ~400 suggestions).
export const AUTOTAG_MODEL = '@cf/google/gemma-4-26b-a4b-it';

// A machine does not get to call somebody's character a joke.
const NEVER = new Set(['Joke']);
export const SUGGESTABLE = Tags.KNOWN_TAGS.filter(t => !NEVER.has(t));
const BY_LOWER = new Map(SUGGESTABLE.map(t => [t.toLowerCase(), t]));

const EXAMPLES = 8;

export const splitTags = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const words = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
  .split(/\s+/).filter(w => w.length > 2));

/* The tagged rows whose ability shares the most (rare) words with this one.
   ponytail: a linear scan of ~2,000 rows per call, a few ms; move to
   embeddings + Vectorize if it ever shows up in a profile. */
export function pickExamples(char, rows, k = EXAMPLES) {
  const tagged = rows.filter(r => r.ability && splitTags(r.tags).length &&
    r.slug !== char.slug && String(r.name || '').toLowerCase() !== String(char.name || '').toLowerCase());
  const df = new Map();
  const sets = tagged.map(r => { const s = words(r.ability); s.forEach(w => df.set(w, (df.get(w) || 0) + 1)); return s; });
  const mine = words(char.ability);
  return tagged.map((r, i) => {
    let score = 0;
    mine.forEach(w => { if (sets[i].has(w)) score += Math.log(1 + tagged.length / df.get(w)); });
    return [score, r];
  }).filter(x => x[0] > 0).sort((a, b) => b[0] - a[0]).slice(0, k).map(x => x[1]);
}

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

export function buildMessages(char, examples) {
  const list = SUGGESTABLE.map(t => '- ' + t + ': ' + Tags.describeTag(t)).join('\n');
  const ex = examples.map(r => 'Character: ' + clip(r.name, 80) + ' (' + r.team + ')\nAbility: ' +
    clip(r.ability, 400) + '\nTags: ' + splitTags(r.tags).filter(t => BY_LOWER.has(t.toLowerCase())).join(', ')).join('\n\n');
  const extra = [char.lede, ...(Array.isArray(char.summaryBullets) ? char.summaryBullets : [])]
    .map(s => clip(s, 300)).filter(Boolean).join(' ');
  return [
    { role: 'system', content:
      'You tag homebrew characters for a Blood on the Clocktower wiki. Choose only tags from this list ' +
      'that clearly apply to the character\'s ability. Most characters have 2 to 5 tags.\n\n' + list +
      '\n\nAnswer with JSON only, like {"tags": ["Information", "Neighbor"]}.' },
    { role: 'user', content:
      (ex ? 'Characters already tagged on the wiki:\n\n' + ex + '\n\nNow this one:\n' : '') + 'Character: ' + clip(char.name, 80) +
      ' (' + clip(char.team, 20) + ')\nAbility: ' + clip(char.ability, 600) +
      (extra ? '\nAbout it: ' + clip(extra, 900) : '') + '\nTags:' }
  ];
}

/* Whatever came back, reduced to tags on the list. JSON first; if the model
   wrapped or broke it, any tag name it wrote out still counts. */
export function parseTags(text) {
  const s = String(text || '');
  let picked = [];
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { picked = JSON.parse(m[0]).tags || []; } catch (e) {} }
  if (!Array.isArray(picked) || !picked.length) {
    picked = SUGGESTABLE.filter(t => new RegExp('"' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"', 'i').test(s));
  }
  return [...new Set(picked.map(t => BY_LOWER.get(String(t).trim().toLowerCase())).filter(Boolean))];
}

export async function suggestTags(env, char, rows, model = AUTOTAG_MODEL) {
  if (!env.AI) throw Object.assign(new Error('Tag suggestions are not switched on yet.'), { public: true });
  const out = await env.AI.run(model, { messages: buildMessages(char, pickExamples(char, rows)), max_tokens: 1500 });
  const text = typeof out === 'string' ? out
    : out && (out.response ?? (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content));
  return parseTags(typeof text === 'string' ? text : JSON.stringify(text || ''));
}
