const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function loadRendererScript(filename, context, exportedNames) {
    Object.assign(context, { AbortController, setTimeout, clearTimeout });
    const source = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    const exportsSource = `\nglobalThis.__testExports = { ${exportedNames.join(', ')} };`;
    vm.createContext(context);
    vm.runInContext(source + exportsSource, context, { filename });
    return context.__testExports;
}

async function flushPromises() {
    await new Promise(resolve => setImmediate(resolve));
}

async function testStatusRequestsStayScopedToSelectedMonitor() {
    const pending = [];
    const context = {
        API_URL: 'http://127.0.0.1:8080',
        appState: {
            selectedMonitor: 'DP-1',
            monitors: [
                { name: 'DP-1', orientation: 'landscape' },
                { name: 'DP-2', orientation: 'portrait' },
            ],
            currentOrient: 'landscape',
            statusRequestId: 0,
            purity: ['sfw'],
            mode: 'pool',
            refreshing: true,
            status: {
                auto_rotation: true,
                rotation_paused: false,
                pool_count: 0,
                favorites_count: 0,
                blocklist_count: 0,
                model_review_count: 0,
            },
        },
        console,
        fetch: url => new Promise(resolve => pending.push({ url, resolve })),
        updateStatusUI: () => {},
        updateUI: () => {},
        refreshImages: () => {},
        isModelReviewMode: () => false,
    };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-data.js',
        context,
        ['fetchStatus', 'statusUrl'],
    );

    const oldRequest = renderer.fetchStatus();
    context.appState.selectedMonitor = 'DP-2';
    const currentRequest = renderer.fetchStatus();
    assert.match(
        renderer.statusUrl({ monitor: 'DP-2', orient: 'portrait' }),
        /monitor=DP-2/,
    );

    const current = pending.find(item => item.url.includes('monitor=DP-2'));
    const old = pending.find(item => item.url.includes('monitor=DP-1'));
    assert.ok(current && old, 'both monitor-scoped status requests should be sent');
    current.resolve({
        ok: true,
        json: async () => ({
            auto_rotation: true,
            rotation_paused: false,
            monitor: 'DP-2',
            orientation: 'portrait',
            pool_count: 20,
            favorites_count: 2,
            blocklist_count: 0,
            model_review_count: 1,
            mode: ['sfw'],
        }),
    });
    await currentRequest;

    old.resolve({
        ok: true,
        json: async () => ({
            auto_rotation: true,
            rotation_paused: false,
            monitor: 'DP-1',
            orientation: 'landscape',
            pool_count: 10,
            favorites_count: 1,
            blocklist_count: 0,
            model_review_count: 9,
            mode: ['sfw'],
        }),
    });
    await oldRequest;

    assert.equal(context.appState.status.monitor, 'DP-2');
    assert.equal(context.appState.status.pool_count, 20);
    assert.equal(context.appState.status.model_review_count, 1);
}

async function testManualDislikeUsesDistinctFeedbackEndpoint() {
    let requestUrl = null;
    let requestBody = null;
    const replacements = [];
    const focusedAction = {};
    let focusedNeighbor = false;
    let removed = false;
    const nextCard = {
        dataset: { path: 'sfw/landscape/next.jpg' },
        classList: { contains: name => name === 'wallpaper-card' },
        focus: options => {
            focusedNeighbor = options?.preventScroll === true;
        },
    };
    const removedCard = {
        dataset: { path: 'sfw/landscape/missed.jpg' },
        classList: { contains: name => name === 'wallpaper-card' },
        contains: element => element === focusedAction,
        nextElementSibling: nextCard,
        previousElementSibling: null,
        remove: () => { removed = true; },
    };
    const context = {
        API_URL: 'http://127.0.0.1:8080',
        appState: {
            mode: 'pool',
            allImages: [{ path: 'sfw/landscape/missed.jpg' }],
            images: [{ path: 'sfw/landscape/missed.jpg' }],
            currentBatchIndex: 0,
            status: { pool_count: 2, favorites_count: 0, blocklist_count: 1 },
            modelReviewRecommendationCache: new Map(),
            modelReviewRecommendationRequests: new Map(),
        },
        document: {
            activeElement: focusedAction,
            querySelectorAll: selector => selector === '.wallpaper-card'
                ? [removedCard, nextCard]
                : [],
        },
        console,
        renderBlocklistSuggestionsBar: () => {},
        updateStatusUI: () => {},
        renderImages: () => {},
        refreshImages: () => {},
        applyMonitorCurrentImages: value => replacements.push(value),
        fetch: async (url, options) => {
            requestUrl = url;
            requestBody = JSON.parse(options.body);
            return { ok: true, json: async () => ({ replacement_images: { main: 'next.jpg' } }) };
        },
    };
    context.window = context;

    const renderer = loadRendererScript('renderer-data.js', context, ['dislikeImage']);
    assert.equal(await renderer.dislikeImage('sfw/landscape/missed.jpg'), true);
    assert.equal(requestUrl, 'http://127.0.0.1:8080/api/image/dislike');
    assert.deepEqual(requestBody, { image_path: 'sfw/landscape/missed.jpg' });
    assert.equal(context.appState.status.pool_count, 1);
    assert.equal(context.appState.status.blocklist_count, 2);
    assert.deepEqual(replacements, [{ main: 'next.jpg' }]);
    assert.equal(removed, true);
    assert.equal(focusedNeighbor, true, 'focus should move from the action to the next card');
}

async function testInboxRoutesDecisionsByCandidateSource() {
    const held = {
        path: '.model-review/sfw/landscape/held.jpg',
        name: 'held.jpg',
        auto_filtered: true,
    };
    const keepRecommendation = {
        path: 'sfw/landscape/keep.jpg',
        name: 'keep.jpg',
    };
    const banRecommendation = {
        path: 'sfw/landscape/ban.jpg',
        name: 'ban.jpg',
    };
    const modelActions = [];
    const feedbackActions = [];
    const banActions = [];
    const context = {
        appState: {
            mode: 'model-review',
            modelReviewData: {
                items: [held],
                recommendations: [keepRecommendation, banRecommendation],
                pending_count: 1,
                recommendation_count: 2,
            },
            modelReviewSelectedPath: held.path,
            modelReviewResolvedPaths: new Set(),
            modelReviewActionInFlight: new Set(),
            status: {
                model_review_count: 1,
                pool_count: 10,
                blocklist_count: 4,
            },
        },
        alert: () => {},
        CSS: { escape: value => value },
        console,
        els: {
            wallpaperGrid: { querySelector: () => null },
        },
        WayperApi: {
            modelReviewAction: async (path, action) => {
                modelActions.push([path, action]);
                return {
                    status: 'ok',
                    review: { new_path: 'sfw/landscape/held.jpg' },
                };
            },
            preferenceFeedback: async (path, action) => {
                feedbackActions.push([path, action]);
                return { status: 'ok', learning: { pending_feedback: 2 } };
            },
        },
        banImage: async (path, options) => {
            banActions.push([path, options]);
            return { status: 'ok', learning: { pending_feedback: 3 } };
        },
    };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-views.js',
        context,
        ['resolveModelReviewDecision'],
    );
    context.updateStatusUI = () => {};
    context.renderModelReviewView = () => {};

    assert.equal(await renderer.resolveModelReviewDecision(held, 'keep'), true);
    context.appState.modelReviewSelectedPath = keepRecommendation.path;
    assert.equal(await renderer.resolveModelReviewDecision(keepRecommendation, 'keep'), true);
    assert.equal(await renderer.resolveModelReviewDecision(banRecommendation, 'ban'), true);

    assert.deepEqual(modelActions, [[held.path, 'keep']]);
    assert.deepEqual(feedbackActions, [[keepRecommendation.path, 'keep']]);
    assert.equal(banActions.length, 1);
    assert.equal(banActions[0][0], banRecommendation.path);
    assert.equal(banActions[0][1].preserveView, true);
    assert.equal(banActions[0][1].preferenceContext, 'model_review');
    assert.equal(banActions[0][1].returnResult, true);
    assert.equal(context.appState.status.model_review_count, 0);
    assert.equal(context.appState.status.pool_count, 11);
    assert.equal(context.appState.status.blocklist_count, 4);
    assert.equal(context.appState.modelReviewSource, 'recommended');
}

async function testClearHeldFiltersQueueWithoutReviewDecisions() {
    const classes = new Set();
    const classList = {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
        toggle: (name, force) => {
            if (force === false) classes.delete(name);
            else classes.add(name);
        },
    };
    const heldA = {
        path: '.model-review/sfw/landscape/a.jpg',
        name: 'a.jpg',
        auto_filtered: true,
    };
    const heldB = {
        path: '.model-review/sfw/landscape/b.jpg',
        name: 'b.jpg',
        auto_filtered: true,
    };
    const recommendation = {
        path: 'sfw/landscape/recommended.jpg',
        name: 'recommended.jpg',
    };
    const requests = [];
    let renders = 0;
    let statusUpdates = 0;
    const deck = {
        classList,
        setAttribute: () => {},
        querySelectorAll: () => [],
        querySelector: () => null,
    };
    const context = {
        appState: {
            mode: 'model-review',
            purity: ['sfw'],
            currentOrient: 'landscape',
            modelReviewData: {
                items: [heldA, heldB],
                recommendations: [recommendation],
                pending_count: 2,
                recommendation_count: 1,
            },
            modelReviewSource: 'held',
            modelReviewSelectedPath: heldA.path,
            modelReviewResolvedPaths: new Set(),
            modelReviewClearInFlight: false,
            status: {
                model_review_count: 2,
                blocklist_count: 4,
                pool_count: 10,
            },
        },
        alert: message => { throw new Error(`unexpected alert: ${message}`); },
        CSS: { escape: value => value },
        console,
        els: {
            wallpaperGrid: {
                querySelector: selector => selector === '.model-review-deck' ? deck : null,
            },
        },
        WayperApi: {
            clearModelReview: async (...args) => {
                requests.push(args);
                return {
                    status: 'ok',
                    cleared_count: 2,
                    cleared_paths: [heldA.path, heldB.path],
                    failed_count: 0,
                    remaining_count: 0,
                };
            },
        },
        cacheCurrentModelReviewContext: () => {},
        reconcileModelReviewSelection: data => {
            context.appState.modelReviewSource = 'recommended';
            context.appState.modelReviewSelectedPath = data.recommendations[0].path;
        },
    };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-views.js',
        context,
        ['clearHeldModelReviewItems'],
    );
    context.updateStatusUI = () => { statusUpdates++; };
    context.renderModelReviewView = () => { renders++; };

    assert.equal(await renderer.clearHeldModelReviewItems(), true);
    assert.equal(JSON.stringify(requests), JSON.stringify([[['sfw'], 'landscape']]));
    assert.deepEqual(context.appState.modelReviewData.items, []);
    assert.deepEqual(context.appState.modelReviewData.recommendations, [recommendation]);
    assert.equal(context.appState.modelReviewData.pending_count, 0);
    assert.equal(context.appState.status.model_review_count, 0);
    assert.equal(context.appState.status.blocklist_count, 6);
    assert.equal(context.appState.status.pool_count, 10);
    assert.equal(context.appState.modelReviewSource, 'recommended');
    assert.equal(context.appState.modelReviewSelectedPath, recommendation.path);
    assert.equal(context.appState.modelReviewResolvedPaths.has(heldA.path), true);
    assert.equal(context.appState.modelReviewResolvedPaths.has(heldB.path), true);
    assert.equal(context.appState.modelReviewClearInFlight, false);
    assert.equal(statusUpdates, 1);
    assert.equal(renders, 1);
}

async function testHeldCardsRenderBeforeRecommendationRankingFinishes() {
    const held = {
        path: '.model-review/sfw/landscape/held.jpg',
        auto_filtered: true,
    };
    const recommendation = { path: 'sfw/landscape/recommended.jpg', rank: 1 };
    let resolveRecommendations;
    let renders = 0;
    const context = {
        appState: {
            mode: 'model-review',
            purity: ['sfw'],
            currentOrient: 'landscape',
            imageRequestId: 4,
            preferenceSuggestionRequestId: 0,
            config: { wallhaven: { filter_strategy: 'model' } },
        },
        console,
        isModelReviewMode: () => true,
        renderModelReviewView: () => { renders++; },
        WayperApi: {
            modelReview: async () => ({
                status: 'ready', items: [held], pending_count: 1,
            }),
            preferenceSuggestions: () => new Promise(resolve => {
                resolveRecommendations = resolve;
            }),
        },
    };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-data.js',
        context,
        ['fetchModelReview'],
    );

    const pending = renderer.fetchModelReview({ requestId: 4 });
    await flushPromises();

    assert.deepEqual(context.appState.modelReviewData.items, [held]);
    assert.equal(context.appState.modelReviewData.recommendation_status, 'pending');
    assert.equal(context.appState.modelReviewSelectedPath, held.path);
    assert.ok(renders >= 1);

    resolveRecommendations({
        status: 'ready',
        items: [recommendation],
        diagnostics: { candidate_count: 1 },
    });
    assert.equal(await pending, true);
    assert.deepEqual(context.appState.modelReviewData.recommendations, [recommendation]);
}

async function testLateModelReviewResponseCannotRemountDeckAfterLeaving() {
    let resolveHeld;
    let resolveRecommendations;
    let renders = 0;
    const context = {
        appState: {
            mode: 'model-review',
            purity: ['sfw'],
            currentOrient: 'landscape',
            imageRequestId: 9,
            preferenceSuggestionRequestId: 0,
            config: { wallhaven: { filter_strategy: 'model' } },
        },
        console,
        isModelReviewMode: () => context.appState.mode === 'model-review',
        renderModelReviewView: () => { renders++; },
        WayperApi: {
            modelReview: () => new Promise(resolve => { resolveHeld = resolve; }),
            preferenceSuggestions: () => new Promise(resolve => {
                resolveRecommendations = resolve;
            }),
        },
    };
    context.window = context;
    const renderer = loadRendererScript(
        'renderer-data.js',
        context,
        ['fetchModelReview'],
    );

    const pending = renderer.fetchModelReview({ requestId: 9 });
    assert.equal(renders, 1);

    context.appState.mode = 'pool';
    context.appState.imageRequestId = 10;
    resolveHeld({ status: 'ready', items: [], pending_count: 0 });
    resolveRecommendations({ status: 'ready', items: [] });

    assert.equal(await pending, false);
    assert.equal(renders, 1, 'a stale response must not mount the review workspace again');
}

test('status ignores stale monitor responses', testStatusRequestsStayScopedToSelectedMonitor);
test('manual dislike targets the exact image', testManualDislikeUsesDistinctFeedbackEndpoint);
test('review decisions use the correct endpoint', testInboxRoutesDecisionsByCandidateSource);
test('clearing held images does not label preferences', testClearHeldFiltersQueueWithoutReviewDecisions);
test('held images do not wait for ranking', testHeldCardsRenderBeforeRecommendationRankingFinishes);
test('late responses cannot reopen review', testLateModelReviewResponseCannotRemountDeckAfterLeaving);
