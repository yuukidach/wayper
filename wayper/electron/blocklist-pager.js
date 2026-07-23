(function () {
    const DEFAULT_PAGE_SIZE = 100;

    function normalizeTotal(total) {
        return Math.max(0, Number.isFinite(total) ? Math.floor(total) : 0);
    }

    function normalizePageSize(pageSize) {
        return Math.max(
            1,
            Number.isFinite(pageSize) ? Math.floor(pageSize) : DEFAULT_PAGE_SIZE,
        );
    }

    function createState() {
        return {
            sourceEntries: null,
            searchMatches: null,
            tab: null,
            visibleCount: 0,
        };
    }

    function sync(state, { sourceEntries, searchMatches, tab }) {
        const changed = state.sourceEntries !== sourceEntries
            || state.searchMatches !== searchMatches
            || state.tab !== tab;

        if (changed) {
            state.sourceEntries = sourceEntries;
            state.searchMatches = searchMatches;
            state.tab = tab;
            state.visibleCount = 0;
        }
        return changed;
    }

    function visibleCount(state, total, pageSize = DEFAULT_PAGE_SIZE) {
        const normalizedTotal = normalizeTotal(total);
        const normalizedPageSize = normalizePageSize(pageSize);
        if (state.visibleCount === 0 && normalizedTotal > 0) {
            state.visibleCount = Math.min(normalizedPageSize, normalizedTotal);
        } else {
            state.visibleCount = Math.min(state.visibleCount, normalizedTotal);
        }
        return state.visibleCount;
    }

    function loadMore(state, total, pageSize = DEFAULT_PAGE_SIZE) {
        const start = visibleCount(state, total, pageSize);
        const normalizedTotal = normalizeTotal(total);
        const normalizedPageSize = normalizePageSize(pageSize);
        state.visibleCount = Math.min(start + normalizedPageSize, normalizedTotal);
        return { start, end: state.visibleCount };
    }

    function replaceSource(state, sourceEntries, total) {
        state.sourceEntries = sourceEntries;
        state.visibleCount = Math.min(state.visibleCount, normalizeTotal(total));
    }

    window.WayperBlocklistPager = Object.freeze({
        DEFAULT_PAGE_SIZE,
        createState,
        sync,
        visibleCount,
        loadMore,
        replaceSource,
    });
})();
