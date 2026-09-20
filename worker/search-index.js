// Explicit public projections. Never spread database or account rows here.
import Creators from '../assets/creators.js';

function label(value) {
  return (Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim();
}
export function plain(value) {
  if (Array.isArray(value)) return value.map(plain).join(' ');
  if (!value || typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[\[\]{}*_`#]/g, '').replace(/\s+/g, ' ').trim();
}
function image(path, version, character) {
  if (Array.isArray(path)) path = path[0];
  if (typeof path !== 'string' || !path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  if (/^\/\//.test(path)) return 'https:' + path;
  path = path.replace(/^\/?assets\//, '');
  const suffixAt = path.search(/[?#]/);
  const suffix = suffixAt < 0 ? '' : path.slice(suffixAt);
  if (suffixAt >= 0) path = path.slice(0, suffixAt);
  if (!/^(art|thumb|scripts|collections|news|pages|avatars|icons)\/[\w./%-]+$/.test(path)) return '';
  if (path.split('/').includes('..')) return '';
  if (character && /^art\/[^/]+$/.test(path)) path = 'thumb/' + path.slice(4) + '.webp';
  const url = new URL('/assets/' + path + suffix, 'https://botchomebrew.wiki');
  if (version) url.searchParams.set('v', version);
  return url.pathname + url.search + url.hash;
}
export function contentDocument(type, d) {
  const character = type === 'character';
  const title = label(d.name || d.displayName || d.title || d.slug);
  const summary = plain(d.ability || d.tagline || d.blurb || d.description || d.lede || d.subtitle);
  const creator = label(d.creator || d.author);
  const route = character ? String(d.page || 'c/' + d.slug).replace(/^\//, '')
    : (type === 'collection' ? 'collection/' + encodeURIComponent(d.id || d.slug)
      : ({ script: 's/', page: 'p/', news: 'news/' }[type] + encodeURIComponent(d.slug)));
  const sets = [...label(d.appearsIn).split(/\s*,\s*/), ...(d.appearsInFrom || []).map(x => label(x.name || x.displayName || x.id))].filter(Boolean);
  return {
    type, title, url: '/' + route, summary, creator,
    creators: Creators.splitCreators(creator),
    tags: label(d.tags).split(/\s*,\s*/).filter(Boolean),
    team: character ? d.team || '' : '', sets,
    classification: d.classification || '', curata: !!d.curata,
    image: image(character ? d.art || d.image : d.header || d.logo, d.v, character),
    // Long prose is represented by unique words, not repeated paragraphs.
    terms: [...new Set(plain([d.lede, d.quote, d.flavor, d.synopsis, d.gameplay,
      d.strategyGood, d.strategyEvil, d.body, d.subtitle]).split(/\s+/))].join(' ')
  };
}

const SITE_PAGES = [
  ['All Characters', '/all-characters', 'Browse all homebrew characters'],
  ['Scripts', '/scripts', 'Browse homebrew scripts'],
  ['Collections', '/all-collections', 'Browse character collections'],
  ['Tags', '/tags', 'Browse characters by tag'],
  ['Jinxes', '/jinxes', 'Character interactions and jinx rules'],
  ['News', '/news', 'Wiki news and updates'],
  ['Wiki Rules', '/rules', 'Community rules'],
  ['Creator Icons', '/creators', 'Creator credit symbols'],
  ['Tools', '/tools', 'Tools for creating homebrew'],
  ['Script Builder', '/script', 'Build and export a script'],
  ['Token Tool', '/tokens', 'Create printable character tokens'],
  ['Grimoire Forge', '/grimforge', 'Create homebrew characters'],
  ['Icon Forge', '/iconforge', 'Create and edit character icons'],
  ['Bloodstar Import', '/bloodstar', 'Import a Bloodstar project'],
  ['Create a Character', '/create', 'Write a homebrew character'],
  ['Steven Approved Order', '/steven-approved-order', 'Script character ordering']
];
export function completeIndex(content, users) {
  const documents = content.slice();
  const credits = new Map(), tags = new Set();
  for (const doc of content) {
    for (const name of doc.creators || []) if (!credits.has(name.toLowerCase())) credits.set(name.toLowerCase(), name);
    for (const tag of doc.tags || []) tags.add(tag);
  }
  for (const name of credits.values()) documents.push({ type: 'creator', title: name,
    url: '/author?a=' + encodeURIComponent(name), summary: '', creator: name, creators: [name] });
  for (const u of users) documents.push({ type: 'user', title: u.display_name || u.username,
    url: '/u/' + encodeURIComponent(u.username), summary: '@' + u.username,
    terms: u.username, image: image(u.avatar_url) });
  for (const tag of tags) documents.push({ type: 'tag', title: tag,
    url: '/tag?t=' + encodeURIComponent(tag), summary: '', tags: [tag] });
  for (const [title, url, summary] of SITE_PAGES) documents.push({ type: 'tool', title, url, summary });
  return { schema: 1, documents };
}
