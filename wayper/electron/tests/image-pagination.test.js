const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRendererData(context, exportedNames) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'renderer-data.js'), 'utf8');
    const exportsSource = `\nglobalThis.__testExports = { ${exportedNames.join(', ')} };`;
    vm.createContext(context);
    vm.runInContext(source + exportsSource, context, { filename: 'renderer-data.js' });
    return context.__testExports;
}

async function flushPromises() {
    await new Promise(resolve => setImmediate(resolve));
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

async function testRefreshPublishesStatusBeforeSlowPage() {
    const pending = [];
    const state = makeState();
    state.status = { auto_rotation: false, rotation_paused: false, pool_count: 1 };
    let statusUpdates = 0;
    const context = makeContext(
        state,
        url => new Promise(resolve => pending.push({ url, resolve })),
    );
    context.updateStatusUI = () => { statusUpdates++; };
    const renderer = loadRendererData(context, ['refreshImages']);

    let refreshFinished = false;
    const refresh = renderer.refreshImages().then(() => { refreshFinished = true; });
    const statusRequest = pending.find(request => request.url.includes('/api/status'));
    const pageRequest = pending.find(request => request.url.includes('/api/images/page'));
    assert.ok(statusRequest && pageRequest);

    statusRequest.resolve({
        ok: true,
        json: async () => ({
            auto_rotation: false,
            rotation_paused: false,
            monitor: 'DP-2',
            orientation: 'portrait',
            pool_count: 42,
            favorites_count: 7,
            blocklist_count: 3,
            model_review_count: 0,
            mode: ['sfw'],
        }),
    });
    await flushPromises();

    assert.equal(state.status.pool_count, 42);
    assert.equal(statusUpdates, 1);
    assert.equal(refreshFinished, false, 'the gallery page should still be pending');

    pageRequest.resolve({
        ok: true,
        json: async () => ({ items: [], total: 0, next_offset: null }),
    });
    await refresh;
}

function testLibraryViewRestoresSynchronously() {
    const state = makeState();
    state.allImages = [{ path: 'portrait-a.jpg' }, { path: 'portrait-b.jpg' }];
    state.images = [...state.allImages];
    state.totalImages = 2;
    state.nextOffset = null;
    state.imagesComplete = true;
    state.currentBatchIndex = 2;
    state.loadedImageMode = 'pool';
    state.loadedImageContextKey = JSON.stringify({
        mode: 'pool', purities: ['sfw'], orient: 'portrait',
    });
    let renders = 0;
    const context = makeContext(state, async () => ({ ok: false, status: 500 }));
    context.renderImages = () => { renders++; };
    const renderer = loadRendererData(
        context,
        ['cacheCurrentLibraryView', 'restoreLibraryView'],
    );

    assert.equal(renderer.cacheCurrentLibraryView(), true);
    state.allImages = [];
    state.images = [];
    state.currentBatchIndex = 0;

    assert.equal(renderer.restoreLibraryView('pool', 'portrait'), true);
    assert.equal(state.images.map(image => image.path).join(','), 'portrait-a.jpg,portrait-b.jpg');
    assert.equal(state.currentBatchIndex, 0, 'the restored grid should render from its first card');
    assert.equal(renders, 1, 'cached cards should paint before network revalidation');
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

(async () => {
    await testRefreshLocksPageZeroAgainstObserverRace();
    await testRepeatedPageCannotDuplicatePaths();
    await testRefreshPublishesStatusBeforeSlowPage();
    testLibraryViewRestoresSynchronously();
    await testBlocklistShowsLoadingAndRecoversFromApiFailure();
    await testMonitorPollingUpdatesOrientationAndHandlesReconnect();
    console.log('image pagination tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
