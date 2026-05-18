(function () {
    function lowerRuleSet(values) {
        return new Set((values || [])
            .map(v => String(v).trim().toLowerCase())
            .filter(Boolean));
    }

    function sameRuleSet(a, b) {
        const left = lowerRuleSet(a);
        const right = lowerRuleSet(b);
        return left.size === right.size && [...left].every(v => right.has(v));
    }

    function containsAllRules(values, targets) {
        const valueSet = lowerRuleSet(values);
        const targetSet = lowerRuleSet(targets);
        return targetSet.size > 0 && [...targetSet].every(v => valueSet.has(v));
    }

    function containsAnyRule(values, targets) {
        const valueSet = lowerRuleSet(values);
        return [...lowerRuleSet(targets)].some(v => valueSet.has(v));
    }

    function hasExcludeCombo(combos, tags) {
        return (combos || []).some(combo => sameRuleSet(combo, tags));
    }

    function suggestionType(suggestion) {
        const type = String(suggestion?.type || '').toLowerCase();
        if (['tag', 'combo', 'uploader'].includes(type)) return type;
        return (suggestion?.tags || []).length > 1 ? 'combo' : 'tag';
    }

    function wallhavenConfig(configOrWallhaven) {
        return configOrWallhaven?.wallhaven || configOrWallhaven;
    }

    function suggestionMatchesConfig(suggestion, action, configOrWallhaven) {
        const wh = wallhavenConfig(configOrWallhaven);
        const tags = Array.isArray(suggestion?.tags) ? suggestion.tags : [];
        if (!wh || tags.length === 0) return false;

        const type = suggestionType(suggestion);
        if (action === 'add') {
            if (type === 'uploader') return containsAllRules(wh.exclude_uploaders, tags);
            if (type === 'combo') return hasExcludeCombo(wh.exclude_combos, tags);
            return containsAllRules(wh.exclude_tags, tags);
        }

        if (type === 'uploader') return !containsAnyRule(wh.exclude_uploaders, tags);
        if (type === 'combo') return !hasExcludeCombo(wh.exclude_combos, tags);
        return !containsAnyRule(wh.exclude_tags, tags);
    }

    function syncAISuggestionAppliedState(aiSuggestions, configOrWallhaven) {
        if (!aiSuggestions || aiSuggestions.error || !configOrWallhaven) return;
        for (const s of (aiSuggestions.add_suggestions || [])) {
            s._applied = suggestionMatchesConfig(s, 'add', configOrWallhaven);
        }
        for (const s of (aiSuggestions.remove_suggestions || [])) {
            s._applied = suggestionMatchesConfig(s, 'remove', configOrWallhaven);
        }
    }

    function matchingAISuggestions(aiSuggestions, tags, type, action) {
        if (!aiSuggestions || aiSuggestions.error) return [];
        const items = action === 'add' ? aiSuggestions.add_suggestions : aiSuggestions.remove_suggestions;
        return (items || []).filter(s => suggestionType(s) === type && sameRuleSet(s.tags, tags));
    }

    window.WayperExclusionRules = {
        lowerRuleSet,
        sameRuleSet,
        containsAllRules,
        containsAnyRule,
        hasExcludeCombo,
        suggestionType,
        suggestionMatchesConfig,
        syncAISuggestionAppliedState,
        matchingAISuggestions,
    };
})();
