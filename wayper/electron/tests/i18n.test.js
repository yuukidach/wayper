const assert = require('assert');

const i18n = require('../i18n.js');

assert.strictEqual(i18n.normalizePreference('zh-CN'), 'zh');
assert.strictEqual(i18n.normalizePreference('en_US'), 'en');
assert.strictEqual(i18n.normalizePreference('fr-FR'), 'auto');

i18n.setPreference('zh', { notify: false });
assert.strictEqual(i18n.preference(), 'zh');
assert.strictEqual(i18n.locale(), 'zh');
assert.strictEqual(i18n.t('Settings'), '设置');
assert.strictEqual(i18n.t('English'), '英语');
assert.strictEqual(i18n.t('No matches for "sunset"'), '没有匹配“sunset”');
assert.strictEqual(i18n.t('3 candidates'), '3 个候选项');

i18n.setPreference('en', { notify: false });
assert.strictEqual(i18n.t('Settings'), 'Settings');

console.log('i18n tests passed');
