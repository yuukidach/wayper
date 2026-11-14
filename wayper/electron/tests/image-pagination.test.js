const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function loadRendererData(context, exportedNames) {
    Object.assign(context, { AbortController, setTimeout, clearTimeout });
    const source = fs.readFileSync(path.join(__dirname, '..', 'renderer-data.js'), 'utf8');
    const exportsSource = `\nglobalThis.__testExports = { ${exportedNames.join(', ')} };`;
    vm.createContext(context);
    vm.runInContext(source + exportsSource, context, { filename: 'renderer-data.js' });
    return context.__testExports;
}

function makeState() {
    return {
        selectedMonitor: 'DP-2',
        monitors: [{ name: 'DP-2', orientation: 'portrait' }],
        mode: 'pool',
        purity: ['sfw'],
        currentOrient: 'portrait',
        searchMatches: null,
        allImages: [],
        images: [],
        pageSize: 2,
        currentBatchIndex: 0,
        totalImages: 0,
        nextOffset: null,
        imagesComplete: false,
        loadingMoreImages: false,
        initialImagePageRequestId: null,
        imageRequestId: 0,
        refreshing: false,
    };
}

function makeContext(state, fetch) {
    const context = {
        API_URL: 'http://127.0.0.1:8080',
        appState: state,
        console,
        fetch,
        els: {
            mainContent: { scrollTop: 0 },
            wallpaperGrid: { querySelectorAll: () => [] },
        },
        isModelReviewMode: () => false,
        libraryViewContextKey: (mode, orient) => `${mode}:${orient}`,
        updateStatusUI: () => {},
        renderImages: () => {},
        renderNextBatch: () => {},
    };
    context.window = context;
    return context;
}

async function testRefreshLocksPageZeroAgainstObserverRace() {
    const pending = [];
    const state = makeState();
    state.currentBatchIndex = 1;
    const context = makeContext(state, url => new Promise(resolve => pending.push({ url, resolve })));
    const renderer = loadRendererData(context, ['refreshImages', 'loadMoreImages']);

    const refresh = renderer.refreshImages(true);
    assert.equal(state.initialImagePageRequestId, state.imageRequestId);
    assert.equal(pending.filter(request => request.url.includes('/api/images/page')).length, 1);

    assert.equal(await renderer.loadMoreImages(), false);
    assert.equal(
        pending.filter(request => request.url.includes('/api/images/page')).length,
        1,
        'the observed sentinel must not start a second page-zero request',
    );

    for (const request of pending) {
        if (request.url.includes('/api/status')) {
            request.resolve({
                ok: true,
                json: async () => ({ orientation: 'portrait', pool_count: 2 }),
            });
        } else {
            request.resolve({
                ok: true,
                json: async () => ({
                    items: [{ path: 'first.jpg' }, { path: 'second.jpg' }],
                    total: 2,
                    next_offset: null,
                }),
            });
        }
    }
    await refresh;

    assert.equal(state.initialImagePageRequestId, null);
    assert.equal(state.images.map(image => image.path).join(','), 'first.jpg,second.jpg');
}

async function testRepeatedPageCannotDuplicatePaths() {
    const state = makeState();
    state.allImages = [{ path: 'first.jpg' }];
    state.images = [{ path: 'first.jpg' }];
    state.nextOffset = 1;
    const context = makeContext(state, async () => ({
        ok: true,
        json: async () => ({
            items: [{ path: 'first.jpg' }, { path: 'second.jpg' }],
            total: 2,
            next_offset: null,
        }),
    }));
    const renderer = loadRendererData(context, ['loadMoreImages']);

    assert.equal(await renderer.loadMoreImages({ render: false }), true);
    assert.equal(state.allImages.map(image => image.path).join(','), 'first.jpg,second.jpg');
    assert.equal(state.images.map(image => image.path).join(','), 'first.jpg,second.jpg');
}

async function testBlocklistShowsLoadingAndRecoversFromApiFailure() {
    for (const failingEndpoint of ['/api/blocklist', '/api/images/page']) {
        const pending = [];
        const state = makeState();
        state.mode = 'trash';
        state.loadedImageMode = 'pool';
        state.images = [{ path: 'pool-image.jpg' }];
        state.blocklistPager = {};
        state.blocklistData = { entries: [{ filename: 'saved.jpg' }], total: 1 };
        const cached = state.blocklistData;
        const paints = [];
        const context = makeContext(state, url => new Promise(resolve => pending.push({ url, resolve })));
        // HTTP failures are deliberate in this recovery test.
        context.console = { ...console, error() {} };
        context.els.wallpaperGrid.querySelector = () => null;
        context.renderBlocklistView = () => paints.push({
            loading: state.blocklistLoading,
            error: state.blocklistError,
            images: state.images.length,
        });
        context.renderBlocklistSuggestionsBar = () => {};
        const renderer = loadRendererData(context, ['refreshImages']);
        vm.runInContext(`
            fetchTagSuggestions = async () => {};
            fetchStatus = async () => {};
            applySearchFilter = async () => { appState.images = appState.allImages; };
        `, context);

        const refresh = renderer.refreshImages();
        assert.equal(paints[0].loading, true, 'Blocklist should paint before its APIs respond');
        assert.equal(paints[0].images, 0, 'Pool images must not appear as recoverable files');
        for (const request of pending.splice(0)) {
            request.resolve({ ok: false, status: 500 });
        }
        await refresh;
        assert.equal(state.blocklistLoading, false);
        assert.equal(state.blocklistError, 'HTTP 500');
        assert.equal(state.blocklistData, cached, 'failed requests must preserve cached records');

        const retry = renderer.refreshImages();
        assert.equal(state.blocklistError, null);
        for (const request of pending.splice(0)) {
            request.resolve({
                ok: !request.url.includes(failingEndpoint), status: 503,
                json: async () => request.url.includes('/api/blocklist')
                    ? { entries: [], total: 0, recoverable_count: 0 }
                    : { items: [], total: 0, next_offset: null },
            });
        }
        await retry;
        assert.equal(state.blocklistError, 'HTTP 503', 'either endpoint failing must show retry');

        const success = renderer.refreshImages();
        for (const request of pending.splice(0)) {
            request.resolve({ ok: true, json: async () => request.url.includes('/api/blocklist')
                ? { entries: [], total: 0, recoverable_count: 0 }
                : { items: [], total: 0, next_offset: null } });
        }
        await success;
        assert.equal(state.blocklistLoading, false);
        assert.equal(state.blocklistError, null);
        assert.equal(state.refreshing, false);
        assert.equal(state.loadedImageMode, 'trash');
    }
}

async function testMonitorPollingUpdatesOrientationAndHandlesReconnect() {
    const state = makeState();
    state.monitors = [{ name: 'DP-2', orientation: 'portrait' }];
    let monitors = [{ name: 'DP-2', orientation: 'landscape' }];
    const requests = [];
    let renders = 0;
    const context = makeContext(state, async url => {
        requests.push(url);
        return { ok: true, json: async () => {
            if (url.includes('/api/monitors')) return monitors;
            if (url.includes('/api/status')) return {};
            return {
                items: [{ path: `sfw/${state.currentOrient}/current.jpg` }],
                total: 1,
                next_offset: null,
            };
        } };
    });
    context.renderMonitors = () => { renders += 1; };
    context.markCurrentWallpaper = () => {};
    const renderer = loadRendererData(context, ['fetchMonitors']);

    await renderer.fetchMonitors();
    assert.equal(state.currentOrient, 'landscape');
    assert.equal(state.images[0].path, 'sfw/landscape/current.jpg');
    assert.ok(requests.some(url => url.includes('/api/images/page') && url.includes('orient=landscape')));

    requests.length = 0;
    await renderer.fetchMonitors();
    assert.equal(renders, 1, 'unchanged monitor polls must preserve sidebar focus');
    assert.equal(requests.length, 1, 'unchanged direction must not reload the gallery');

    monitors = [{ name: 'DP-3', orientation: 'portrait' }];
    await renderer.fetchMonitors();
    assert.equal(state.selectedMonitor, 'DP-3');
    assert.equal(state.currentOrient, 'portrait');
    assert.equal(state.images[0].path, 'sfw/portrait/current.jpg');
}

test('refresh coalesces page-zero requests', testRefreshLocksPageZeroAgainstObserverRace);
test('repeated pages do not duplicate images', testRepeatedPageCannotDuplicatePaths);
test('blocklist preserves data and recovers after failure', testBlocklistShowsLoadingAndRecoversFromApiFailure);
test('monitor changes reload the matching orientation', testMonitorPollingUpdatesOrientationAndHandlesReconnect);

test('the library loads without monitors and follows the first recovered display', async () => {
    const state = makeState();
    state.selectedMonitor = null;
    state.monitors = [];
    state.currentOrient = '';
    let monitors = [];
    const pages = [];
    const context = makeContext(state, async url => {
        if (url.includes('/api/monitors')) return { ok: true, json: async () => monitors };
        if (url.includes('/api/status')) return { ok: true, json: async () => ({}) };
        pages.push(url);
        return { ok: true, json: async () => ({
            items: [{ path: 'sfw/portrait/local.jpg' }], total: 1, next_offset: null,
        }) };
    });
    context.renderMonitors = () => {};
    context.markCurrentWallpaper = () => {};
    const renderer = loadRendererData(context, ['refreshImages', 'fetchMonitors']);

    await renderer.fetchMonitors();
    await renderer.refreshImages();
    assert.equal(state.images.length, 1);
    assert.match(pages[0], /orient=&/);

    monitors = [{ name: 'DISPLAY1', orientation: 'portrait' }];
    await renderer.fetchMonitors();
    assert.equal(state.selectedMonitor, 'DISPLAY1');
    assert.equal(state.currentOrient, 'portrait');
    assert.equal(pages.length, 2);
    assert.match(pages[1], /orient=portrait/);

    await renderer.fetchMonitors();
    assert.equal(pages.length, 2, 'an unchanged display must not reload the library');
});

for (const failure of ['network', 'http', 'invalid-page']) {
    test(`library preserves cards and recovers from ${failure} without count changes`, async () => {
        const state = makeState();
        const cached = [{ path: 'sfw/portrait/cached.jpg' }];
        state.allImages = [...cached];
        state.images = [...cached];
        let healthy = false;
        let pageRequests = 0;
        const context = makeContext(state, async url => {
            if (url.includes('/api/status')) {
                return { ok: true, json: async () => ({ pool_count: 1 }) };
            }
            pageRequests++;
            if (!healthy) {
                if (failure === 'network') throw new TypeError('Failed to fetch');
                return { ok: failure !== 'http', status: 503, json: async () => ({ detail: 'Failed' }) };
            }
            return { ok: true, json: async () => ({ items: cached, total: 1, next_offset: null }) };
        });
        context.console = { ...console, error() {} };
        const renderer = loadRendererData(context, ['refreshImages', 'retryLibraryLoad']);

        await renderer.refreshImages();
        assert.ok(state.libraryError);
        assert.equal(state.images[0].path, cached[0].path);
        assert.equal(state.allImages[0].path, cached[0].path);
        assert.equal(state.refreshing, false);
        assert.equal(state.libraryLoading, false);
        assert.equal(await renderer.retryLibraryLoad(state.libraryRetryAt - 1), false);
        assert.equal(pageRequests, 1);

        healthy = true;
        assert.equal(await renderer.retryLibraryLoad(state.libraryRetryAt), true);
        assert.equal(pageRequests, 2);
        assert.equal(state.libraryError, null);
        assert.equal(state.images.length, 1);
        assert.equal(await renderer.retryLibraryLoad(Infinity), false);
    });
}

test('a stale library failure cannot replace a newer successful view', async () => {
    const state = makeState();
    let rejectOld;
    const context = makeContext(state, async url => {
        if (url.includes('/api/status')) return { ok: true, json: async () => ({}) };
        if (url.includes('mode=pool')) return new Promise((_, reject) => { rejectOld = reject; });
        return { ok: true, json: async () => ({
            items: [{ path: 'favorites/portrait/current.jpg' }], total: 1, next_offset: null,
        }) };
    });
    context.console = { ...console, error() {} };
    const renderer = loadRendererData(context, ['refreshImages', 'retryLibraryLoad']);
    const old = renderer.refreshImages();
    state.mode = 'favorites';
    await renderer.refreshImages();
    rejectOld(new Error('Old pool request failed'));
    await old;
    assert.equal(state.images[0].path, 'favorites/portrait/current.jpg');
    assert.equal(state.libraryError, null);
    assert.equal(await renderer.retryLibraryLoad(Infinity), false);
});

for (const stalledPart of ['headers', 'body']) {
    test(`library reads time out on stalled ${stalledPart} and can be retried`, async () => {
        let signal;
        let healthy = false;
        const context = makeContext(makeState(), async (_url, options) => {
            signal = options.signal;
            if (healthy) return { ok: true, json: async () => ({ items: [] }) };
            const pending = new Promise(() => {});
            return stalledPart === 'headers' ? pending : { ok: true, json: () => pending };
        });
        const renderer = loadRendererData(context, ['readLibraryJson']);
        await assert.rejects(renderer.readLibraryJson('/images', { timeoutMs: 10 }), /timed out/);
        assert.equal(signal.aborted, true);
        healthy = true;
        const page = await renderer.readLibraryJson('/images');
        assert.equal(page.items.length, 0);
    });
}
