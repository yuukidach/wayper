# Sketchy Purity Support

Add Wallhaven's "sketchy" purity tier as an independently toggleable flag alongside the existing sfw/nsfw modes.

## Data Model

**Purity set** replaces the single-mode string. The active purity is a set of one or more of `{"sfw", "sketchy", "nsfw"}`. At least one must be enabled at all times.

**State file** (`.mode`): stores comma-separated sorted purities, e.g. `sfw,sketchy`. The canonical order is `sfw,sketchy,nsfw`. Reading the old format (`sfw` or `nsfw` without commas) is backwards-compatible — treated as a single-element set.

**Config** (`default_mode`): changes from `str` to support comma-separated purities, e.g. `default_mode = "sfw,sketchy"`. Single values remain valid.

**Constant**: `ALL_PURITIES = ("sfw", "sketchy", "nsfw")` defined once in `state.py`, referenced everywhere.

## State Functions

`read_mode()` → returns `set[str]` (e.g. `{"sfw", "sketchy"}`), parsing comma-separated `.mode` file. Falls back to parsing `config.default_mode` the same way.

`write_mode()` → accepts `set[str]`, writes canonical comma-separated string.

New helpers:
- `toggle_base(current: set[str]) -> set[str]` — swaps sfw↔nsfw while preserving sketchy state. Logic: if `nsfw` present → replace with `sfw`; if `sfw` present → replace with `nsfw`; if both present → keep only `sfw` (de-escalate). Sketchy membership is always preserved.
- `toggle_purity(current: set[str], purity: str) -> set[str]` — toggles a single purity; refuses to remove the last one (returns current set unchanged)

## Directory Structure

Add `sketchy/` alongside existing `sfw/` and `nsfw/`:

```
download_dir/
├── sfw/{landscape,portrait}
├── sketchy/{landscape,portrait}
├── nsfw/{landscape,portrait}
└── favorites/
    ├── sfw/{landscape,portrait}
    ├── sketchy/{landscape,portrait}
    └── nsfw/{landscape,portrait}
```

Each purity directory has its own independent quota (controlled by existing `pool_target` and `quota_mb` settings).

## Pool & Quota Changes (`pool.py`)

- `ensure_directories()`: iterate over `ALL_PURITIES` instead of hardcoded `("sfw", "nsfw")`
- `disk_usage_mb()`: iterate over `ALL_PURITIES`
- `enforce_quota()`: iterate over `ALL_PURITIES`, divide `quota_mb` by 3 instead of 2
- `should_download(config, mode)`: `mode` parameter becomes `set[str]`; check each active purity independently
- `pick_random()`: new signature `pick_random(config, purities: set[str], orientation: str)` — first randomly choose a purity from the active set (equal weight), then pick a random image from that purity's pool+favorites

## Download Changes (`wallhaven.py`)

- `download_for()` continues to take a single purity string — called once per active purity
- Daemon calls `download_for()` for each active purity independently (separate API calls, images go to correct directory)
- `_PURITY_CODES` already has the `"sketchy": "010"` entry — no change needed

## Daemon Changes (`daemon.py`)

- `read_mode()` now returns a `set[str]`
- `set_all_wallpapers(config, mode)`: `mode` becomes `set[str]`, passes to updated `pick_random()`
- `should_download()`: checks each active purity
- Download loop: `download_for()` called per-purity in the active set
- `compute_daemon_state()`: returns the purity set; pool/fav counts summed across active purities

## CLI Changes (`cli.py`)

```
wayper mode              # no args: toggle sfw↔nsfw (preserves sketchy state)
wayper mode sfw          # set base to sfw (preserves sketchy state)
wayper mode nsfw         # set base to nsfw (preserves sketchy state)
wayper mode sketchy      # toggle sketchy on/off
wayper mode sfw,sketchy  # set exact combination
```

Implementation:
- Remove `click.Choice(["sfw", "nsfw"])` constraint
- Parse argument: if `"sketchy"` → toggle sketchy in current set; if `"sfw"` or `"nsfw"` → set as base (swap the other, keep sketchy); if contains comma → parse as exact set
- No argument → `toggle_base()`
- Validate result has at least one purity
- Notification shows the resulting set, e.g. "Mode: sfw, sketchy"

WM keybinding examples (Hyprland):
```ini
bind = $mod, F12, exec, wayper mode          # toggle sfw↔nsfw
bind = $mod SHIFT, F12, exec, wayper mode sketchy  # toggle sketchy
```

## GUI Changes

### Keyboard Shortcuts (`electron/renderer.js`)

```
F1    toggle SFW
F2    toggle Sketchy
F3    toggle NSFW
m     deprecated (removed)
```

Each key independently toggles its purity. If toggling off would leave zero purities, the action is rejected (no-op or brief flash notification).

### UI Indicators

Replace the current binary SFW/NSFW toggle with three independent toggle buttons/labels:
- SFW indicator (active/inactive)
- Sketchy indicator (active/inactive)
- NSFW indicator (active/inactive)

Active purities are visually highlighted; inactive are dimmed.

### API Changes (`server/api.py`)

**`POST /api/mode`** — new request format:

```json
{"purities": ["sfw", "sketchy"]}
```

Validates: all items are valid purities, at least one present. Writes to state, signals daemon.

Backwards compatibility: also accept `{"mode": "sfw"}` (old format) — treated as `{"purities": ["sfw"]}`.

**`GET /api/config`** — `mode` field changes from string to array:

```json
{"mode": ["sfw", "sketchy"], ...}
```

**SSE events** — mode event payload changes:

```json
{"type": "mode", "purities": ["sfw", "sketchy"]}
```

**`GET /api/status`** — pool/fav counts reflect all active purities combined.

## Backwards Compatibility

- `.mode` file with old format (`sfw` or `nsfw`) parsed as single-element set — no migration needed
- `default_mode = "sfw"` in config remains valid
- Old API `{"mode": "sfw"}` accepted alongside new `{"purities": [...]}` format
- Existing pool directories (`sfw/`, `nsfw/`) untouched; `sketchy/` created on first run

## Files to Modify

| File | Change |
|------|--------|
| `wayper/state.py` | `ALL_PURITIES`, `read_mode` → `set`, `write_mode` ← `set`, `toggle_base`, `toggle_purity`, `_trash_search_dirs` add sketchy legacy path |
| `wayper/config.py` | `default_mode` parsing/validation |
| `wayper/pool.py` | `ensure_directories`, `disk_usage_mb`, `enforce_quota`, `pick_random`, `should_download` — all use `ALL_PURITIES` |
| `wayper/daemon.py` | `set_all_wallpapers`, download loop, `compute_daemon_state` |
| `wayper/wallhaven.py` | No changes (already has sketchy purity code) |
| `wayper/cli.py` | `mode` command argument parsing and toggle logic |
| `wayper/server/api.py` | `/api/mode` endpoint, `/api/config` response, SSE events |
| `wayper/electron/renderer.js` | F1/F2/F3 keybindings, purity UI indicators, mode state management |
| `wayper/electron/index.html` | Purity toggle UI elements |
| `wayper/electron/styles.css` | Purity indicator styles |
| `example-config.toml` | Update `default_mode` example |
