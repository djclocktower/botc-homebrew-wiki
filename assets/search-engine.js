/* Shared by the browser search Worker and Node tests. No dependencies or DOM. */
(function (root) {
  'use strict';
  var folds = { 'ø': 'o', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'ı': 'i', 'ħ': 'h' };
  function normalize(value) {
    return String(value || '').normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '')
      .replace(/[øłđðþæœßıħ]/g, function (c) { return folds[c]; })
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  }
  function words(value) { return normalize(value).split(' ').filter(Boolean); }
  function grams(word, size) {
    var result = new Set();
    for (var i = 0; i <= word.length - size; i++) result.add(word.slice(i, i + size));
    return result;
  }
  // Bounded optimal-string-alignment distance, including adjacent transpositions.
  function distance(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit) return limit + 1;
    var prev = Array.from({ length: b.length + 1 }, function (_, i) { return i; }), before;
    for (var i = 1; i <= a.length; i++) {
      var next = [i], minimum = i;
      for (var j = 1; j <= b.length; j++) {
        next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (before && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) next[j] = Math.min(next[j], before[j - 2] + 1);
        minimum = Math.min(minimum, next[j]);
      }
      if (minimum > limit) return limit + 1;
      before = prev; prev = next;
    }
    return prev[b.length];
  }
  function Index(documents) {
    this.documents = documents;
    this.postings = new Map(); this.grams = new Map(); this.cache = new Map();
    this.titles = []; this.filters = [];
    var facets = { creator: new Set(), tag: new Set(), set: new Set() };
    var self = this;
    documents.forEach(function (doc, id) {
      self.titles[id] = normalize(doc.title);
      var creators = doc.creators || (doc.creator ? [doc.creator] : []);
      self.filters[id] = { creator: creators.map(normalize), tag: (doc.tags || []).map(normalize), set: (doc.sets || []).map(normalize) };
      creators.forEach(function (x) { facets.creator.add(x); });
      (doc.tags || []).forEach(function (x) { facets.tag.add(x); });
      (doc.sets || []).forEach(function (x) { facets.set.add(x); });
      var tokens = new Map();
      [[doc.title, 12], [doc.creator, 6], [(doc.tags || []).join(' '), 6], [(doc.sets || []).join(' '), 5],
        [doc.summary, 3], [doc.terms, 1]].forEach(function (field) {
        words(field[0]).forEach(function (word) { tokens.set(word, Math.max(tokens.get(word) || 0, field[1])); });
      });
      tokens.forEach(function (weight, word) {
        if (!self.postings.has(word)) self.postings.set(word, []);
        self.postings.get(word).push([id, weight]);
      });
    });
    this.postings.forEach(function (_, word) {
      [1, 2].forEach(function (size) {
        grams(word, size).forEach(function (g) {
          if (!self.grams.has(g)) self.grams.set(g, new Set());
          self.grams.get(g).add(word);
        });
      });
    });
    this.facets = {};
    Object.keys(facets).forEach(function (key) {
      self.facets[key] = Array.from(facets[key]).sort(function (a, b) { return a.localeCompare(b); });
    });
  }
  Index.prototype.matchToken = function (token) {
    if (this.cache.has(token)) return this.cache.get(token);
    var self = this, matches = new Map(), candidates = new Set(), parts = grams(token, token.length > 1 ? 2 : 1);
    var smallest = null;
    parts.forEach(function (g) {
      var entries = self.grams.get(g) || new Set();
      if (smallest === null || entries.size < smallest.size) smallest = entries;
      entries.forEach(function (word) { candidates.add(word); });
    });
    var exact = new Set();
    (smallest || []).forEach(function (word) { if (word.includes(token)) exact.add(word); });
    // Four-letter transpositions may have no shared bigram (abcd -> acbd).
    if (token.length >= 4) for (var i = 0; i < token.length - 1; i++) {
      var swapped = token.slice(0, i) + token[i + 1] + token[i] + token.slice(i + 2);
      if (this.postings.has(swapped)) candidates.add(swapped);
    }
    var limit = token.length >= 8 ? 2 : token.length >= 4 ? 1 : 0;
    function add(word, factor) {
      self.postings.get(word).forEach(function (pair) {
        matches.set(pair[0], Math.max(matches.get(pair[0]) || 0, pair[1] * factor));
      });
    }
    exact.forEach(function (word) { add(word, word === token ? 4 : word.startsWith(token) ? 3 : 2); });
    if (limit && token.length <= 32) candidates.forEach(function (word) {
      if (!exact.has(word) && distance(token, word, limit) <= limit) add(word, 1);
    });
    if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(token, matches);
    return matches;
  };
  Index.prototype.search = function (options) {
    options = options || {};
    var self = this, q = normalize(String(options.q || '').slice(0, 200));
    var tokens = Array.from(new Set(q.split(' ').filter(Boolean))), scores;
    tokens.forEach(function (token) {
      var matches = self.matchToken(token);
      if (!scores) scores = new Map(matches);
      else scores.forEach(function (score, id) {
        if (!matches.has(id)) scores.delete(id); else scores.set(id, score + matches.get(id));
      });
    });
    if (!scores) scores = new Map(this.documents.map(function (_, id) { return [id, 0]; }));
    var rows = [], counts = { all: 0 }, filtered = {};
    ['creator', 'tag', 'set'].forEach(function (key) { filtered[key] = normalize(options[key]); });
    scores.forEach(function (score, id) {
      var doc = self.documents[id], fields = self.filters[id];
      if (options.team && doc.team !== options.team) return;
      if (options.status === 'curata' && !doc.curata) return;
      if (options.status && options.status !== 'curata' && doc.classification !== options.status) return;
      if (Object.keys(filtered).some(function (key) { return filtered[key] && !fields[key].includes(filtered[key]); })) return;
      counts.all++; counts[doc.type] = (counts[doc.type] || 0) + 1;
      if (options.type && options.type !== 'all' && options.type !== doc.type) return;
      if (q && self.titles[id] === q) score += 1000;
      else if (q && self.titles[id].startsWith(q)) score += 400;
      else if (q && self.titles[id].includes(q)) score += 200;
      rows.push({ id: id, score: score });
    });
    rows.sort(function (a, b) {
      var rank = options.sort === 'name' ? 0 : b.score - a.score;
      return rank || self.titles[a.id].localeCompare(self.titles[b.id]) || a.id - b.id;
    });
    var limit = Math.max(1, Math.min(50, Number(options.limit) || 30));
    var page = Math.max(1, Math.min(Math.ceil(rows.length / limit) || 1, Math.floor(Number(options.page) || 1)));
    return { total: rows.length, counts: counts, page: page, pages: Math.ceil(rows.length / limit),
      results: rows.slice((page - 1) * limit, page * limit).map(function (row) {
        var doc = self.documents[row.id], result = {};
        Object.keys(doc).forEach(function (key) { if (key !== 'terms') result[key] = doc[key]; });
        return result;
      }) };
  };
  root.BotcSearchEngine = { normalize: normalize, Index: Index, distance: distance };
})(typeof self !== 'undefined' ? self : globalThis);
