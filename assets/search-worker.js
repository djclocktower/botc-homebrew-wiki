/* The index and all matching stay off the main thread. */
var indexPromise;
function ensureIndex(engineURL) {
  if (indexPromise) return indexPromise;
  indexPromise = Promise.resolve().then(function () {
    if (!self.BotcSearchEngine) importScripts(engineURL);
    return fetch('/api/search-index', { credentials: 'omit' });
  }).then(function (response) {
    if (!response.ok) throw new Error('Could not load search.');
    return response.json();
  }).then(function (data) {
    if (data.schema !== 1 || !Array.isArray(data.documents)) throw new Error('Invalid search index.');
    return new self.BotcSearchEngine.Index(data.documents);
  }).catch(function (error) { indexPromise = null; throw error; });
  return indexPromise;
}
self.onmessage = function (event) {
  var message = event.data;
  ensureIndex(message.engineURL).then(function (index) {
    self.postMessage({ id: message.id, result: message.options ? index.search(message.options) : { facets: index.facets } });
  }).catch(function () { self.postMessage({ id: message.id, error: 'Could not load search. Try again.' }); });
};
