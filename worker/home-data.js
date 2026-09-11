import Classify from '../assets/classify.js';
import Creators from '../assets/creators.js';
import PageRender from '../assets/render-page.js';

// Daily creator rotation is computed once on the server, independent of viewer.
    function featuredRng(seed){
      var s = (seed >>> 0) || 1;
      return function(){
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
      };
    }
    function featuredShuffle(arr, rand){
      var a = arr.slice();
      for (var i = a.length - 1; i > 0; i--){
        var j = Math.floor(rand() * (i + 1));
        var t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    }
    function featuredHash(str){
      var h = 2166136261;
      for (var i = 0; i < str.length; i++){
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return h >>> 0;
    }
    function featuredPick(list, day){
      // Partial pages stay off the front page (eligible), and a featured card
      // is a picture and a paragraph — a page with neither has nothing to show
      // here. An uncredited page is skipped too: this rotation is a turn for
      // each creator, and a page with no creator is nobody's turn.
      var pool = Classify.eligible(list).filter(function(c){
        return c.name && c.art && (c.lede || c.quote || c.ability) &&
               Creators.splitCreators(c.creator).length;
      });
      if (!pool.length) return null;
      // A credit can name several people ("Taiyi, Saki") and each of them is
      // their own creator page, so each of them gets their own turn — and the
      // page they share can be drawn under either name. Keyed case-folded so
      // one creator with two spellings is one creator; the display name is
      // whichever spelling was seen first.
      var byKey = {}, keys = [];
      pool.forEach(function(c){
        Creators.splitCreators(c.creator).forEach(function(nm){
          var k = nm.toLowerCase();
          if (!byKey[k]) { byKey[k] = []; keys.push(k); }
          byKey[k].push(c);
        });
      });
      keys.sort();   // the shuffle is the randomness; the input has to be stable
      var n = keys.length;
      function blockOrder(b){
        return featuredShuffle(keys, featuredRng(Math.imul(b + 1, 2654435761)));
      }
      var block = Math.floor(day / n), pos = day % n;
      var today = blockOrder(block);
      // The seam: yesterday was the last name of the previous block.
      if (n > 2){
        var prev = blockOrder(block - 1)[n - 1];
        if (today[0] === prev){ var t = today[0]; today[0] = today[1]; today[1] = t; }
      }
      var key = n === 2 ? keys[day % 2] : today[pos];
      // Which of that creator's characters — Curata pages still surface more
      // often here, which is all the weighting was ever meant to do.
      return Classify.weightedPick(byKey[key], featuredRng(Math.imul(day, 40503) ^ featuredHash(key)));
    }


export { featuredPick };
function icons(list) {
  const art = list.filter(c => c.art), result = [], teams = new Set();
  for (const c of art) if (!teams.has(c.team) && result.length < 4) { result.push(c); teams.add(c.team); }
  for (const c of art) if (!result.includes(c) && result.length < 4) result.push(c);
  return result.map(c => ({ art: c.art, v: c.v }));
}
function pick(row, keys) {
  return Object.fromEntries(keys.filter(k => row[k] !== undefined).map(k => [k, row[k]]));
}
const tileFields = ['id','slug','displayName','name','author','tagline','header','logo','curata','v'];
const cardFields = ['slug','page','name','team','art','image','v','curata','curataFrom'];
export function homeData(characters, collections, scripts, day) {
  const creators = new Set(), tags = new Set();
  for (const c of characters) {
    for (const creator of Creators.splitCreators(c.creator)) creators.add(creator);
    for (const tag of String(c.tags || '').split(',')) if (tag.trim()) tags.add(tag.trim().toLowerCase());
  }
  const groups = collections.map(c => {
    const members = PageRender.resolveCollectionMembers(c, characters);
    return { ...pick(c, tileFields), count: members.length, icons: icons(members) };
  }).filter(c => c.count);
  const featured = featuredPick(characters, day);
  return {
    stats: { characters: characters.length, collections: groups.length, scripts: scripts.length,
      creators: creators.size, tags: tags.size, jinxed: characters.filter(c => c.jinxes?.length).length },
    collections: groups, scripts: scripts.map(s => ({ ...pick(s, tileFields), count: (s.characters || []).length })),
    icons: icons(characters), recent: Classify.eligible(characters.slice().reverse()).slice(0, 8).map(c => pick(c, cardFields)),
    featured: featured ? pick(featured, [...cardFields, 'lede','quote','ability','creator','appearsIn']) : null
  };
}
