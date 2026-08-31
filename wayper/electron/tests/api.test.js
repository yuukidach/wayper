const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function testSearchImagesBuildsOneEncodedRequest() {
    let captured = null;
    const signal = {};
    const context = {
        URLSearchParams,
        fetch: async (url, options) => {
            captured = { url, options };
            return { ok: true, json: async () => ({ matches: ['image.jpg'] }) };
        },
        window: { WayperAPI_URL: 'http://127.0.0.1:45123' },
    };
    vm.createContext(context);
    const source = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
    vm.runInContext(source, context, { filename: 'api.js' });

    const data = await context.window.WayperApi.searchImages({
        query: 'red sky',
        tags: ['blue', 'green'],
        uploader: 'alice',
        signal,
    });

    assert.equal(
        captured.url,
        'http://127.0.0.1:45123/api/search?q=red+sky&tags=blue%2Cgreen&uploader=alice',
    );
    assert.equal(captured.options.signal, signal);
    assert.equal(data.matches[0], 'image.jpg');
}

testSearchImagesBuildsOneEncodedRequest()
    .then(() => console.log('api tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
