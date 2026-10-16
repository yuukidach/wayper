const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function loadScript(name, context) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context);
}

test('greeter API posts the selected image without a monitor', async () => {
    let captured;
    const context = vm.createContext({
        window: { WayperAPI_URL: 'http://127.0.0.1:45123' },
        fetch: async (url, options) => {
            captured = { url, options };
            return { ok: true, json: async () => ({ status: 'ok' }) };
        },
    });
    loadScript('api.js', context);
    await context.window.WayperApi.setGreeter('sfw/landscape/chosen.jpg');
    assert.equal(captured.url, 'http://127.0.0.1:45123/api/greeter/set');
    assert.equal(captured.options.method, 'POST');
    assert.deepEqual(JSON.parse(captured.options.body), { image_path: 'sfw/landscape/chosen.jpg' });
});

test('renderer updates greeter state only on success and reports errors', async () => {
    const original = { available: true, fixed_image: null };
    const fixed = { available: true, fixed_image: 'chosen.jpg' };
    const alerts = [];
    const context = vm.createContext({
        window: {},
        appState: { config: { greeter: original } },
        alert: message => alerts.push(message),
        WayperApi: { setGreeter: async () => { throw new Error('Permission denied'); } },
    });
    loadScript('renderer-data.js', context);
    assert.equal(await context.setGreeter('chosen.jpg'), false);
    assert.equal(context.appState.config.greeter, original);
    assert.match(alerts[0], /Could not set login background: Permission denied/);
    context.WayperApi.setGreeter = async () => ({ greeter: fixed });
    assert.equal(await context.setGreeter('chosen.jpg'), true);
    assert.equal(context.appState.config.greeter, fixed);
});

function lightboxContext({ available = true, mode = 'pool' } = {}) {
    let root;
    function element() {
        return {
            style: {},
            dataset: {},
            classList: { add() {}, remove() {} },
            attributes: {},
            addEventListener() {},
            focus() {},
            setAttribute(name, value) { this.attributes[name] = value; },
            removeAttribute(name) { delete this.attributes[name]; },
            querySelector() { return element(); },
            querySelectorAll() { return this.buttons; },
            set innerHTML(html) {
                this.html = html;
                this.buttons = [...html.matchAll(/data-action="([^"]+)"/g)].map(match => {
                    const button = element();
                    button.dataset.action = match[1];
                    return button;
                });
            },
        };
    }
    const context = vm.createContext({
        appState: { mode, config: { greeter: { available } } },
        window: {},
        document: {
            body: { appendChild() {} },
            createElement() { root = element(); return root; },
        },
        ICONS: new Proxy({}, { get: () => () => '' }),
        setGreeter: async () => true,
        closed: 0,
    });
    loadScript('renderer-lightbox.js', context);
    vm.runInContext(`
        loadLightboxImage = () => {};
        resetZoom = () => {};
        closeLightbox = () => { closed++; };
    `, context);
    return { context, root: () => root };
}

for (const options of [
    { available: false },
    { mode: 'trash' },
    { reviewOnly: true },
]) {
    test(`greeter action is hidden for ${JSON.stringify(options)}`, () => {
        const { context, root } = lightboxContext(options);
        context.showLightbox({ path: 'one.jpg', reviewOnly: options.reviewOnly });
        assert.equal(root().buttons.some(button => button.dataset.action === 'greeter'), false);
    });
}

test('greeter button has a compact label, login icon and descriptive accessible name', () => {
    const { context, root } = lightboxContext();
    const state = fs.readFileSync(path.join(__dirname, '..', 'renderer-state.js'), 'utf8');
    const iconDefinitions = state.slice(state.indexOf('const ICONS ='), state.indexOf('// Wallhaven helpers'));
    vm.runInContext(`${iconDefinitions}\nglobalThis.ICONS = ICONS;`, context);
    context.showLightbox({ path: 'one.jpg' });
    const markup = root().html.match(/<button[^>]*data-action="greeter"[\s\S]*?<\/button>/)[0];
    assert.match(markup, /<span>Greeter<\/span>/);
    assert.match(markup, /title="Set as Login Background"/);
    assert.match(markup, /aria-label="Set as Login Background"/);
    assert.match(markup, /<svg width="18" height="18"[^>]*aria-hidden="true"[^>]*><path /);

    const translations = vm.createContext({ window: {} });
    loadScript('i18n.js', translations);
    assert.equal(translations.window.WayperI18n.dictionaries.zh.Greeter, '登录背景');
});

test('lightbox action uses the current selection, blocks duplicates and stays open on failure', async () => {
    const { context, root } = lightboxContext();
    context.showLightbox({ path: 'first.jpg' });
    const button = root().buttons.find(item => item.dataset.action === 'greeter');
    assert.ok(button);
    context.showLightbox({ path: 'second.jpg' });
    let resolve;
    const selected = [];
    context.setGreeter = image => {
        selected.push(image);
        return new Promise(done => { resolve = done; });
    };
    const event = { stopPropagation() {} };
    const pending = button.onclick(event);
    assert.equal(button.disabled, true);
    await button.onclick(event);
    assert.deepEqual(selected, ['second.jpg']);
    resolve(false);
    await pending;
    assert.equal(button.disabled, false);
    assert.equal(context.closed, 0);

    const success = button.onclick(event);
    resolve(true);
    await success;
    assert.equal(context.closed, 1);
});

test('a completed greeter action does not close a newly navigated preview', async () => {
    const { context, root } = lightboxContext();
    context.showLightbox({ path: 'first.jpg' });
    let resolve;
    context.setGreeter = () => new Promise(done => { resolve = done; });
    const button = root().buttons.find(item => item.dataset.action === 'greeter');
    const pending = button.onclick({ stopPropagation() {} });
    context.showLightbox({ path: 'second.jpg' });
    resolve(true);
    await pending;
    assert.equal(context.closed, 0);
    assert.equal(button.disabled, false);
});
