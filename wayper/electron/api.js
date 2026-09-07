(function () {
    function baseUrl() {
        return window.WayperAPI_URL || 'http://127.0.0.1:8080';
    }

    async function request(path, options = {}) {
        const res = await fetch(`${baseUrl()}${path}`, options);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: res.statusText }));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        return res.json();
    }

    function patchConfig(updates) {
        return request('/api/config', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
        });
    }

    function config() {
        return request('/api/config');
    }

    async function tagSuggestions(contextTags = null) {
        const query = contextTags && contextTags.length
            ? `?context=${encodeURIComponent(contextTags.join(','))}`
            : '';
        return request(`/api/tag-suggestions${query}`);
    }

    function searchImages({ query = '', tags = [], uploader = '', signal = null } = {}) {
        const params = new URLSearchParams();
        if (query) params.set('q', query);
        if (tags.length) params.set('tags', tags.join(','));
        if (uploader) params.set('uploader', uploader);
        const suffix = params.size ? `?${params}` : '';
        return request(`/api/search${suffix}`, signal ? { signal } : {});
    }

    function aiSuggestionFeedback(tags, action) {
        return request('/api/ai-suggestions/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags, action }),
        });
    }

    function aiSuggestionStatus() {
        return request('/api/ai-suggestions/status');
    }

    async function aiSuggestions() {
        return request('/api/ai-suggestions', { method: 'POST' });
    }

    function preferenceSuggestions(purities = [], orient = '', limit = null) {
        const params = new URLSearchParams();
        const activePurities = Array.isArray(purities) ? purities : [purities];
        const cleanedPurities = activePurities.map(String).filter(Boolean);
        if (cleanedPurities.length) params.set('purity', cleanedPurities.join(','));
        if (orient) params.set('orient', orient);
        if (limit !== null && limit !== undefined) params.set('limit', String(limit));
        const query = params.toString();
        return request(`/api/preference-suggestions${query ? `?${query}` : ''}`);
    }

    function preferenceFeedback(path, action) {
        return request('/api/preference-suggestions/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, action }),
        });
    }

    function modelReview(purities = [], orient = '', limit = 100) {
        const params = new URLSearchParams();
        const activePurities = Array.isArray(purities) ? purities : [purities];
        const cleanedPurities = activePurities.map(String).filter(Boolean);
        if (cleanedPurities.length) params.set('purity', cleanedPurities.join(','));
        if (orient) params.set('orient', orient);
        if (limit !== null && limit !== undefined) params.set('limit', String(limit));
        const query = params.toString();
        return request(`/api/model-review${query ? `?${query}` : ''}`);
    }

    function modelReviewAction(path, action) {
        return request('/api/model-review/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, action }),
        });
    }

    function clearModelReview(purities = [], orientation = '') {
        const activePurities = Array.isArray(purities) ? purities : [purities];
        return request('/api/model-review/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                purities: activePurities.map(String).filter(Boolean),
                orientation: orientation || null,
            }),
        });
    }

    function updateCheck(force = false) {
        const query = force ? '?force=true' : '';
        return request(`/api/update-check${query}`);
    }

    function reconnectWallhaven() {
        return request('/api/wallhaven/reconnect', { method: 'POST' });
    }

    window.WayperApi = {
        request,
        config,
        patchConfig,
        searchImages,
        tagSuggestions,
        aiSuggestionFeedback,
        aiSuggestionStatus,
        aiSuggestions,
        preferenceSuggestions,
        preferenceFeedback,
        modelReview,
        modelReviewAction,
        clearModelReview,
        updateCheck,
        reconnectWallhaven,
    };
})();
