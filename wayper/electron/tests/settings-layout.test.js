const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const generalStart = html.indexOf('<h3>General</h3>');
const wallhavenStart = html.indexOf('<h3>Wallhaven Source</h3>');
const batchField = html.indexOf('id="input-batch-size"');
const autostartField = html.indexOf('id="input-autostart"');
const comboInput = html.indexOf('id="input-exclude-combo"');

assert(generalStart >= 0, 'General settings card should exist');
assert(html.includes('class="settings-workspace"'),
    'Settings should use the navigation-and-sections workspace');
assert(!html.includes('class="settings-header"')
    && !html.includes('Wayper preferences')
    && !html.includes('Configure Wayper behavior and sources'),
    'Settings tabs should not repeat the page title already shown in the app header');
assert(html.includes('class="settings-toolbar"'),
    'Settings tabs and actions should share the top toolbar');
assert(html.includes('role="tablist"') && html.includes('role="tabpanel"'),
    'Settings should expose accessible tab semantics');
assert(html.includes('id="settings-wallhaven" role="tabpanel"')
    && html.includes('id="settings-exclusions" role="tabpanel"'),
    'Wallhaven and Filters should be independent tab panels');
assert(html.includes('aria-labelledby="settings-tab-wallhaven" hidden')
    && html.includes('aria-labelledby="settings-tab-filters" hidden'),
    'Only the General panel should be visible initially');
assert(html.includes('href="#settings-general"') && html.includes('href="#settings-exclusions"'),
    'Settings navigation should link to each section');
assert(wallhavenStart > generalStart, 'Wallhaven settings should follow General');
assert(batchField > generalStart && batchField < wallhavenStart,
    'Download Batch Size belongs in the General settings card');
assert(autostartField > generalStart && autostartField < wallhavenStart,
    'Start at Login belongs in the General settings card');
assert(comboInput > wallhavenStart
    && html.includes('id="btn-add-combo"')
    && html.includes('id="exclude-combo-error"'),
    'Filter settings should support manually adding and validating tag combinations');
assert(/\.settings-toolbar\s*{[^}]*background:\s*var\(--settings-tab-bar\)/s.test(styles)
    && /\.settings-toolbar\s*{[^}]*padding:\s*0;/s.test(styles)
    && /\.settings-index-link\s*{[^}]*background:\s*var\(--settings-tab-bar\)/s.test(styles),
    'The tab bar should match inactive tabs without adding outer tab gaps');
assert(/\.settings-index-link\.active\s*{[^}]*background:\s*var\(--settings-sheet\)/s.test(styles)
    && /\.settings-index-link\.active\s*{[^}]*margin-top:\s*0/s.test(styles)
    && /\.settings-index-link\.active\s*{[^}]*border:\s*0/s.test(styles)
    && /\.settings-index-link\.active\s*{[^}]*border-radius:\s*0 9px 0 0/s.test(styles),
    'The active settings tab should meet the top edge with a rounded top-right corner');
assert(/\.settings-index\s*{[^}]*gap:\s*0/s.test(styles),
    'Settings tabs should touch along their left and right edges');
assert(/\.settings-index-link\.active::before,\s*\.settings-index-link\.active::after\s*{/s.test(styles)
    && /border-bottom-right-radius:\s*12px/s.test(styles)
    && /border-bottom-left-radius:\s*12px/s.test(styles),
    'The active tab should flow into the settings panel with inverse corner transitions');
assert(/\.exclusion-grid\s*>\s*\.field\s*{[^}]*margin-bottom:\s*0/s.test(styles),
    'Filter columns should use the same height and hint baseline');
assert(/\.exclusion-grid\s*{[^}]*padding:\s*13px 22px 24px/s.test(styles),
    'The first Filters row should align with the first row in the other panels');
assert(/\.exclusion-grid\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s.test(styles)
    && /\.exclusion-grid\s*{[^}]*grid-template-rows:\s*repeat\(3, minmax\(240px, 1fr\)\)/s.test(styles),
    'Filter groups should stack vertically, share the available height, and keep a usable minimum');
assert(/\.tag-chips\s*{[^}]*min-height:\s*120px/s.test(styles)
    && /\.tag-chips\s*{[^}]*flex:\s*1 1 120px/s.test(styles),
    'Filter tag lists should grow with their section before becoming scrollable');
assert(/body\[data-view='settings'\]\s+main\s*{[^}]*display:\s*flex/s.test(styles)
    && /\.settings-container\s*{[^}]*flex:\s*1 0 auto/s.test(styles)
    && /\.settings-workspace\s*{[^}]*flex:\s*1 0 auto/s.test(styles)
    && /\.settings-sections\s*{[^}]*flex:\s*1 0 auto/s.test(styles)
    && /\.settings-card\.active\s*{[^}]*flex:\s*1 0 auto/s.test(styles),
    'The active settings panel should fill the available main content height');
assert(!/\.settings-card-wide\s*{[^}]*margin-bottom:/s.test(styles),
    'The Filters panel should not leave a gap below the settings workspace');

console.log('settings layout tests passed');
