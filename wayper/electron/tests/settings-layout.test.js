const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const generalStart = html.indexOf('<h3>General</h3>');
const wallhavenStart = html.indexOf('<h3>Wallhaven Source</h3>');
const batchField = html.indexOf('id="input-batch-size"');

assert(generalStart >= 0, 'General settings card should exist');
assert(wallhavenStart > generalStart, 'Wallhaven settings should follow General');
assert(batchField > generalStart && batchField < wallhavenStart,
    'Download Batch Size belongs in the General settings card');

console.log('settings layout tests passed');
