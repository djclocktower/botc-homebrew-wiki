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
import { OFFICIAL_TAGGED, OFFICIAL_WIKI_TAGS } from './official-tags.js';

// Cheapest capable model on Workers AI that the free plan also allows
// (~25 neurons a call, so the 10,000 free a day is ~400 suggestions).
export const AUTOTAG_MODEL = '@cf/google/gemma-4-26b-a4b-it';

// A machine does not get to call somebody's character a joke.
const NEVER = new Set(['Joke']);
export const SUGGESTABLE = Tags.KNOWN_TAGS.filter(t => !NEVER.has(t));
const BY_LOWER = new Map(SUGGESTABLE.map(t => [t.toLowerCase(), t]));

const EXAMPLES = 8;
// Of those, up to this many are official characters (worker/official-tags.js,
// from the official Chinese wiki's categories): the owner's highest-priority
// source, and most homebrew is written as a variation on one of them.
const OFFICIAL_EXAMPLES = 3;
const OFFICIAL_ROWS = OFFICIAL_TAGGED.map(r => ({ ...r, official: true }));

/* Phrases that mean a tag, worked out from how the game's mechanics are
   written ("[+1 Outsider]" is Outsider Modification, "(once)" is Once Per
   Game). Each was measured against the 1,871 tagged pages; nearly every hit
   on a page WITHOUT the tag was a tag its taggers missed, not a wrong cue.
   SURE cues are added to the suggestion whatever the model says: they are
   the tag's own definition written out. HINT cues are handed to the model
   with the words they matched, to keep or drop. A tag with no phrase here
   (Joke) is judgement only. [tag, level, test, teams?]; test is a RegExp or
   (ability, char) => bool; teams limits a cue to those teams. */
const SURE = 'sure', HINT = 'hint', EVIL = ['demon', 'minion'];
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const CUES = [
  ['Ability Gain', SURE, /\b(re)?gains?\b[^.]{0,40}\babilit/i],
  ['Ability Gain', HINT, /\bha(s|ve) (the|their|that|its|an?|another|every)\b[^.]{0,30}\babilit|\bas if (you|they) (were|are)\b|\buses? (their|that|its|this) abilit/i],
  ['Alignment Change', SURE, /\b(becomes?|turns?|is now|are now|switch(es)? to|changes? to) (an? )?(good|evil)\b|\bbecomes? the alignment\b|\b(chang|swap|switch|flip)\w*[^.]{0,20}\balignments?\b|\balignments?[^.]{0,15}\b(chang|swap|flip|switch)/i],
  ['Binary Info', SURE, /\blearns? (their|its|his|her|that player'?s|a player'?s|the player'?s) alignments?\b/i],
  ['Binary Info', HINT, /\b(learns?|told|nods?|shakes?)\b[^.]{0,25}\b(if|whether)\b|\byes or no\b|\byes\/no\b|\btrue or false\b/i],
  ['Character Change', SURE, /\bswap\w*[^.]{0,20}\bcharacters?\b|\bchange\w* (their|your|a player'?s?|that player'?s?) character\b/i],
  // "You become the Imp", not "you become the alignment of a neighbour".
  ['Character Change', SURE, /\b(you|they|that player|the player|a player|an? (evil|good) player|a minion|a townsfolk|an outsider) (might |may |also |then )?(becomes?|turns? into) (the|a|an|that|their|your|this|any|one|another|not-in-play|in-play)\b(?! (good|evil|drunk|poisoned|mad|safe|dead|alive|immune|sober|healthy|alignment|allignment|opposite alignment)\b)(?! \w+ alignment)/i],
  // Any subject: "a player becomes a Lab Rat", not "becomes a good player".
  ['Character Change', SURE, /\bbecomes? (a|an) (?!(good|evil|drunk|poisoned|mad|sober|healthy|safe|dead|alive|immune)\b)/i],
  ['Character Change', HINT, /\b(becomes?|turns? into)\b(?! (good|evil|drunk|poisoned|mad|safe|dead|sober|healthy|alive|immune))|\bchange\w* (their|your|a player'?s?|that player'?s?) character|\bswap\w*[^.]{0,20}\bcharacters?\b|\bnew character\b/i],
  ['Confirmation', SURE, /\blearns? (that )?you('re| are) the\b/i],
  ['Confirmation', HINT, /\bconfirm|\bprov(e|es|en)\b|\b(knows?|learns?) (that )?you are (the|good|not)\b|\ball (players )?know (who )?you\b|\beveryone knows\b|\bpublicly\b[^.]{0,40}\b(is|are) (good|evil)\b/i],
  ['Consult', SURE, /\b(visit|ask|tell|inform|consult|speak (to|with)|talk (to|with)) the storyteller\b|\bprivately (ask|visit|tell|speak|talk)/i],
  ['Day Deaths', SURE, /(?<!(can'?t|cannot|not|never|won'?t|don'?t) )\b(dies?|die) (immediately|at dusk)\b|\bimmediately (dies?|die)\b/i],
  ['Day Deaths', HINT, /\b(during the day|by day|today|at dusk|immediately)\b[^.]{0,40}\b(dies?|die|killed)\b|\b(dies?|die|killed)\b[^.]{0,30}\b(during the day|today|immediately|at dusk|at any time)\b|\bmay choose to die\b/i],
  ['Death', SURE, /\bdies?\b|\bdied\b|\bdying\b|\bdead\b|\bdeaths?\b|\bkill/i],
  ['Death Modification', SURE, /\bregisters? as (alive|dead)\b/i],
  ['Death Modification', HINT, /\b(do(es)? ?n[o']t|can ?no?t|can't|cannot|won'?t|never|might not) die\b|\b(dies?|die) instead\b|\binstead\b[^.]{0,20}\b(dies?|die)\b|\bsurviv|\bregisters? as (alive|dead)\b|\b(you|they) live\b|\btargeted instead\b|\bwould (die|be killed)\b/i],
  // The owner's ruling: being killed by the Demon or at night.
  ['Demonsbane', SURE, /\b(if|when) (the|a) demon (kills|attacks|chooses) you\b|(?<!even )\b(if|when|once) you (would |might )?(die|are killed|get killed) (at night|in the night|by night|during the night)\b|\byou (would |might )?(die|are killed|were killed|died|get killed) (at night|in the night|by night|during the night)\b(?<!even if you (die|are killed|get killed) \w+ night)/i],
  ['Demonsbane', HINT, /\bif (the|a) demon (kills|attacks|chooses|targets) you|\bif you (die|are killed) (at night|by the demon|tonight)|\bkilled by (the|a) demon\b/i],
  ['Drunkenness', SURE, /\bdrunk/i],
  ['Duplication', SURE, /\[[^\]]*\+0 to \+\d+ (?!(outsiders?|minions?|townsfolk|demons?|travell?ers?|evil|good|players?|fabled|lorics?)\b)\w|\bsame character\b/i],
  // Copies of itself: "[+0 to +2 Legionary]" on the Legionary, "other Hydras".
  ['Duplication', HINT, (t, c) => (String(c.name || '').length > 2 &&
    new RegExp('\\[[^\\]]*[+±][^\\]]*\\b' + reEsc(c.name) + '|\\b(other|another|all|every) ' + reEsc(c.name) + 's?\\b', 'i').test(t)) ||
    /\bcop(y|ies) of (you|yourself|itself|this character)\b|\bmore than one of you\b/i.test(t)],
  ['Even If Dead', SURE, /\beven (if|when|while|though) (you'?re |you are |you'?ve |you have |you |they )?(dead|die|died)\b|\b(while|if|once|when) (you are |you'?re )?dead\b/i],
  ['Execution', SURE, /\bexecut/i],
  ['Execution Failure', SURE, /\bexecutions? fails?\b/i],
  ['Execution Failure', HINT, /\bexecutions? (fails?|is cancelled)|\b(nobody|no one) is executed|\bno execution|\b(can'?t|cannot|can not) be executed/i],
  ['Execution Survival', SURE, /\b(do(es)? ?n[o']t|would(n'?t| not)|cannot|can'?t|won'?t|might not) die\b[^.]{0,40}\bexecut|\bexecut\w*[^.]{0,40}\b(do(es)? ?n[o']t|not|n't|might not) die\b|\bsurviv\w*[^.]{0,20}execution/i],
  ['Execution Survival', HINT, /\b(do(es)? ?n[o']t|would(n'?t| not)|cannot|can'?t|won'?t|might not) die\b[^.]{0,40}\bexecut|\bexecut\w*[^.]{0,40}\b(do(es)? ?n[o']t|not|n't|might not) die\b|\bsurviv\w*[^.]{0,20}execution|\bexecut\w*[^.]{0,30}\b(you|they) live\b/i],
  ['Extra Evil', SURE, /\[[^\]]*[+]\s*\d+\s*(evil )?(minion|demon)s?\b/i],
  ['Extra Evil', HINT, /\b(an? )?(extra|additional|another) (evil|minion|demon)\b|\b(becomes?|turns?|made) evil\b|\bevil (townsfolk|outsider|traveller)\b/i],
  ['False Info', SURE, /\bfalse\b|\bmisinformation\b/i],
  ['False Info', HINT, /\bmight be (wrong|incorrect)|\bincorrect\b|\bwrong (info|information|answer)\b|\breversed info/i],
  ['Grim Peeker', SURE, /\bgrimoire\b|\bthe grim\b/i],
  ['Grim Peeker', HINT, /\breminder tokens?\b|\blearn (every|all|each)\b[^.]{0,25}\bcharacters?\b/i],
  ['Hidden', SURE, /\byou (think|do not know|don'?t know)\b[^.]{0,20}\b(you'?re|you are)\b/i, ['outsider']],
  ['Hidden', HINT, /\bhid(e|es|den|ing)\b|\bcovert|\bthinks? (you are|you're|they are) (a|an|the) |\b(don'?t|do not|does ?n[o']t) (know|learn) (you|they|that)\b|\bnot on the sheet\b|\bif (the demon|evil|minions?|a minion|an evil player) (guesses|learns|finds|kills) you\b/i, ['outsider']],
  ['Information', SURE, /\byou (may |might |also )?(privately |secretly |publicly )?learn\b|\byou (know|are told|are shown)\b|\byou start knowing\b|^(each|on your|once per|at) [^:.]*,? learn\b|\b(choos|pick|select|guess)\w*\b[^.:]{0,60}?(&|\band\b|,|:) ?(privately |secretly )?learn(ing|s)?\b/i],
  ['Information', HINT, /\b(tells|shows) you\b|\byou (are told|are shown|see|know)\b|(^|[.:,] ?)learn\b/i],
  ['Loud', SURE, /\ball (players )?(learn|know)\b|\beveryone (learns|knows)\b|\bannounc/i],
  ['Loud', HINT, /\bannounce|\bdeclar|\beveryone (learns|knows|is told|hears|sees)|\ball (players )?(learn|know)\b|\bthe (whole )?(town|group) (learns|is told|knows)|\bpublicly (learn|told|revealed|announced)|\bout loud\b|\baloud\b/i],
  ['Madness', SURE, /\bmad(ness)?\b/i],
  // Not "the Storyteller may" or "arbitrary": on tagged pages those are mostly
  // a prompt, a tie-break or random info, and Magic on few of them.
  ['Magic', SURE, /\b(make|makes|made|making|grants?|granted|grant)\b[^.]{0,25}\bwish(es)?\b|\bwish(es)? (made|is granted|are granted|might come true|come true)\b|\bwishes\b/i],
  ['Magic', HINT, /\bspells?\b|\bcurses?\b|\bwish(es)?\b|\binvoke\b|\bstoryteller (offers|(will|can|may|might) break)\b|\bsomething (good|bad) happens\b/i],
  ['Misregistration', SURE, /\bregister(s|ed|ing)?\b|\bregistration\b/i],
  ['Misregistration', HINT, /\b(might )?(show|appear)s? as\b|\bappears? to be\b/i],
  ['Multi-Kill', SURE, /\bchoose (2|3|two|three|up to (\d|two|three)) (living |alive )?players:? they (all |both )?die\b|\b(2|3|two|three) players die\b|\b(both|all) (of them )?die\b/i],
  ['Multi-Kill', HINT, /\bchoose (2|3|two|three|up to (\d|two|three)|any number of|\d+) (living |alive )?players?\b[^.]{0,30}\b(die|dies|kill)|\b(they both|they all|both|all of them) die\b|\bkills? (2|3|two|three|\d+) players\b|\banother player (also )?dies\b|\b(choose|kill) (an )?additional\b/i],
  ['Neighbor', SURE, /\bneighbou?r/i],
  ['Neighbor', HINT, /\bnext to\b|\bsat beside\b|\badjacent\b|\b(anti-?|counter-?)?clockwise\b|\bto your (left|right)\b|\bseated\b/i],
  ['Nominations', SURE, /\bnominat/i],
  ['Nonconformist', SURE, /\bunlisted\b|\b(break|breaks|breaking|broke) the rules?\b|\b(new|extra) rules?\b/i],
  ['Nonconformist', HINT, /\bthe rules?\b|\banything goes\b|\bnot on the sheet\b|\bno demon\b|\bmore than one demon|\bgame (continues|does not end|doesn'?t end)\b|\bstoryteller (dies|is executed|can be executed|may break)\b/i],
  ['On Death', SURE, /\b(learns?|learned|that) you died\b|\bif you died (today|tonight|yesterday)\b|(?<!even )\b(if|when|after|once) you die\b|(?<!even )\b(if|when) you are (executed|killed)\b|\bupon (your )?death\b|\b(if|when) (the|a) demon kills you\b/i],
  ['On Death', HINT, /\b(if|when|after|once|each time) (a|an|the|any|your|another|that|their|every) [^.]{0,30}\b(dies|die|died|is executed|is killed)\b/i],
  ['Once Per Game', SURE, /\bonce,? per game\b|\bonly once\b|\bonce during the game\b|\(once\b/i],
  ['Outsider Modification', SURE, /\[[^\]]*\d[^\]]*\boutsiders?\b|\[[^\]]*\b(no|extra|fewer|more|all) outsiders?\b/i],
  // Nothing to choose, wake for, guess, visit or learn: always on.
  ['Passive', SURE, t => !/\b(choos\w*|chosen|pick\w*|guess\w*|may|visit\w*|ask|nominat\w*|public\w*|claim\w*|wakes?|each (night|day)|once|learn\w*|start knowing)\b/i.test(t)],
  // Someone else privately learns of it. "All players learn" is Loud instead.
  ['Ping', SURE, /\b(a|the|that|each|any|\d+|one|two) (good|evil) players? (also )?(learns?|knows?|is told|are told)\b|\b(the |all |each |any |\d+ )?(minions?|demons?|evil players|good players|evil team|townsfolk|outsiders) (also |each )?(learns?|knows?|is told|are told)\b/i],
  ['Ping', HINT, /(?<!public\w* [^.]{0,30})\b(they|a (good |evil )?player|that player|the demon|minions?|evil players?|good players?|townsfolk|outsiders?) (also |each )?(learns?|knows?|is told|are told|start knowing)\b|\bknow each other\b|\bknows? you are\b/i],
  ['Poison', SURE, /\bpoison/i],
  ['Protection', SURE, /\bprotect/i],
  ['Protection', HINT, /\bprotect|\bsafe from (death|dying|the demon)|\b(can ?no?t|can't|won'?t|do(es)? ?n[o']t) die\b/i],
  ['Public', SURE, /\bpublic(ly)?\b|\bin front of everyone\b|\bout loud\b|\baloud\b/i],
  ['Quiet', HINT, /\bsecret|\bcovert|\bno one (else )?(learns|knows)|\bnobody (learns|knows)|\bunaware|\bwithout (anyone|them|the player) (knowing|learning)|\bpoison|\bdrunk/i, EVIL],
  // "raised" only as a body is raised, never a hand.
  ['Resurrection', SURE, /\bresurrect|\b(rise|rises|risen|rising)\b|\breborn\b|\bregurgitat|\b(is|are|be|was|were|gets?|get) raised\b(?! (their|a|the|your) hand)|\braised from\b|\bback to life|\breviv(e|es|ed)\b|\b(becomes?|is|are) alive again\b|\bno longer dead\b|\breturns? to life/i],
  // The owner's ruling: the word itself is the tag.
  ['Reverse', SURE, /\brevers/i],
  ['Reverse', HINT, /\bopposite\b|\binvert|\bundo(es|ne)?\b/i],
  ['Safe', SURE, /\bsafe\b/i],
  ['Safety Net', SURE, /\b(a|another|the|an evil|one) minion becomes the (new )?demon\b|\bif (the|a) demon (dies|would die)\b/i],
  ['Safety Net', HINT, /\b(5|five) or more (players|non-travellers|alive)\b|\bif (the|a) demon (dies|would die|is executed)\b|\bif (there is no|no) demon\b|\b(evil|good) would (win|lose)\b|\bgame would end\b|\bbecomes? the (new )?demon\b/i],
  ['Setup', SURE, /\[[^\]]+\]|\bset-?up\b/i],
  ['Single-Kill', SURE, /\bchoose a (living |alive |dead |good |evil )?player[:,]? they die\b/i],
  ['Single-Kill', HINT, /\b(kills?|kill) (a|one) player\b|\bchoose a player[^.]{0,30}\bthey die\b/i],
  ['Sober & Healthy', SURE, /\bsober\b|\bhealthy\b/i],
  ['Social', SURE, /\b(speak\w*|spoke|talk\w*|whisper\w*|silen\w*|eye contact|hand signals?|wink\w*|clap\w*|sing|sings|singing|sang|songs?|hug|hugs|hugged|hugging|point(s|ing)? at)\b/i],
  ['Social', HINT, /\b(talk|speak|whisper|silen|mute|conversation|wink|clap|sing|hug|hand signal|eye contact|point at|discuss|agree|gender)\w*/i],
  ['Subjective Info', SURE, /\badvice\b|\bclues?\b|\bhints?\b|\blearn something\b|\bstoryteller('s)? (thinks|believes|think|believe)\b/i],
  ['Subjective Info', HINT, /\bstoryteller('s)? (choice|discretion|decides|judge|thinks|opinion)|\b(most|least|best) (beneficial|helpful|interesting|important|suspicious|likely|responsible)\b|\bhelped (your team )?the most\b|\bhints?\b|\bclues?\b|\badvice\b|\briddle|\brelated to\b/i],
  // "thinks" on its own too, but "the Storyteller thinks" is Subjective Info.
  ['Think', SURE, /\b(you|they|he|she) (think|thinks|believe|believes) (you|they|he|she|it) (are|is|were)\b|\bthinks? (they are|it is|you are|he is|she is|you're|they're|it's)\b|\bmight think\b|(?<!storyteller )\bthinks\b/i],
  ['Think', HINT, /\bthinks?\b|\bbelieves?\b/i],
  ['Timer', SURE, t => String(t).split(/[.!?]\s/).some(x => /\b(wins?|loses?)\b/i.test(x) &&
    /\b(after|on|by|before|until|at) (the end of )?(day|night|dusk|dawn) (\d+|two|three|four|five|six|x)\b|\b(after|by|on|in) (\d+|two|three|four|five|six|x) (days|nights)\b|\b(\d+(st|nd|rd|th)|third|fourth|fifth|sixth|final) (day|night)\b/i.test(x))],
  ['True Info', SURE, /\btrue info|\btrue information\b/i],
  ['True Info', HINT, /\btrue\b|\bcorrect\b|\baccurate/i],
  ['Votes', SURE, /\bvot(e|es|ed|ing|er|ers)\b|\bmajority\b/i],
  // A keyword (the owner's ruling): any win or lose wording, except losing
  // an ability, a vote or a token, which is not about the game's outcome.
  ['Win/Loss Condition', SURE, /\b(wins?|winning|winners?|loses?|losing|losers?|victory)\b(?! (their|its|your|an?|the|this|that|his|her|all) (abilit|vote|token|ghost))|\bgame ends\b|\bend(s|ing)? the game\b/i],
  ['You Start Knowing', SURE, /\bstarts? (the game )?knowing\b/i],
];

/* Which cues this character's ability trips: {sure: [tag], hint: [{tag, words}]}.
   A sure tag is never also a hint, and a kill that escalates or doubles is
   Multi-Kill, so it does not also count as a sure Single-Kill. */
export function cueTags(char) {
  const text = String(char.ability || ''), team = String(char.team || '').toLowerCase();
  const sure = new Set(), hint = new Map();
  for (const [tag, level, test, teams] of CUES) {
    if (teams && !teams.includes(team)) continue;
    if (typeof test === 'function') { if (test(text, char)) (level === SURE ? sure.add(tag) : hint.set(tag, hint.get(tag) || '')); continue; }
    const m = text.match(test);
    if (!m) continue;
    if (level === SURE) sure.add(tag); else if (!hint.get(tag)) hint.set(tag, m[0]);
  }
  if (hint.has('Multi-Kill') && sure.delete('Single-Kill')) hint.set('Single-Kill', hint.get('Single-Kill') || '');
  for (const t of sure) hint.delete(t);
  return { sure: [...sure], hint: [...hint].map(([tag, words]) => ({ tag, words })) };
}

export const splitTags = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const words = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
  .split(/\s+/).filter(w => w.length > 2));

/* The tagged rows whose ability shares the most (rare) words with this one.
   ponytail: a linear scan of ~2,000 rows per call, a few ms; move to
   embeddings + Vectorize if it ever shows up in a profile. */
export function pickExamples(char, rows, k = EXAMPLES) {
  const same = r => (char.slug && r.slug === char.slug) || (char.name && String(r.name || '').toLowerCase() === String(char.name).toLowerCase());
  const tagged = rows.map(officialPage).filter(r => r.ability && splitTags(r.tags).length && !same(r))
    .concat(OFFICIAL_ROWS.filter(r => !same(r)));
  const df = new Map();
  const sets = tagged.map(r => { const s = words(r.ability); s.forEach(w => df.set(w, (df.get(w) || 0) + 1)); return s; });
  const mine = words(char.ability);
  const ranked = tagged.map((r, i) => {
    let score = 0;
    mine.forEach(w => { if (sets[i].has(w)) score += Math.log(1 + tagged.length / df.get(w)); });
    // A page an admin checked by hand is the surest example of all.
    return [r.checked ? score * 1.5 : score, r];
  }).filter(x => x[0] > 0).sort((a, b) => b[0] - a[0]);
  const off = ranked.filter(x => x[1].official).slice(0, Math.min(OFFICIAL_EXAMPLES, k));
  const rest = ranked.filter(x => !x[1].official).slice(0, k - off.length);
  return [...off, ...rest].sort((a, b) => b[0] - a[0]).map(x => x[1]);
}

/* A wiki page that is a Chinese-edition official character (Temple Fair, The
   Storm Is Coming) counts as an official example, with the official tags
   added to its own. "Limited uses" only means Once Per Game when it says once. */
function officialPage(r) {
  if (r.checked) return r;
  const extra = OFFICIAL_WIKI_TAGS[r.slug];
  if (!extra || !Object.hasOwn(OFFICIAL_WIKI_TAGS, r.slug)) return r;
  const add = splitTags(extra).filter(t => t !== 'Once Per Game' || /\bonce\b/i.test(r.ability || ''));
  return { ...r, tags: [...new Set([...splitTags(r.tags), ...add])].join(', '), official: true };
}

/* An example's tags as the model is shown them: its own, plus what the sure
   cues say, so the examples follow the owner's wording rulings (Death on any
   death, Setup on any [bracket]) even where its taggers missed one. */
export function exampleTags(r) {
  // Checked by hand: those ARE its tags, and the cues were already overruled.
  if (r.checked) return splitTags(r.tags).filter(t => BY_LOWER.has(t.toLowerCase()));
  return [...new Set([...splitTags(r.tags), ...cueTags(r).sure])].filter(t => BY_LOWER.has(t.toLowerCase()));
}

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

export function buildMessages(char, examples) {
  const list = SUGGESTABLE.map(t => '- ' + t + ': ' + Tags.describeTag(t)).join('\n');
  const ex = examples.map(r => 'Character: ' + clip(r.name, 80) + ' (' + r.team + (r.checked ? ', checked' : r.official ? ', official' : '') + ')\nAbility: ' +
    clip(r.ability, 400) + '\nTags: ' + exampleTags(r).join(', ')).join('\n\n');
  const cues = cueTags(char);
  const cueLine = (cues.sure.length ? '\nAlready certain from its wording (do not repeat): ' + cues.sure.join(', ') + '.' : '') +
    (cues.hint.length ? '\nWording that may point to a tag (keep one only if it really applies): ' +
      cues.hint.map(h => h.tag + (h.words ? ' ("' + clip(h.words, 40) + '")' : '')).join(', ') + '.' : '');
  const extra = [char.lede, ...(Array.isArray(char.summaryBullets) ? char.summaryBullets : [])]
    .map(s => clip(s, 300)).filter(Boolean).join(' ');
  return [
    { role: 'system', content:
      'You tag homebrew characters for a Blood on the Clocktower wiki. Choose only tags from this list ' +
      'that clearly apply to the character\'s ability. Most characters have 2 to 5 tags.\n\n' + list +
      '\n\nAnswer with JSON only, like {"tags": ["Information", "Neighbor"]}.' },
    { role: 'user', content:
      (ex ? 'Characters already tagged (tags marked checked or official are the most reliable):\n\n' + ex + '\n\nNow this one:\n' : '') + 'Character: ' + clip(char.name, 80) +
      ' (' + clip(char.team, 20) + ')\nAbility: ' + clip(char.ability, 600) +
      (extra ? '\nAbout it: ' + clip(extra, 900) : '') + cueLine + '\nTags:' }
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

/* The model's answer plus the sure cues. With no model to ask (the binding
   is off, it failed, or the scorer asked for model 'phrases') the sure cues
   are the answer on their own, so the button still helps. */
// $ per million tokens [input, output], from Cloudflare's Workers AI price
// list. A model not listed is charged as if it were an expensive one, so a
// typo in the dashboard's model box can never be the cheap path.
export const AI_PRICES = {
  '@cf/google/gemma-4-26b-a4b-it': [0.10, 0.30],
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': [0.293, 2.253],
  '@cf/meta/llama-3.1-70b-instruct-fp8-fast': [0.293, 2.253],
};
const UNLISTED_PRICE = [1.5, 5];
export const aiPrice = model => AI_PRICES[String(model).replace(/:think$/, '')] || UNLISTED_PRICE;
export const aiMaxTokens = model => /:think$/.test(model) ? 1500 : 300;

// meter(model, {prompt_tokens, completion_tokens}) is told what each call
// used; the Worker turns it into dollars for its daily ceiling.
export async function suggestTags(env, char, rows, model = AUTOTAG_MODEL, meter) {
  const sure = cueTags(char).sure;
  let picked = [];
  if (model !== 'phrases') {
    try {
      if (!env.AI) throw Object.assign(new Error('Tag suggestions are not switched on yet.'), { public: true });
      // Thinking off: it is most of the wait, for an answer that is one short
      // list. "model:think" turns it back on, so the scorer can compare.
      const think = /:think$/.test(model), name = model.replace(/:think$/, '');
      // temperature 0: the same character gets the same answer every press,
      // so a change in the dashboard's scores is a real change, not chance.
      const opts = { messages: buildMessages(char, pickExamples(char, rows)), max_tokens: aiMaxTokens(model), temperature: 0 };
      if (/gemma-4/.test(name)) opts.chat_template_kwargs = { enable_thinking: think };
      let out;
      try { out = await env.AI.run(name, opts); }
      finally {
        // No usage on the answer (or no answer): charge the most it could
        // have been, a token per 3 characters of prompt and the full reply.
        const u = out && out.usage;
        if (meter) meter(model, u && u.prompt_tokens != null ? u
          : { prompt_tokens: Math.ceil(JSON.stringify(opts.messages).length / 3), completion_tokens: opts.max_tokens });
      }
      const text = typeof out === 'string' ? out
        : out && (out.response ?? (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content));
      picked = parseTags(typeof text === 'string' ? text : JSON.stringify(text || ''));
    } catch (e) {
      if (!sure.length) throw e;
    }
  }
  return [...new Set([...sure, ...picked])];
}

/* The admins' answer key (the dashboard's "Check tags"): slug -> the tags a
   person confirmed. Those rows take the checked tags in place of their own,
   which makes them the examples the model is shown first. */
export function applyChecks(rows, checks) {
  if (!checks || !checks.size) return rows;
  return rows.map(r => checks.has(r.slug) ? { ...r, tags: checks.get(r.slug).join(', '), checked: true } : r);
}
