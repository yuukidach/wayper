const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('startup shows the library while monitor detection and disk statistics are stalled', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'renderer-state.js'), 'utf8');
    const init = source.slice(source.indexOf('async function init()'), source.indexOf('function setupEventListeners()'));
    let loading = false;
    let displayed = false;
    let retries = 0;
    const intervals = [];
    const context = {
        console,
        window: { electronAPI: { getApiPort: async () => 45123 } },
        appState: { config: {} },
        document: { hidden: false },
        showLoader() { loading = true; },
        hideLoader() { loading = false; },
        setupEventListeners() {}, setupInfiniteScroll() {}, setupBlocklistInfiniteScroll() {},
        setupResponsiveLayoutTracking() {}, scheduleResponsiveLayout() {}, connectSSE() {},
        fetchConfig: async () => true,
        fetchMonitors: () => new Promise(() => {}),
        fetchDiskUsage: () => new Promise(() => {}),
        fetchStatus: () => new Promise(() => {}),
        refreshImages: async () => { displayed = true; },
        retryLibraryLoad: async () => { retries++; },
        prefetchLibraryViews: async () => {}, prefetchModelReviewRecommendations() {},
        checkForAppUpdates() {},
        setInterval(callback, ms) { intervals.push({ callback, ms }); },
    };
    vm.createContext(context);
    vm.runInContext(init, context);
    let timer;
    try {
        await Promise.race([
            context.init(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Startup waited for an auxiliary request')), 500);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
    assert.equal(displayed, true);
    assert.equal(loading, false);
    const poll = intervals.find(interval => interval.ms === 10000);
    assert.ok(poll);
    poll.callback();
    assert.equal(retries, 1, 'recovery must run even when monitors and status cannot respond');
});
