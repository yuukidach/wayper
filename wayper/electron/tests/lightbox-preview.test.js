const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadLightbox(context, exportedNames) {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'renderer-lightbox.js'),
        'utf8',
    );
    const exportsSource = `\nglobalThis.__testExports = { ${exportedNames.join(', ')} };`;
    vm.createContext(context);
    vm.runInContext(source + exportsSource, context, { filename: 'renderer-lightbox.js' });
    return context.__testExports;
}

function testPoolUsesScreenSizedPreview() {
    const context = {
        appState: { mode: 'pool' },
        imageUrl: imagePath => `full:${imagePath}`,
        modelReviewPreviewUrl: imagePath => `preview:${imagePath}`,
    };
    context.window = context;
    const lightbox = loadLightbox(
        context,
        ['lightboxIsTrash', 'lightboxPreviewSource'],
    );
    const image = { path: 'sfw/landscape/wallhaven-test.jpg' };

    assert.equal(lightbox.lightboxIsTrash(image), false);
    assert.equal(lightbox.lightboxPreviewSource(image), `preview:${image.path}`);
}

function testTrashKeepsOriginalSource() {
    const context = {
        appState: { mode: 'pool' },
        imageUrl: imagePath => `full:${imagePath}`,
        modelReviewPreviewUrl: imagePath => `preview:${imagePath}`,
    };
    context.window = context;
    const lightbox = loadLightbox(
        context,
        ['lightboxIsTrash', 'lightboxPreviewSource'],
    );
    const image = { path: '__trash/wallhaven-test.jpg', isTrash: true };

    assert.equal(lightbox.lightboxIsTrash(image), true);
    assert.equal(lightbox.lightboxPreviewSource(image), `full:${image.path}`);
}

async function testFullImagePredecodeUsesBoundedLru() {
    const loaders = [];
    class FakeImage {
        constructor() {
            loaders.push(this);
        }

        async decode() {}

        set src(value) {
            this.source = value;
        }
    }
    const context = {
        appState: { mode: 'pool' },
        imageUrl: imagePath => `full:${imagePath}`,
        modelReviewPreviewUrl: imagePath => `preview:${imagePath}`,
        Image: FakeImage,
    };
    context.window = context;
    const lightbox = loadLightbox(
        context,
        ['preloadLightboxFullImage', 'lightboxFullImagePreloads'],
    );
    const entries = ['one', 'two', 'three', 'four'].map(pathName => (
        lightbox.preloadLightboxFullImage({ path: `${pathName}.jpg` })
    ));

    assert.equal(lightbox.lightboxFullImagePreloads.size, 3);
    assert.equal(await entries[0].ready, false, 'evicted decode should settle as unavailable');

    await loaders[3].onload();
    assert.equal(await entries[3].ready, true);
    assert.equal(entries[3].decoded, true);

    const reused = lightbox.preloadLightboxFullImage({ path: 'four.jpg' });
    assert.equal(reused, entries[3], 'a decoded original should be reused on click');
    assert.equal(loaders.length, 4, 'reusing an original must not start another decode');
}

(async () => {
    testPoolUsesScreenSizedPreview();
    testTrashKeepsOriginalSource();
    await testFullImagePredecodeUsesBoundedLru();
    console.log('lightbox preview tests passed');
})();
