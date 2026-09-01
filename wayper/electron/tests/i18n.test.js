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
assert.strictEqual(i18n.t('No wallpapers in pool / SFW'), '图库中没有 SFW 壁纸');
assert.strictEqual(i18n.t('No wallpapers in favorites / sketchy'), '收藏中没有轻度敏感内容的壁纸');
assert.strictEqual(i18n.t('3 candidates'), '3 张候选图片');
assert.strictEqual(i18n.t('Sketchy'), '轻度敏感');
assert.strictEqual(i18n.t('Recommended'), '建议检查');
assert.strictEqual(i18n.t('Auto-held'), '已自动拦截');
assert.strictEqual(i18n.t('Pause Auto Rotation'), '暂停自动换壁纸');
assert.strictEqual(
    i18n.t('Cannot read images from Trash. Check the file permissions for your Trash directory.'),
    '无法读取回收站中的图片。请检查回收站目录的文件权限。',
);
assert.strictEqual(
    i18n.t('Cannot read images from the Recycle Bin. Check Wayper file access or restore the image manually.'),
    '无法读取回收站中的图片。请检查 Wayper 的文件访问权限，或手动恢复该图片。',
);

i18n.setPreference('en', { notify: false });
assert.strictEqual(i18n.t('Settings'), 'Settings');

console.log('i18n tests passed');
