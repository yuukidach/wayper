# AI Tag Exclusion Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AI-powered exclusion rule management — suggest new tags/combos to exclude and identify existing rules to remove — by calling the local `claude` CLI.

**Architecture:** New `ai_suggestions.py` module handles data preparation (three-way contrast: dislike/favorite/pool) and claude CLI invocation. API endpoint and CLI command both call into this module. GUI adds an "AI 分析" button that displays results with per-suggestion accept/remove actions.

**Tech Stack:** Python (asyncio subprocess), claude CLI (`-p --json-schema`), FastAPI, Electron/vanilla JS

---

### Task 1: Core AI Suggestions Module — Data Preparation

**Files:**
- Create: `wayper/ai_suggestions.py`

- [ ] **Step 1: Create `ai_suggestions.py` with data collection functions**

```python
"""AI-powered tag exclusion suggestions via local claude CLI."""

from __future__ import annotations

import base64
import json
import logging
import random
from pathlib import Path

from .config import WayperConfig
from .image import generate_thumbnail
from .pool import (
    ImageMetadata,
    favorites_dir,
    list_blacklist,
    list_images,
    load_metadata,
    pool_dir,
)
from .state import ALL_PURITIES

log = logging.getLogger("wayper.ai")


def _collect_tag_groups(
    config: WayperConfig,
    metadata: dict[str, ImageMetadata],
) -> dict:
    """Split metadata into disliked, favorited, and pool groups with their tags."""
    blacklisted = {fn for _, fn in list_blacklist(config)}

    # Collect favorite filenames
    fav_files: set[str] = set()
    for purity in ALL_PURITIES:
        for orient in ("landscape", "portrait"):
            for img in list_images(favorites_dir(config, purity, orient)):
                fav_files.add(img.name)

    dislike_tags: list[list[str]] = []
    fav_tags: list[list[str]] = []
    pool_tags: list[list[str]] = []

    for filename, meta in metadata.items():
        tags = meta.get("tags", [])
        if not tags:
            continue
        if filename in blacklisted:
            dislike_tags.append(tags)
        elif filename in fav_files:
            fav_tags.append(tags)
        else:
            pool_tags.append(tags)

    # Sample pool if too large
    if len(pool_tags) > 200:
        pool_tags = random.sample(pool_tags, 200)

    return {
        "dislike": dislike_tags,
        "favorite": fav_tags,
        "pool": pool_tags,
    }


def _sample_thumbnails(
    config: WayperConfig,
    blacklisted_entries: list[tuple[int, str]],
    fav_files: list[Path],
    pool_files: list[Path],
) -> dict[str, list[str]]:
    """Sample and base64-encode thumbnails from each group.

    Returns dict with keys "dislike", "favorite", "pool", each a list of
    base64-encoded JPEG data URIs.
    """
    cache_dir = config.download_dir / ".thumbnails" / "_ai"

    def encode_images(paths: list[Path], limit: int) -> list[str]:
        results = []
        for p in paths[:limit]:
            thumb = generate_thumbnail(p, cache_dir, max_width=300)
            target = thumb if thumb else p
            try:
                data = target.read_bytes()
                b64 = base64.b64encode(data).decode()
                suffix = target.suffix.lower()
                mime = "image/jpeg" if suffix in (".jpg", ".jpeg") else f"image/{suffix.lstrip('.')}"
                results.append(f"data:{mime};base64,{b64}")
            except OSError:
                continue
        return results

    # Dislike: most recent 20 by timestamp
    dislike_paths = []
    for _, fn in blacklisted_entries[:20]:
        # Search all purity/orientation dirs for the file
        for purity in ALL_PURITIES:
            for orient in ("landscape", "portrait"):
                candidate = pool_dir(config, purity, orient) / fn
                if candidate.exists():
                    dislike_paths.append(candidate)
                    break
            else:
                continue
            break
        # Also check trash
        if not dislike_paths or dislike_paths[-1].name != fn:
            from .state import find_in_trash
            trashed = find_in_trash(config, fn)
            if trashed:
                dislike_paths.append(trashed)

    # Favorites: random 20
    fav_sample = random.sample(fav_files, min(20, len(fav_files))) if fav_files else []

    # Pool: random 10
    pool_sample = random.sample(pool_files, min(10, len(pool_files))) if pool_files else []

    return {
        "dislike": encode_images(dislike_paths, 20),
        "favorite": encode_images(fav_sample, 20),
        "pool": encode_images(pool_sample, 10),
    }
```

- [ ] **Step 2: Verify module imports work**

Run: `cd /home/da/projects/wayper && python -c "from wayper.ai_suggestions import _collect_tag_groups; print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add wayper/ai_suggestions.py
git commit -m "feat: add AI suggestions data preparation module"
```

---

### Task 2: Core AI Suggestions Module — Prompt Building & CLI Invocation

**Files:**
- Modify: `wayper/ai_suggestions.py`

- [ ] **Step 1: Add JSON schema constant and prompt builder**

Append to `wayper/ai_suggestions.py`:

```python
AI_SCHEMA = {
    "type": "object",
    "required": ["analysis", "add_suggestions", "remove_suggestions"],
    "properties": {
        "analysis": {
            "type": "string",
            "description": "Natural language analysis of dislike patterns and exclusion rule health",
        },
        "add_suggestions": {
            "type": "array",
            "description": "New tags/combos to add to exclusion rules",
            "items": {
                "type": "object",
                "required": ["type", "tags", "reason", "confidence"],
                "properties": {
                    "type": {"enum": ["tag", "combo"]},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "reason": {"type": "string"},
                    "confidence": {"enum": ["high", "medium", "low"]},
                },
            },
        },
        "remove_suggestions": {
            "type": "array",
            "description": "Existing exclusion rules to consider removing",
            "items": {
                "type": "object",
                "required": ["type", "tags", "reason"],
                "properties": {
                    "type": {"enum": ["tag", "combo"]},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "reason": {"type": "string"},
                },
            },
        },
    },
}


def _build_prompt(
    tag_groups: dict,
    thumbnails: dict[str, list[str]],
    exclude_tags: list[str],
    exclude_combos: list[list[str]],
) -> str:
    """Build the full prompt with data for Claude to analyze."""
    parts = []

    parts.append(
        "You are analyzing a wallpaper collection to help manage tag exclusion rules. "
        "You have three groups of data:\n"
        "- **Disliked**: images the user explicitly rejected\n"
        "- **Favorites**: images the user explicitly saved\n"
        "- **Pool**: images the user kept (neither rejected nor favorited)\n\n"
        "Your job:\n"
        "1. Analyze semantic patterns in disliked images that differ from favorites+pool\n"
        "2. Suggest new tags or tag combos to exclude (things uniquely disliked)\n"
        "3. Review existing exclusion rules and flag ones that should be removed "
        "(redundant, overlapping, or false positives where the tag appears frequently "
        "in pool+favorites meaning the user actually accepts this content)\n"
        "4. Provide a natural language analysis explaining your findings\n\n"
        "Important: tags are from Wallhaven. Understand their semantic meaning. "
        "Look for concept clusters, not just individual tag frequency.\n"
    )

    # Current exclusion rules
    parts.append("## Current Exclusion Rules\n")
    if exclude_tags:
        parts.append(f"Single tags: {', '.join(exclude_tags)}\n")
    else:
        parts.append("Single tags: (none)\n")
    if exclude_combos:
        combos_str = "; ".join(" + ".join(c) for c in exclude_combos)
        parts.append(f"Combos: {combos_str}\n")
    else:
        parts.append("Combos: (none)\n")

    # Tag data
    parts.append(f"\n## Disliked Images ({len(tag_groups['dislike'])} images)\n")
    for i, tags in enumerate(tag_groups["dislike"]):
        parts.append(f"{i+1}. {', '.join(tags)}\n")

    parts.append(f"\n## Favorite Images ({len(tag_groups['favorite'])} images)\n")
    for i, tags in enumerate(tag_groups["favorite"]):
        parts.append(f"{i+1}. {', '.join(tags)}\n")

    parts.append(f"\n## Pool Images ({len(tag_groups['pool'])} images, sampled)\n")
    for i, tags in enumerate(tag_groups["pool"]):
        parts.append(f"{i+1}. {', '.join(tags)}\n")

    # Image samples
    for group_name, label in [("dislike", "Disliked"), ("favorite", "Favorite"), ("pool", "Pool")]:
        imgs = thumbnails.get(group_name, [])
        if imgs:
            parts.append(f"\n## Sample {label} Images\n")
            for uri in imgs:
                parts.append(f"![{label} sample]({uri})\n")

    return "".join(parts)
```

- [ ] **Step 2: Add async Claude CLI invocation function**

Append to `wayper/ai_suggestions.py`:

```python
import asyncio
import shutil


class AISuggestionError(Exception):
    """Raised when AI suggestion generation fails."""


async def _invoke_claude(prompt: str, timeout: float = 60.0) -> dict:
    """Call claude CLI in print mode and return parsed JSON response."""
    claude_bin = shutil.which("claude")
    if not claude_bin:
        raise AISuggestionError("Claude CLI not found. Install it from https://claude.ai/download")

    schema_json = json.dumps(AI_SCHEMA)
    proc = await asyncio.create_subprocess_exec(
        claude_bin,
        "-p",
        "--model", "sonnet",
        "--output-format", "json",
        "--json-schema", schema_json,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(input=prompt.encode()),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise AISuggestionError(f"Claude CLI timed out after {timeout}s")

    if proc.returncode != 0:
        err = stderr.decode().strip()
        raise AISuggestionError(f"Claude CLI failed (exit {proc.returncode}): {err}")

    try:
        result = json.loads(stdout.decode())
    except json.JSONDecodeError as e:
        raise AISuggestionError(f"Claude returned invalid JSON: {e}")

    # Handle claude --output-format json wrapping: result may be in result.result
    if "result" in result and isinstance(result["result"], str):
        try:
            result = json.loads(result["result"])
        except json.JSONDecodeError:
            pass

    return result
```

- [ ] **Step 3: Add the main public function**

Append to `wayper/ai_suggestions.py`:

```python
async def generate_ai_suggestions(config: WayperConfig) -> dict:
    """Generate AI-powered tag exclusion suggestions.

    Returns dict with keys: analysis, add_suggestions, remove_suggestions.
    Raises AISuggestionError on failure.
    """
    metadata = load_metadata(config)
    if not metadata:
        raise AISuggestionError("No metadata available. Download some wallpapers first.")

    blacklist_entries = list_blacklist(config)
    if not blacklist_entries:
        raise AISuggestionError("No disliked images. Dislike some wallpapers first.")

    tag_groups = _collect_tag_groups(config, metadata)

    # Collect file paths for thumbnails
    fav_paths: list[Path] = []
    pool_paths: list[Path] = []
    blacklisted = {fn for _, fn in blacklist_entries}
    fav_files_set: set[str] = set()
    for purity in ALL_PURITIES:
        for orient in ("landscape", "portrait"):
            for img in list_images(favorites_dir(config, purity, orient)):
                fav_files_set.add(img.name)
                fav_paths.append(img)
            for img in list_images(pool_dir(config, purity, orient)):
                if img.name not in blacklisted and img.name not in fav_files_set:
                    pool_paths.append(img)

    thumbnails = _sample_thumbnails(config, blacklist_entries, fav_paths, pool_paths)

    prompt = _build_prompt(
        tag_groups,
        thumbnails,
        config.wallhaven.exclude_tags,
        config.wallhaven.exclude_combos,
    )

    log.info("Sending AI suggestion request (%d chars prompt)", len(prompt))
    result = await _invoke_claude(prompt)

    return {
        "analysis": result.get("analysis", ""),
        "add_suggestions": result.get("add_suggestions", []),
        "remove_suggestions": result.get("remove_suggestions", []),
    }
```

- [ ] **Step 4: Verify the full module loads**

Run: `cd /home/da/projects/wayper && python -c "from wayper.ai_suggestions import generate_ai_suggestions, AISuggestionError; print('OK')"`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add wayper/ai_suggestions.py
git commit -m "feat: add Claude CLI invocation and prompt building for AI suggestions"
```

---

### Task 3: API Endpoint

**Files:**
- Modify: `wayper/server/api.py`

- [ ] **Step 1: Add the POST /api/ai-suggestions endpoint**

Add import at top of `wayper/server/api.py` (after existing imports around line 40):

```python
from wayper.ai_suggestions import AISuggestionError, generate_ai_suggestions
```

Add the endpoint after the existing `/api/tag-suggestions` endpoint (after line 645):

```python
@app.post("/api/ai-suggestions")
async def ai_suggestions_route():
    """Generate AI-powered tag exclusion suggestions using Claude CLI."""
    config = get_config()
    try:
        result = await generate_ai_suggestions(config)
    except AISuggestionError as e:
        status = 503 if "not found" in str(e).lower() else 504 if "timed out" in str(e).lower() else 400
        raise HTTPException(status, str(e))
    return result
```

- [ ] **Step 2: Verify API server starts**

Run: `cd /home/da/projects/wayper && python -c "from wayper.server.api import app; print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add wayper/server/api.py
git commit -m "feat: add POST /api/ai-suggestions endpoint"
```

---

### Task 4: CLI Command

**Files:**
- Modify: `wayper/cli.py`

- [ ] **Step 1: Add the `suggest` command to CLI**

Add after the `status` command (after line 401 in `wayper/cli.py`):

```python
@cli.command()
@click.option("--ai", "use_ai", is_flag=True, help="Use Claude AI for intelligent analysis.")
@click.pass_context
def suggest(ctx, use_ai):
    """Show tag exclusion suggestions.

    Without --ai: shows frequency-based suggestions.
    With --ai: calls Claude CLI for semantic analysis.
    """
    config = ctx.obj["config"]
    use_json = ctx.obj["json"]

    if use_ai:
        from .ai_suggestions import AISuggestionError, generate_ai_suggestions

        try:
            result = asyncio.run(generate_ai_suggestions(config))
        except AISuggestionError as e:
            if use_json:
                click.echo(json.dumps({"error": str(e)}))
            else:
                click.echo(f"Error: {e}", err=True)
            raise SystemExit(1)

        if use_json:
            click.echo(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            click.echo(f"\n{result['analysis']}\n")
            if result["add_suggestions"]:
                click.echo("--- Suggested Additions ---")
                for s in result["add_suggestions"]:
                    tags = " + ".join(s["tags"])
                    click.echo(f"  [{s['confidence']}] {s['type']}: {tags}")
                    click.echo(f"         {s['reason']}")
            if result["remove_suggestions"]:
                click.echo("\n--- Suggested Removals ---")
                for s in result["remove_suggestions"]:
                    tags = " + ".join(s["tags"])
                    click.echo(f"  {s['type']}: {tags}")
                    click.echo(f"         {s['reason']}")
            if not result["add_suggestions"] and not result["remove_suggestions"]:
                click.echo("No suggestions at this time.")
    else:
        from .pool import list_blacklist, load_metadata
        from .suggestions import suggest_tags_to_exclude

        metadata = load_metadata(config)
        blacklisted = {fn for _, fn in list_blacklist(config)}
        results = suggest_tags_to_exclude(
            metadata, blacklisted, config.wallhaven.exclude_tags, config.wallhaven.exclude_combos
        )
        if use_json:
            click.echo(json.dumps({"suggestions": results}, ensure_ascii=False, indent=2))
        else:
            if results:
                click.echo("Suggested exclusions (by dislike frequency):")
                for s in results:
                    click.echo(f"  {s['tag']} (count: {s['count']}, ratio: {s['ratio']}x)")
            else:
                click.echo("No suggestions at this time.")
```

- [ ] **Step 2: Verify the CLI command is registered**

Run: `cd /home/da/projects/wayper && python -m wayper.cli suggest --help`
Expected output includes `--ai` flag description

- [ ] **Step 3: Commit**

```bash
git add wayper/cli.py
git commit -m "feat: add 'wayper suggest' CLI command with --ai flag"
```

---

### Task 5: GUI — AI Analysis Button & Loading State

**Files:**
- Modify: `wayper/electron/renderer.js`
- Modify: `wayper/electron/styles.css`

- [ ] **Step 1: Add AI state to appState**

In `wayper/electron/renderer.js`, add to the `appState` object (around line 36-64):

```javascript
    aiSuggestions: null,           // Result from /api/ai-suggestions
    aiLoading: false,              // Whether AI analysis is in progress
```

- [ ] **Step 2: Add fetchAISuggestions function**

Add after the `fetchComboRefinements` function (around line 614):

```javascript
async function fetchAISuggestions() {
    appState.aiLoading = true;
    renderBlocklistView();
    try {
        const res = await fetch(`${API_URL}/api/ai-suggestions`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: res.statusText }));
            appState.aiSuggestions = { error: err.detail || 'AI analysis failed' };
        } else {
            appState.aiSuggestions = await res.json();
        }
    } catch (e) {
        appState.aiSuggestions = { error: `Connection error: ${e.message}` };
    }
    appState.aiLoading = false;
    renderBlocklistView();
}
```

- [ ] **Step 3: Add applyAISuggestion helper functions**

Add after `fetchAISuggestions`:

```javascript
async function applyAddSuggestion(suggestion) {
    const config = appState.config;
    if (suggestion.type === 'tag') {
        const tags = [...(config.wallhaven.exclude_tags || []), ...suggestion.tags];
        await fetch(`${API_URL}/api/config`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallhaven: { exclude_tags: tags } })
        });
    } else {
        const combos = [...(config.wallhaven.exclude_combos || []), suggestion.tags];
        await fetch(`${API_URL}/api/config`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallhaven: { exclude_combos: combos } })
        });
    }
    await fetchConfig();
    // Mark as applied in UI
    suggestion._applied = true;
    renderBlocklistView();
}

async function applyRemoveSuggestion(suggestion) {
    const config = appState.config;
    if (suggestion.type === 'tag') {
        const tags = (config.wallhaven.exclude_tags || []).filter(
            t => !suggestion.tags.map(s => s.toLowerCase()).includes(t.toLowerCase())
        );
        await fetch(`${API_URL}/api/config`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallhaven: { exclude_tags: tags } })
        });
    } else {
        const removeLower = new Set(suggestion.tags.map(t => t.toLowerCase()));
        const combos = (config.wallhaven.exclude_combos || []).filter(existing => {
            const existingLower = new Set(existing.map(t => t.toLowerCase()));
            if (existingLower.size === removeLower.size &&
                [...removeLower].every(t => existingLower.has(t))) {
                return false;
            }
            return true;
        });
        await fetch(`${API_URL}/api/config`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallhaven: { exclude_combos: combos } })
        });
    }
    await fetchConfig();
    suggestion._applied = true;
    renderBlocklistView();
}
```

- [ ] **Step 4: Add keyboard shortcut for AI analysis**

In `handleGlobalKeydown` (around line 236), add a case in the switch block (around line 336, before the `'s'` case):

```javascript
        case 'a':
            if (appState.mode === 'trash' && !appState.aiLoading) {
                fetchAISuggestions();
            }
            break;
```

- [ ] **Step 5: Commit**

```bash
git add wayper/electron/renderer.js
git commit -m "feat: add AI suggestion fetch, apply, and keyboard shortcut (a key)"
```

---

### Task 6: GUI — AI Results Rendering

**Files:**
- Modify: `wayper/electron/renderer.js`
- Modify: `wayper/electron/styles.css`

- [ ] **Step 1: Add AI button and results rendering to renderBlocklistView**

In `renderBlocklistView()` in `wayper/electron/renderer.js`, find the suggestions bar section (around line 1467, the `else if (!appState.searchQuery && appState.tagSuggestions ...` block). Insert the AI button and results rendering **before** the existing suggestions bar closing brace.

Add right after the existing suggestions bar block (after line 1496, before line 1497's closing `}`):

```javascript
        // AI analysis button
        const aiBtn = document.createElement('button');
        aiBtn.className = 'ai-analyze-btn';
        aiBtn.onclick = () => { if (!appState.aiLoading) fetchAISuggestions(); };
        if (appState.aiLoading) {
            aiBtn.disabled = true;
            aiBtn.innerHTML = '<svg class="spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> Analyzing...';
        } else {
            aiBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22"/><path d="M8 6a4 4 0 0 1 .68-2.24"/><circle cx="12" cy="6" r="1"/></svg> AI Analyze <kbd>A</kbd>';
        }
        bar.appendChild(aiBtn);
```

Then add the AI results display after the suggestions bar (after line 1497):

```javascript
    // AI analysis results
    if (appState.aiSuggestions && !appState.reviewingTag && !appState.searchQuery) {
        const ai = appState.aiSuggestions;
        const aiPanel = document.createElement('div');
        aiPanel.className = 'ai-results-panel';

        if (ai.error) {
            aiPanel.innerHTML = `<div class="ai-error">${ai.error}</div>`;
        } else {
            // Analysis text
            if (ai.analysis) {
                const analysisDiv = document.createElement('div');
                analysisDiv.className = 'ai-analysis-text';
                analysisDiv.textContent = ai.analysis;
                aiPanel.appendChild(analysisDiv);
            }

            // Add suggestions
            if (ai.add_suggestions && ai.add_suggestions.length > 0) {
                const addSection = document.createElement('div');
                addSection.className = 'ai-section';
                addSection.innerHTML = '<div class="ai-section-label">Suggested Additions</div>';
                for (const s of ai.add_suggestions) {
                    const row = document.createElement('div');
                    row.className = 'ai-suggestion-row' + (s._applied ? ' applied' : '');
                    const info = document.createElement('div');
                    info.className = 'ai-suggestion-info';
                    const tagText = s.tags.join(' + ');
                    info.innerHTML = `<span class="ai-suggestion-tags">${tagText}</span>`
                        + `<span class="ai-confidence ai-confidence-${s.confidence}">${s.confidence}</span>`
                        + `<span class="ai-suggestion-reason">${s.reason}</span>`;
                    row.appendChild(info);
                    if (!s._applied) {
                        const btn = document.createElement('button');
                        btn.className = 'ai-btn-accept';
                        btn.textContent = 'Exclude';
                        btn.onclick = () => applyAddSuggestion(s);
                        row.appendChild(btn);
                    } else {
                        const badge = document.createElement('span');
                        badge.className = 'ai-applied-badge';
                        badge.textContent = 'Applied';
                        row.appendChild(badge);
                    }
                    addSection.appendChild(row);
                }
                aiPanel.appendChild(addSection);
            }

            // Remove suggestions
            if (ai.remove_suggestions && ai.remove_suggestions.length > 0) {
                const rmSection = document.createElement('div');
                rmSection.className = 'ai-section';
                rmSection.innerHTML = '<div class="ai-section-label">Suggested Removals</div>';
                for (const s of ai.remove_suggestions) {
                    const row = document.createElement('div');
                    row.className = 'ai-suggestion-row' + (s._applied ? ' applied' : '');
                    const info = document.createElement('div');
                    info.className = 'ai-suggestion-info';
                    const tagText = s.tags.join(' + ');
                    info.innerHTML = `<span class="ai-suggestion-tags">${tagText}</span>`
                        + `<span class="ai-suggestion-reason">${s.reason}</span>`;
                    row.appendChild(info);
                    if (!s._applied) {
                        const btn = document.createElement('button');
                        btn.className = 'ai-btn-remove';
                        btn.textContent = 'Remove';
                        btn.onclick = () => applyRemoveSuggestion(s);
                        row.appendChild(btn);
                    } else {
                        const badge = document.createElement('span');
                        badge.className = 'ai-applied-badge';
                        badge.textContent = 'Removed';
                        row.appendChild(badge);
                    }
                    rmSection.appendChild(row);
                }
                aiPanel.appendChild(rmSection);
            }

            // Close button
            const closeBtn = document.createElement('button');
            closeBtn.className = 'ai-close-btn';
            closeBtn.textContent = 'Dismiss';
            closeBtn.onclick = () => { appState.aiSuggestions = null; renderBlocklistView(); };
            aiPanel.appendChild(closeBtn);
        }

        els.wallpaperGrid.appendChild(aiPanel);
    }
```

- [ ] **Step 2: Add CSS styles for AI UI components**

Append to `wayper/electron/styles.css`:

```css
/* AI Analysis Button */
.ai-analyze-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(203, 166, 247, 0.08);
  border: 1px solid rgba(203, 166, 247, 0.2);
  color: var(--mauve);
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  margin-left: auto;
}

.ai-analyze-btn:hover {
  background: rgba(203, 166, 247, 0.15);
  border-color: rgba(203, 166, 247, 0.35);
}

.ai-analyze-btn:disabled {
  opacity: 0.6;
  cursor: wait;
}

.ai-analyze-btn kbd {
  font-size: 9px;
  padding: 1px 4px;
  border: 1px solid rgba(203, 166, 247, 0.2);
  border-radius: 3px;
  background: rgba(203, 166, 247, 0.06);
  font-family: inherit;
}

.ai-analyze-btn .spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* AI Results Panel */
.ai-results-panel {
  grid-column: 1 / -1;
  background: rgba(203, 166, 247, 0.04);
  border: 1px solid rgba(203, 166, 247, 0.12);
  border-radius: var(--radius);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ai-error {
  color: var(--red);
  font-size: 12px;
}

.ai-analysis-text {
  font-size: 12px;
  line-height: 1.6;
  color: var(--subtext1);
  white-space: pre-wrap;
}

.ai-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ai-section-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 1.2px;
  color: var(--overlay0);
  font-weight: 600;
}

.ai-suggestion-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(69, 71, 90, 0.15);
  transition: opacity 0.2s;
}

.ai-suggestion-row.applied {
  opacity: 0.5;
}

.ai-suggestion-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
}

.ai-suggestion-tags {
  font-weight: 600;
  font-size: 12px;
  color: var(--text);
}

.ai-confidence {
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.ai-confidence-high {
  background: rgba(166, 227, 161, 0.15);
  color: var(--green);
}

.ai-confidence-medium {
  background: rgba(249, 226, 175, 0.15);
  color: var(--yellow);
}

.ai-confidence-low {
  background: rgba(147, 153, 178, 0.15);
  color: var(--overlay1);
}

.ai-suggestion-reason {
  font-size: 11px;
  color: var(--subtext0);
}

.ai-btn-accept {
  background: rgba(243, 139, 168, 0.1);
  border: 1px solid rgba(243, 139, 168, 0.2);
  color: var(--red);
  padding: 3px 10px;
  border-radius: var(--radius);
  font-size: 10px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}

.ai-btn-accept:hover {
  background: rgba(243, 139, 168, 0.18);
  border-color: rgba(243, 139, 168, 0.35);
}

.ai-btn-remove {
  background: rgba(249, 226, 175, 0.1);
  border: 1px solid rgba(249, 226, 175, 0.2);
  color: var(--yellow);
  padding: 3px 10px;
  border-radius: var(--radius);
  font-size: 10px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}

.ai-btn-remove:hover {
  background: rgba(249, 226, 175, 0.18);
  border-color: rgba(249, 226, 175, 0.35);
}

.ai-applied-badge {
  font-size: 10px;
  color: var(--green);
  font-weight: 500;
}

.ai-close-btn {
  align-self: flex-end;
  background: var(--surface0);
  border: 1px solid var(--surface1);
  color: var(--subtext0);
  padding: 4px 12px;
  border-radius: var(--radius);
  font-size: 10px;
  cursor: pointer;
}

.ai-close-btn:hover {
  background: var(--surface1);
}
```

- [ ] **Step 3: Commit**

```bash
git add wayper/electron/renderer.js wayper/electron/styles.css
git commit -m "feat: add AI analysis results panel and styling in GUI"
```

---

### Task 7: End-to-End Verification

**Files:** (none — testing only)

- [ ] **Step 1: Verify Python module loads cleanly**

Run: `cd /home/da/projects/wayper && python -c "from wayper.ai_suggestions import generate_ai_suggestions; from wayper.server.api import app; print('OK')"`
Expected: `OK`

- [ ] **Step 2: Verify CLI command help**

Run: `cd /home/da/projects/wayper && python -m wayper.cli suggest --help`
Expected: Shows `--ai` flag and description

- [ ] **Step 3: Verify ruff passes**

Run: `cd /home/da/projects/wayper && ruff check wayper/ai_suggestions.py wayper/cli.py wayper/server/api.py`
Expected: No errors

- [ ] **Step 4: Launch GUI and test AI button**

Run: `cd /home/da/projects/wayper && python -m wayper.web.launcher`
Expected: GUI launches, trash view shows "AI Analyze" button in suggestions bar, pressing `a` key triggers the analysis

- [ ] **Step 5: Test CLI AI suggestions**

Run: `cd /home/da/projects/wayper && wayper suggest --ai`
Expected: Shows analysis text and suggestion lists (or clear error if claude CLI not available)

- [ ] **Step 6: Test CLI non-AI suggestions**

Run: `cd /home/da/projects/wayper && wayper suggest`
Expected: Shows frequency-based suggestion list

- [ ] **Step 7: Final commit if any fixes needed**

```bash
git add -u
git commit -m "fix: address lint and integration issues for AI suggestions"
```
