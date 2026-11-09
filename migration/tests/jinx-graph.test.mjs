import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { layoutInput, computeLayout } = createRequire(import.meta.url)('../../assets/jinx-graph.js');

// Twelve characters in a ring, with two chords.
const ids = Array.from({ length: 12 }, (_, i) => 'c:n' + i);
const data = {
  nodes: ids.map(id => ({ id })),
  edges: ids.map((id, i) => ({ a: id, b: ids[(i + 1) % 12] }))
    .concat([{ a: ids[0], b: ids[6] }, { a: ids[3], b: ids[9] }, { a: ids[2], b: 'c:gone' }, { a: ids[4], b: ids[4] }])
};

test('the jinx map layout runs from its own source and gives the same map for the same jinxes', () => {
  const input = layoutInput(data);
  assert.equal(input.links.length, 28, 'a line to a missing character, or to itself, is left out');
  const here = computeLayout(input);
  // The page posts this function's SOURCE to a worker: it may use nothing
  // from the file around it.
  const alone = new Function('return (' + computeLayout + ')')()(input);
  assert.deepEqual(alone, here);
  assert.equal(here.length, 24);
  assert.ok(here.every(Number.isFinite));
  // People find things on the map by where they were last time. A change
  // here redraws the whole map for everybody: make it on purpose.
  assert.deepEqual(here.slice(0, 4), [42.48, 0.33, -173.67, 78.68]);
});
