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

(async () => {
    await testRefreshLocksPageZeroAgainstObserverRace();
    await testRepeatedPageCannotDuplicatePaths();
    await testRefreshPublishesStatusBeforeSlowPage();
    console.log('image pagination tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
