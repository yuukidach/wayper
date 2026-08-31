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

function makeClassList() {
    const values = new Set();
    return {
        add: value => values.add(value),
        remove: value => values.delete(value),
        contains: value => values.has(value),
    };
}

function makeContext() {
    let fullRenders = 0;
    let intermediateRenders = 0;
    const searchResponses = new Map([
        ['tags:red,blue', ['red-blue.jpg']],
        ['tags:red', ['red-blue.jpg', 'red.jpg']],
        ['uploader:alice', ['red.jpg']],
    ]);
    const context = {
        API_URL: 'http://127.0.0.1:8080',
        appState: {
            mode: 'trash',
            searchRequestId: 0,
            searchQuery: '',
            searchMatches: null,
            tagReview: null,
            reviewingUploader: null,
            tagSuggestions: [{ tag: 'red', count: 2 }],
            allImages: [
                { name: 'red-blue.jpg', path: 'red-blue.jpg' },
                { name: 'red.jpg', path: 'red.jpg' },
            ],
            images: [],
            imagesComplete: true,
        },
        els: {
            searchInput: { value: '' },
            searchClear: { classList: makeClassList() },
            searchDropdown: { classList: makeClassList() },
            searchCount: { textContent: '', classList: makeClassList() },
            mainContent: { scrollTop: 50 },
        },
        document: {
            querySelector: () => ({ classList: makeClassList() }),
        },
        console,
        renderImages: () => { intermediateRenders++; },
        renderBlocklistView: () => { fullRenders++; },
        WayperApi: {
            searchImages: async ({ tags = [], uploader = '' }) => ({
                matches: searchResponses.get(
                    tags.length ? `tags:${tags.join(',')}` : `uploader:${uploader}`,
                ) || [],
            }),
            tagSuggestions: async tags => ({
                suggestions: [{ tag: tags.length === 1 ? 'green' : 'yellow' }],
            }),
        },
    };
    context.window = context;
    context.renderCounts = () => ({ fullRenders, intermediateRenders });
    return context;
}

async function testEnteringComboRendersOnce() {
    const context = makeContext();
    context.appState.reviewingUploader = 'alice';
    const renderer = loadRendererData(context, ['enterTagReview']);

    await renderer.enterTagReview(['red', 'blue']);

    assert.deepEqual(context.renderCounts(), { fullRenders: 1, intermediateRenders: 0 });
    assert.equal(context.appState.searchQuery, 'red + blue');
    assert.equal(context.appState.images.length, 1);
    assert.equal(context.appState.tagReview.tags.join(','), 'red,blue');
    assert.equal(context.appState.tagReview.refinements[0].tag, 'yellow');
    assert.equal(context.appState.reviewingUploader, null);
    assert.equal(context.els.mainContent.scrollTop, 0);
}

async function testRemovingComboTagRendersOnce() {
    const context = makeContext();
    context.appState.tagReview = { tags: ['red', 'blue'], refinements: [] };
    const renderer = loadRendererData(context, ['navigateCombo']);

    await renderer.navigateCombo(['red']);

    assert.deepEqual(context.renderCounts(), { fullRenders: 1, intermediateRenders: 0 });
    assert.equal(context.appState.searchQuery, 'red');
    assert.equal(context.appState.images.length, 2);
    assert.equal(context.appState.tagReview.tags.join(','), 'red');
    assert.equal(context.appState.tagReview.refinements[0].tag, 'green');
}

async function testLateComboResponseCannotRepaintOlderContext() {
    const context = makeContext();
    const pendingSearches = new Map();
    context.WayperApi.searchImages = ({ tags }) => new Promise(resolve => {
        pendingSearches.set(tags.join(','), resolve);
    });
    const renderer = loadRendererData(context, ['navigateCombo']);

    const olderNavigation = renderer.navigateCombo(['red', 'blue']);
    const latestNavigation = renderer.navigateCombo(['red']);

    pendingSearches.get('red')({ matches: ['red-blue.jpg', 'red.jpg'] });
    assert.equal(await latestNavigation, true);

    pendingSearches.get('red,blue')({ matches: ['red-blue.jpg'] });
    assert.equal(await olderNavigation, false);

    assert.deepEqual(context.renderCounts(), { fullRenders: 1, intermediateRenders: 0 });
    assert.equal(context.appState.searchQuery, 'red');
    assert.equal(context.appState.images.length, 2);
    assert.equal(context.appState.tagReview.tags.join(','), 'red');
    assert.equal(context.appState.tagReview.refinements[0].tag, 'green');
}

async function testUploaderReviewAlsoRendersOnce() {
    const context = makeContext();
    context.appState.tagReview = { tags: ['red'], refinements: [] };
    const renderer = loadRendererData(context, ['enterUploaderReview']);

    assert.equal(await renderer.enterUploaderReview('alice'), true);

    assert.deepEqual(context.renderCounts(), { fullRenders: 1, intermediateRenders: 0 });
    assert.equal(context.appState.searchQuery, 'alice');
    assert.equal(context.appState.images.length, 1);
    assert.equal(context.appState.reviewingUploader, 'alice');
    assert.equal(context.appState.tagReview, null);
}

(async () => {
    await testEnteringComboRendersOnce();
    await testRemovingComboTagRendersOnce();
    await testLateComboResponseCannotRepaintOlderContext();
    await testUploaderReviewAlsoRendersOnce();
    console.log('combo navigation tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
