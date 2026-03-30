# Image Search & Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a search bar with autocomplete to the GUI that filters images by Wallhaven tags, category, and filename across all views.

**Architecture:** New `/api/search` endpoint queries cached `.metadata.json` server-side. Frontend adds a search bar to the header with debounced API calls, autocomplete dropdown, and client-side filtering of the current view's image list.

**Tech Stack:** Python/FastAPI (backend), vanilla JS/HTML/CSS (frontend)

**Note:** This project has no test infrastructure (per CLAUDE.md). Steps include manual verification instead of automated tests.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `wayper/server/api.py` | Modify | Add metadata caching + `/api/search` endpoint |
| `wayper/electron/index.html` | Modify | Add search bar HTML to header |
| `wayper/electron/styles.css` | Modify | Add search bar + autocomplete styles |
| `wayper/electron/renderer.js` | Modify | Add search state, API calls, filtering, autocomplete, keyboard shortcuts |

---

### Task 1: Backend — `/api/search` endpoint

**Files:**
- Modify: `wayper/server/api.py:56-73` (add metadata caching after config caching)
- Modify: `wayper/server/api.py:562-573` (add search endpoint before trash route)

- [ ] **Step 1: Add metadata caching**

Add after the config caching block (after line 73) in `wayper/server/api.py`:

```python
_cached_metadata: dict | None = None
_cached_meta_mtime: float = 0


def _get_metadata() -> dict:
    """Return cached metadata, reloading only when the file changes on disk."""
    global _cached_metadata, _cached_meta_mtime
    config = get_config()
    mf = config.metadata_file
    try:
        mtime = mf.stat().st_mtime
    except OSError:
        mtime = 0
    if _cached_metadata is None or mtime != _cached_meta_mtime:
        from wayper.pool import load_metadata

        _cached_metadata = load_metadata(config)
        _cached_meta_mtime = mtime
    return _cached_metadata
```

- [ ] **Step 2: Add `/api/search` endpoint**

Add before the `@app.get("/trash/{filename}")` route in `wayper/server/api.py`:

```python
@app.get("/api/search")
def search_images(q: str = ""):
    """Search images by tags, category, or filename."""
    if not q:
        return {"matches": [], "suggestions": []}

    metadata = _get_metadata()
    query = q.lower()
    matches: list[str] = []
    tag_counts: dict[str, int] = {}

    for filename, meta in metadata.items():
        tags = [t.lower() for t in meta.get("tags", [])]
        category = meta.get("category", "").lower()
        fname = filename.lower()

        if any(query in tag for tag in tags) or query in category or query in fname:
            matches.append(filename)
            for tag in meta.get("tags", []):
                if tag.lower().startswith(query):
                    tag_counts[tag] = tag_counts.get(tag, 0) + 1

    suggestions = sorted(tag_counts.keys(), key=lambda t: -tag_counts[t])[:8]
    return {"matches": matches, "suggestions": suggestions}
```

- [ ] **Step 3: Update `restore_image` to use cached metadata**

In the `restore_image` function, replace the direct `load_metadata` call with `_get_metadata()`:

Change:
```python
    from wayper.pool import load_metadata

    meta = load_metadata(config)
```

To:
```python
    meta = _get_metadata()
```

- [ ] **Step 4: Verify backend**

Run the API server and test:
```bash
cd /home/da/projects/wayper && .venv/bin/python -m wayper.server.api &
curl -s 'http://127.0.0.1:8080/api/search?q=anime' | python -m json.tool
```

Expected: JSON with `matches` array of filenames and `suggestions` array of tags.

- [ ] **Step 5: Lint**

```bash
cd /home/da/projects/wayper && .venv/bin/ruff check wayper/server/api.py && .venv/bin/ruff format --check wayper/server/api.py
```

- [ ] **Step 6: Commit**

```bash
git add wayper/server/api.py
git commit -m "feat: add /api/search endpoint with metadata caching"
```

---

### Task 2: Frontend HTML + CSS — search bar UI

**Files:**
- Modify: `wayper/electron/index.html:12-17` (add search bar to header)
- Modify: `wayper/electron/styles.css:1138-1143` (add search styles before utilities)

- [ ] **Step 1: Add search bar HTML to header**

In `wayper/electron/index.html`, add a search wrapper between the `.brand` div and the `.controls` div (after line 16, before line 18):

```html
        <div class="search-wrapper">
            <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" id="search-input" placeholder="Search tags..." autocomplete="off" spellcheck="false">
            <span id="search-count" class="search-count hidden"></span>
            <button id="search-clear" class="search-clear hidden" title="Clear search (Esc)">&times;</button>
            <kbd class="search-kbd">/</kbd>
            <div id="search-dropdown" class="search-dropdown hidden"></div>
        </div>
```

- [ ] **Step 2: Add search CSS**

In `wayper/electron/styles.css`, add before the `/* ---------- Utilities ---------- */` section (before line 1138):

```css
/* ---------- Search Bar ---------- */

.search-wrapper {
  position: relative;
  flex: 1;
  max-width: 400px;
  min-width: 200px;
  margin: 0 16px;
  -webkit-app-region: no-drag;
}

.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--overlay1);
  pointer-events: none;
  z-index: 1;
}

#search-input {
  width: 100%;
  background: var(--surface0);
  border: 1px solid transparent;
  border-radius: var(--radius);
  color: var(--text);
  padding: 6px 56px 6px 32px;
  font-family: var(--font-sans);
  font-size: 12px;
  outline: none;
  transition: border-color var(--duration) var(--ease),
              box-shadow var(--duration) var(--ease),
              background-color var(--duration) var(--ease);
}

#search-input::placeholder {
  color: var(--subtext0);
}

#search-input:focus {
  border-color: var(--blue);
  background: var(--mantle);
  box-shadow: 0 0 0 3px rgba(137, 180, 250, 0.15);
}

#search-input:focus ~ .search-kbd {
  display: none;
}

.search-kbd {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
}

.search-count {
  position: absolute;
  right: 28px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 10px;
  color: var(--subtext1);
  pointer-events: none;
  font-variant-numeric: tabular-nums;
}

.search-clear {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: var(--overlay1);
  font-size: 16px;
  cursor: pointer;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 50%;
  line-height: 1;
}

.search-clear:hover {
  color: var(--text);
  background: var(--surface1);
}

.search-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  background: var(--surface0);
  border: 1px solid var(--surface1);
  border-radius: var(--radius);
  overflow: hidden;
  z-index: 200;
  box-shadow: var(--shadow-lg);
}

.search-dropdown-item {
  padding: 7px 12px;
  font-size: 12px;
  color: var(--subtext1);
  cursor: pointer;
  transition: background var(--duration) var(--ease),
              color var(--duration) var(--ease);
}

.search-dropdown-item:hover,
.search-dropdown-item.highlighted {
  background: var(--surface2);
  color: var(--text);
}
```

- [ ] **Step 3: Verify UI renders**

Open the GUI and verify the search bar appears in the header between brand and controls. It should have a search icon on the left, placeholder "Search tags...", and a `/` kbd hint on the right.

```bash
cd /home/da/projects/wayper && python -m wayper.server.launcher
```

- [ ] **Step 4: Commit**

```bash
git add wayper/electron/index.html wayper/electron/styles.css
git commit -m "feat: add search bar HTML and CSS to GUI header"
```

---

### Task 3: Frontend JS — search logic, filtering, autocomplete, keyboard

**Files:**
- Modify: `wayper/electron/renderer.js:37-55` (add search state)
- Modify: `wayper/electron/renderer.js:87-123` (add search element refs)
- Modify: `wayper/electron/renderer.js:159-189` (wire up search event listeners)
- Modify: `wayper/electron/renderer.js:191-317` (add `/` keyboard shortcut, handle search input focus)
- Modify: `wayper/electron/renderer.js:635-663` (update `removeImageFromState` for allImages)
- Modify: `wayper/electron/renderer.js:757-784` (update `refreshImages` to use allImages + applySearchFilter)
- Modify: `wayper/electron/renderer.js:885-906` (update `renderImages` for search empty state)

- [ ] **Step 1: Add search state fields to appState**

In `renderer.js`, add to the `appState` object (around line 48, after `blocklistData: null`):

```javascript
    // Search
    searchQuery: '',
    searchMatches: null, // Set<string> of filenames, or null = no search
    allImages: [], // unfiltered image list
```

- [ ] **Step 2: Add search DOM element refs**

In the `els` object (around line 123), add:

```javascript
    // Search
    searchInput: document.getElementById('search-input'),
    searchCount: document.getElementById('search-count'),
    searchClear: document.getElementById('search-clear'),
    searchDropdown: document.getElementById('search-dropdown'),
```

- [ ] **Step 3: Wire up search event listeners**

In `setupEventListeners()` (around line 189), add before the keyboard shortcut line:

```javascript
    // Search
    els.searchInput.addEventListener('input', onSearchInput);
    els.searchInput.addEventListener('keydown', handleSearchKeydown);
    els.searchInput.addEventListener('blur', () => {
        // Delay to allow click on dropdown items
        setTimeout(() => els.searchDropdown.classList.add('hidden'), 150);
    });
    els.searchInput.addEventListener('focus', () => {
        if (els.searchInput.value.trim()) {
            performSearch(els.searchInput.value.trim());
        }
    });
    els.searchClear.onclick = () => { clearSearch(); els.searchInput.blur(); };
```

- [ ] **Step 4: Add `/` keyboard shortcut**

In `handleGlobalKeydown()`, add a case in the switch statement (around line 280, before the `Enter`/` ` case):

```javascript
        case '/':
            e.preventDefault();
            els.searchInput.focus();
            return;
```

Also update the input guard at the top of `handleGlobalKeydown()` to not block Escape when search is focused. Change:

```javascript
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
```

To:

```javascript
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.target.tagName === 'INPUT' && e.target.id !== 'search-input') return;
    if (e.target.id === 'search-input') return; // handled by handleSearchKeydown
```

- [ ] **Step 5: Add search functions**

Add these functions after the `undoDislike()` function (around line 591) and before `fetchBlocklist()`:

```javascript
// --- Search ---

let searchDebounceTimer = null;
let searchHighlightIndex = -1;

function onSearchInput() {
    const query = els.searchInput.value.trim();
    clearTimeout(searchDebounceTimer);

    if (!query) {
        clearSearch();
        return;
    }

    els.searchClear.classList.remove('hidden');
    document.querySelector('.search-kbd')?.classList.add('hidden');

    searchDebounceTimer = setTimeout(() => performSearch(query), 200);
}

async function performSearch(query) {
    appState.searchQuery = query;
    try {
        const res = await fetch(`${API_URL}/api/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        appState.searchMatches = new Set(data.matches);
        renderSearchSuggestions(data.suggestions);
        updateSearchCount();
        applySearchFilter();
    } catch (e) {
        console.error('Search failed:', e);
    }
}

function clearSearch() {
    clearTimeout(searchDebounceTimer);
    els.searchInput.value = '';
    appState.searchQuery = '';
    appState.searchMatches = null;
    searchHighlightIndex = -1;
    els.searchCount.classList.add('hidden');
    els.searchClear.classList.add('hidden');
    els.searchDropdown.classList.add('hidden');
    document.querySelector('.search-kbd')?.classList.remove('hidden');
    applySearchFilter();
}

function updateSearchCount() {
    if (!appState.searchMatches) {
        els.searchCount.classList.add('hidden');
        return;
    }
    const filtered = appState.allImages.filter(img => appState.searchMatches.has(img.name));
    els.searchCount.textContent = `${filtered.length}`;
    els.searchCount.classList.remove('hidden');
}

function applySearchFilter() {
    if (appState.searchMatches) {
        appState.images = appState.allImages.filter(img => appState.searchMatches.has(img.name));
    } else {
        appState.images = [...appState.allImages];
    }
    renderImages();
}

function renderSearchSuggestions(suggestions) {
    searchHighlightIndex = -1;
    if (!suggestions.length) {
        els.searchDropdown.classList.add('hidden');
        return;
    }

    els.searchDropdown.innerHTML = suggestions.map((tag, i) =>
        `<div class="search-dropdown-item" data-index="${i}">${esc(tag)}</div>`
    ).join('');
    els.searchDropdown.classList.remove('hidden');

    els.searchDropdown.querySelectorAll('.search-dropdown-item').forEach(item => {
        item.onmousedown = (e) => {
            e.preventDefault(); // Prevent blur
            els.searchInput.value = item.textContent;
            els.searchDropdown.classList.add('hidden');
            performSearch(item.textContent);
        };
    });
}

function handleSearchKeydown(e) {
    const items = els.searchDropdown.querySelectorAll('.search-dropdown-item');

    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        clearSearch();
        els.searchInput.blur();
        return;
    }

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (items.length) {
            searchHighlightIndex = Math.min(searchHighlightIndex + 1, items.length - 1);
            updateDropdownHighlight(items);
        }
        return;
    }

    if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length) {
            searchHighlightIndex = Math.max(searchHighlightIndex - 1, -1);
            updateDropdownHighlight(items);
        }
        return;
    }

    if (e.key === 'Enter') {
        e.preventDefault();
        if (searchHighlightIndex >= 0 && items[searchHighlightIndex]) {
            els.searchInput.value = items[searchHighlightIndex].textContent;
            els.searchDropdown.classList.add('hidden');
            performSearch(items[searchHighlightIndex].textContent);
        } else {
            els.searchDropdown.classList.add('hidden');
        }
        return;
    }
}

function updateDropdownHighlight(items) {
    items.forEach((item, i) => {
        item.classList.toggle('highlighted', i === searchHighlightIndex);
    });
}
```

- [ ] **Step 6: Update `refreshImages` to use `allImages` + `applySearchFilter`**

Replace the `refreshImages()` function with:

```javascript
async function refreshImages() {
    if (!appState.selectedMonitor) return;

    const monitor = appState.monitors.find(m => m.name === appState.selectedMonitor);
    const orient = monitor ? monitor.orientation : 'landscape';

    if (appState.mode === 'trash') {
        const url = `${API_URL}/api/images?mode=trash&purity=sfw&orient=${orient}`;
        try {
            const [imgRes] = await Promise.all([
                fetch(url),
                fetchBlocklist(),
            ]);
            appState.allImages = await imgRes.json();
            applySearchFilter();
        } catch (e) { console.error(e); }
    } else {
        try {
            const fetches = appState.purity.map(p =>
                fetch(`${API_URL}/api/images?mode=${appState.mode}&purity=${p}&orient=${orient}`)
                    .then(r => r.json())
            );
            const results = await Promise.all(fetches);
            appState.allImages = results.flat();
            applySearchFilter();
        } catch (e) { console.error(e); }
    }
}
```

- [ ] **Step 7: Update `removeImageFromState` to handle `allImages`**

In `removeImageFromState()`, add removal from `allImages` at the top of the function:

```javascript
function removeImageFromState(path) {
    // Also remove from allImages (unfiltered list)
    const allIdx = appState.allImages.findIndex(img => img.path === path);
    if (allIdx !== -1) appState.allImages.splice(allIdx, 1);

    const idx = appState.images.findIndex(img => img.path === path);
```

The rest of the function stays unchanged.

- [ ] **Step 8: Update `renderImages` empty state for search**

In `renderImages()`, update the empty state to show a search-specific message when search is active. Change the empty state block:

```javascript
    if (appState.images.length === 0) {
        const msg = appState.searchQuery
            ? `No matches for "${esc(appState.searchQuery)}"`
            : `No wallpapers in ${esc(appState.mode)} / ${esc(appState.purity)}`;
        els.wallpaperGrid.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>
                <p>${msg}</p>
            </div>
        `;
        return;
    }
```

- [ ] **Step 9: Verify full search flow**

Open the GUI and test:
1. Press `/` — search bar should focus
2. Type "anime" — autocomplete suggestions should appear, image grid should filter
3. Arrow down/up to navigate suggestions, Enter to select
4. Escape to clear search
5. Switch views (1/2/3) with search active — search should persist
6. Click the `×` button to clear search

```bash
cd /home/da/projects/wayper && python -m wayper.server.launcher
```

- [ ] **Step 10: Lint**

```bash
cd /home/da/projects/wayper && .venv/bin/ruff check wayper/server/api.py && .venv/bin/ruff format --check wayper/server/api.py
```

- [ ] **Step 11: Commit**

```bash
git add wayper/electron/renderer.js
git commit -m "feat: add search filtering with autocomplete to GUI"
```

---

### Task 4: Final polish and integration commit

**Files:**
- All modified files from Tasks 1-3

- [ ] **Step 1: Run full lint check**

```bash
cd /home/da/projects/wayper && .venv/bin/ruff check wayper/ && .venv/bin/ruff format --check wayper/
```

- [ ] **Step 2: End-to-end manual test**

Test the complete flow:
1. Launch GUI: `python -m wayper.server.launcher`
2. Verify Pool view with no search — all images visible
3. Press `/`, type "tattoo" — only matching images shown, count badge visible
4. Switch to Blocklist (3) — search persists, shows matching blacklisted images
5. Switch to Favorites (2) — search persists
6. Press Escape — search cleared, all images restored
7. Type partial tag, use arrow keys to navigate suggestions, Enter to select
8. Verify purity filter still works alongside search (F1/F2/F3)
