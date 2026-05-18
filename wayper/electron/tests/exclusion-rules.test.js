const assert = require('node:assert/strict');

global.window = global;
require('../exclusion-rules.js');

const rules = global.WayperExclusionRules;

const config = {
    wallhaven: {
        exclude_tags: ['MetArt', 'watermarked'],
        exclude_combos: [['blonde', 'nude'], ['standing', 'portrait', 'studio']],
        exclude_uploaders: ['NoisyUploader'],
    },
};

assert.equal(rules.suggestionType({ tags: ['a', 'b'] }), 'combo');
assert.equal(rules.suggestionType({ type: 'UPLOADER', tags: ['x'] }), 'uploader');

assert.equal(
    rules.suggestionMatchesConfig({ type: 'tag', tags: ['metart'] }, 'add', config),
    true,
);
assert.equal(
    rules.suggestionMatchesConfig({ type: 'combo', tags: ['NUDE', 'Blonde'] }, 'add', config),
    true,
);
assert.equal(
    rules.suggestionMatchesConfig({ type: 'uploader', tags: ['noisyuploader'] }, 'add', config),
    true,
);
assert.equal(
    rules.suggestionMatchesConfig({ type: 'tag', tags: ['missing'] }, 'add', config),
    false,
);

assert.equal(
    rules.suggestionMatchesConfig({ type: 'tag', tags: ['watermarked'] }, 'remove', config),
    false,
);
assert.equal(
    rules.suggestionMatchesConfig({ type: 'tag', tags: ['missing'] }, 'remove', config),
    true,
);

const ai = {
    add_suggestions: [
        { type: 'tag', tags: ['metart'] },
        { type: 'combo', tags: ['nude', 'blonde'] },
        { type: 'uploader', tags: ['someoneElse'] },
    ],
    remove_suggestions: [
        { type: 'tag', tags: ['missing'] },
        { type: 'uploader', tags: ['NoisyUploader'] },
    ],
};

rules.syncAISuggestionAppliedState(ai, config);
assert.equal(ai.add_suggestions[0]._applied, true);
assert.equal(ai.add_suggestions[1]._applied, true);
assert.equal(ai.add_suggestions[2]._applied, false);
assert.equal(ai.remove_suggestions[0]._applied, true);
assert.equal(ai.remove_suggestions[1]._applied, false);

assert.deepEqual(
    rules.matchingAISuggestions(ai, ['BLONDE', 'nude'], 'combo', 'add'),
    [ai.add_suggestions[1]],
);

console.log('exclusion-rules tests passed');
