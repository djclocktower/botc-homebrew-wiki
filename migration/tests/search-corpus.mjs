// A deterministic, wiki-shaped search corpus and query list, shared by
// search-ranking.test.mjs and the golden file it compares against
// (search-ranking.golden.json). The golden file was produced by the search
// engine as it stood BEFORE the index build was split into slices, so the
// test proves the sliced build ranks every query exactly as the one-pass
// build always did. Regenerate it only for a deliberate ranking change:
//   node migration/tests/search-corpus.mjs > migration/tests/search-ranking.golden.json
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const WORDS = ['grim', 'peeker', 'sculptor', 'poison', 'drunk', 'night', 'oracle', 'warden', 'changeling',
  'tir', 'far', 'thóinn', 'œuvre', 'øyvind', 'straße', 'demon', 'tamer', 'imp', 'witch', 'harbor', 'lantern',
  'temple', 'fair', 'odyssey', 'rome', 'fall', 'bootlegger', 'anthology', 'mycologist', 'ferrotypist',
  'cellscape', 'potato', 'patch', 'clockmaker', 'drunken', 'prisoner', 'apothecary', 'huli', 'jing'];
const TEAMS = ['townsfolk', 'outsider', 'minion', 'demon', 'traveller', 'fabled', 'loric'];
const TAGS = ['Information', 'Poison', 'Drunkenness', 'Setup', 'Win/Loss Condition', 'Multi-Kill', 'Protection', 'Nominations'];
const SETS = ['Odyssey', 'Fall of Rome', "Tales from Tir-Far's Archive", 'The Potato Patch', '', ''];
const CREATORS = ['Moll', 'Taiyi (太一), Saki', 'Tir-Far-Thóinn', 'Øyvind', 'Alex S.', ''];

export function corpus() {
  const r = rng(20261009), pick = a => a[Math.floor(r() * a.length)];
  const characters = [];
  for (let i = 0; i < 700; i++) {
    const n = 1 + Math.floor(r() * 3), name = [];
    for (let k = 0; k < n; k++) name.push(pick(WORDS));
    const title = (r() < 0.1 ? 'The ' : '') + name.map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    const ability = Array.from({ length: 6 + Math.floor(r() * 18) }, () => pick(WORDS.concat(['each', 'player', 'choose', 'the', 'you', 'learn', 'die', 'a', 'of']))).join(' ') + (r() < 0.3 ? '*' : '.');
    const tags = Array.from({ length: Math.floor(r() * 3) }, () => pick(TAGS)).join(', ');
    characters.push({
      slug: 'c' + i, page: 'c/set/c' + i, name: title, team: pick(TEAMS), ability, tags,
      appearsIn: pick(SETS), creator: pick(CREATORS), v: (1700000000 + i * 977).toString(36),
      classification: r() < 0.2 ? 'partial' : 'standard', ...(r() < 0.1 ? { curata: true } : {})
    });
  }
  const scripts = Array.from({ length: 40 }, (_, i) => ({ slug: 's' + i, name: pick(WORDS) + ' ' + pick(WORDS),
    author: pick(CREATORS), tagline: pick(WORDS), characters: ['c' + i], v: (1700000000 + i).toString(36) }));
  const collections = SETS.filter(Boolean).map((name, i) => ({ id: 'k' + i, slug: name, displayName: name,
    author: pick(CREATORS), match: [name.toLowerCase().replace(/[^a-z0-9]+/g, '')] }));
  const extra = {
    creators: CREATORS.filter(Boolean).map(name => ({ name, characters: 3 })),
    users: [{ username: 'tir-far-thóinn', displayName: 'Tir-far-thóinn' }, { username: 'lurker' }],
    pages: [{ slug: 'odyssey-attack', title: 'Attack', parentName: 'Odyssey', blurb: 'What an attack is.' }],
    news: [{ slug: 'jinx-update', title: 'Jinx update', summary: 'New jinxes.', publishedAt: '2026-08-21 02:42:04' }]
  };
  return { characters, scripts, collections, extra };
}
export const QUERIES = ['imp', 'grim peeker', 'grimpeeker', 'poison', 'poisn', 'drunk', 'the drunk', 'each night',
  'tir far', 'tirfar', 'thoinn', 'oeuvre', 'oyvind', 'strasse', 'a', 'i', 'of the', 'odyssey', 'fall of rome',
  'curata', 'demon -imp', '-poison', 'sculpter', 'potato patch', 'win/loss', 'multi kill', 'moll', '太一',
  'lantern temple', 'xyzzy'];

export function rankings(S) {
  const index = S.createIndex(corpus(), '/');
  return rankingsOf(index);
}
export function rankingsOf(index) {
  const out = {};
  for (const q of QUERIES) {
    const res = index.search(q);
    out[q] = { total: res.total, counts: res.counts,
      top: res.results.slice(0, 40).map(r => [r.item.href, Math.round(r.score * 1e4) / 1e4]) };
  }
  return out;
}

// Run directly to print the golden file from a given engine (default: this repo's).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const require = createRequire(import.meta.url);
  const S = require(process.argv[2] || '../../assets/search-core.js');
  process.stdout.write(JSON.stringify(rankings(S), null, 0).replace(/\],"/g, '],\n"') + '\n');
}
