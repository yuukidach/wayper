const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function run() {
    let stream;
    let finishPrefetch;
    const calls = [];
    const cache = new Map([['old', {}]]);
    const requests = new Map();
    const context = {
        API_URL: 'http://127.0.0.1:45123',
        appState: { purity: ['sfw'] },
        document: { hidden: true },
        console,
        cache,
        requests,
        calls,
        fetch: () => new Promise(resolve => { finishPrefetch = resolve; }),
        EventSource: class { constructor() { stream = this; } },
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer-data.js'), 'utf8'), context);
    vm.runInContext(`
        libraryViewCache = () => cache;
        libraryPrefetchRequests = () => requests;
        libraryViewContextKey = (mode, orient) => mode + ':' + orient;
        imagePageUrl = () => '/api/images/page';
        invalidateBlocklistSuggestions = () => calls.push('blocklist');
        invalidateModelReviewCaches = () => calls.push('review');
        refreshImages = preserve => calls.push(['refresh', preserve]);
        fetchMonitors = () => calls.push('monitors');
        connectSSE();
    `, context);

    const pending = context.prefetchLibraryView('favorites', 'landscape');
    assert.equal(requests.size, 1);
    stream.onmessage({ data: JSON.stringify({ type: 'library' }) });
    assert.equal(cache.size, 0);
    assert.equal(requests.size, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), ['blocklist', 'review', ['refresh', true]],
        'a global hotkey must refresh hidden windows immediately, even if counts stay equal');

    finishPrefetch({ ok: true, json: async () => ({ items: [{ path: 'stale.jpg' }] }) });
    assert.equal(await pending, false);
    assert.equal(cache.size, 0, 'an older prefetch must not restore invalidated images');

    stream.onmessage({ data: JSON.stringify({ type: 'wallpaper' }) });
    assert.equal(calls.at(-1), 'monitors');
    console.log('hotkey event tests passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
