const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const generalStart = html.indexOf('<h3>General</h3>');
const wallhavenStart = html.indexOf('<h3>Wallhaven Source</h3>');
const batchField = html.indexOf('id="input-batch-size"');
const autostartField = html.indexOf('id="input-autostart"');

assert(generalStart >= 0, 'General settings card should exist');
assert(html.includes('class="settings-workspace"'),
    'Settings should use the navigation-and-sections workspace');
assert(html.includes('<div class="settings-header">\n                    <h2>Settings</h2>')
    && !html.includes('Wayper preferences')
    && !html.includes('Configure Wayper behavior and sources'),
    'Settings should use one concise page heading without repeated introductory copy');
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

console.log('settings layout tests passed');
