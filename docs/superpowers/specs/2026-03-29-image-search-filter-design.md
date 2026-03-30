# Image Search & Filter

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this spec.

**Goal:** Add a search bar with autocomplete to the GUI that filters images by Wallhaven tags, category, and filename across all views (Pool, Favorites, Blocklist).

**Motivation:** The user wants to review disliked wallpapers by type (e.g., "tattoo", "male", "game screenshot") to confirm their taste preferences. Search should work across all views for consistency.

---

## Backend: `/api/search` endpoint

### Endpoint

```
GET /api/search?q={query}
```

**Parameters:**
- `q` (required): Search query string, minimum 1 character.

**Response:**
```json
{
  "matches": ["wallhaven-abc123.jpg", "wallhaven-def456.png"],
  "suggestions": ["tattoo", "tattooed girl", "tattooed woman"]
}
```

- `matches`: All filenames in `.metadata.json` whose tags, category, or filename contain the query (case-insensitive substring match).
- `suggestions`: Up to 8 distinct tags from matched entries that start with the query prefix (case-insensitive). Used for autocomplete.

### Implementation details

- Metadata is already loaded and cached with mtime-based reload in `api.py` (via `_get_config()`). Apply the same caching pattern: load `.metadata.json` once, reload when mtime changes.
- Matching logic: for each image in metadata, check if `query` is a substring of any tag, category, or the filename itself. All comparisons case-insensitive.
- Suggestion logic: collect all tags from matched images, filter to those whose lowercase form starts with the lowercase query, deduplicate, sort by frequency (most common first), return top 8.
- No `mode` parameter needed — the frontend already knows which filenames belong to its current view and intersects locally.

---

## Frontend: Search bar with autocomplete

### Placement

Search input added to the controls bar in `index.html`, positioned between the purity toggles and the monitor selector. Visually styled to match existing controls (Catppuccin Mocha theme, same border-radius and colors).

### Behavior

1. **Focus:** Press `/` to focus the search bar from anywhere. Pressing `/` while already focused is a no-op (types into the input).
2. **Typing:** After 200ms debounce, sends `GET /api/search?q={value}` to backend.
3. **Autocomplete dropdown:** Shows up to 8 tag suggestions below the input. Arrow keys navigate suggestions, Enter/click selects one (fills the input with that tag and triggers search). Dropdown dismisses on blur or Escape.
4. **Filtering:** Frontend intersects the `matches` filename list with the current view's loaded images. Only matching images are shown in the grid. The existing infinite scroll mechanism continues to work — `loadMoreImages()` fetches the next batch from the API and filters client-side against the active search matches.
5. **Result count:** A small badge next to the search input shows "N matches" when a search is active.
6. **Clear:** Press `Escape` to clear the search, restore the full unfiltered view, and return focus to the grid. A small "x" button inside the input also clears.
7. **Persistence across views:** When the user switches views (Pool → Favorites → Blocklist), the search query persists and re-runs against the new view's images. This lets the user compare what "tattoo" images look like across pool vs blocklist.
8. **Composition with purity/orientation:** Search composes with existing purity and orientation filters. If the user has SFW selected and searches "anime", they see SFW anime images only.

### Keyboard shortcut

| Key | Action |
|-----|--------|
| `/` | Focus search bar |
| `Escape` (in search) | Clear search, return focus to grid |
| `Arrow Down/Up` (in search) | Navigate autocomplete suggestions |
| `Enter` (in search) | Select highlighted suggestion, or submit current text |

### Styling

- Input: `background: var(--surface0)`, `border: 1px solid var(--surface2)`, `border-radius: 8px`, `color: var(--text)`, placeholder "Search tags..." in `var(--subtext0)`.
- Autocomplete dropdown: `background: var(--surface0)`, each item styled like existing dropdown items, highlighted item uses `var(--surface2)` background.
- Match count badge: small text in `var(--subtext1)` to the right of the input.
- Responsive: search bar takes available space, min-width ~200px, max-width ~400px.

---

## What does NOT change

- Blacklist/undo/trash mechanics — no changes.
- Image grid rendering, lightbox, card layout — no changes.
- Metadata collection — we use what Wallhaven already provides at download time.
- Existing purity/orientation filters — they compose with search.
- API endpoints for images, blocklist, control — no changes.
- CLI commands — no changes.

---

## Edge cases

- **No metadata for an image:** Some images may predate metadata tracking or have incomplete metadata. These images are excluded from search results (they don't match any query). They remain visible when no search is active.
- **Empty query:** Treated as "no search active" — show all images unfiltered.
- **No matches:** Show empty grid with a "No matches for '{query}'" message in the content area.
- **Trash images with metadata:** Metadata persists in `.metadata.json` even after an image is sent to trash. The filename key remains, so trash images are searchable.
