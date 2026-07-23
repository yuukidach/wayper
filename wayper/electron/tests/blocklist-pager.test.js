const assert = require('node:assert/strict');

global.window = global;
require('../blocklist-pager.js');

const pager = global.WayperBlocklistPager;
const entries = Array.from({ length: 10003 }, (_, index) => ({ filename: `image-${index}` }));
const state = pager.createState();

assert.equal(
    pager.sync(state, { sourceEntries: entries, searchMatches: null, tab: 'blocked' }),
    true,
);
assert.equal(pager.visibleCount(state, entries.length), 100);
assert.deepEqual(entries.slice(0, state.visibleCount).map(entry => entry.filename), [
    ...Array.from({ length: 100 }, (_, index) => `image-${index}`),
]);

const seen = new Set(entries.slice(0, state.visibleCount).map(entry => entry.filename));
while (state.visibleCount < entries.length) {
    const { start, end } = pager.loadMore(state, entries.length);
    for (const entry of entries.slice(start, end)) seen.add(entry.filename);
}
assert.equal(state.visibleCount, entries.length);
assert.equal(seen.size, entries.length);
assert.deepEqual([...seen].slice(-3), ['image-10000', 'image-10001', 'image-10002']);

const progressState = pager.createState();
pager.sync(progressState, { sourceEntries: entries, searchMatches: null, tab: 'blocked' });
pager.visibleCount(progressState, entries.length);
pager.loadMore(progressState, entries.length);
const refreshedEntries = entries.slice(0, -1);
pager.replaceSource(progressState, refreshedEntries, refreshedEntries.length);
assert.equal(progressState.visibleCount, 200);
assert.equal(progressState.sourceEntries, refreshedEntries);

assert.equal(
    pager.sync(state, { sourceEntries: entries, searchMatches: null, tab: 'blocked' }),
    false,
);
assert.equal(state.visibleCount, entries.length);

const searchMatches = new Set(['image-3']);
assert.equal(
    pager.sync(state, { sourceEntries: entries, searchMatches, tab: 'blocked' }),
    true,
);
assert.equal(state.visibleCount, 0);
assert.equal(pager.visibleCount(state, 1), 1);

assert.equal(
    pager.sync(state, { sourceEntries: entries, searchMatches, tab: 'recoverable' }),
    true,
);
assert.equal(state.visibleCount, 0);

console.log('blocklist pager tests passed');
