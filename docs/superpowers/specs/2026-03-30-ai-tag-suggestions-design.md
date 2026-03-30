# AI Tag Exclusion Suggestions

**Date:** 2026-03-30
**Status:** Implemented (v1)

## Overview

AI-powered tag exclusion suggestions via the local `claude` CLI. Complements the existing frequency-based suggestion system (`suggestions.py`) with semantic analysis — understanding tag relationships, concept clusters, and combo patterns that statistics alone cannot capture.

## Problem

The existing suggestion system identifies tags that appear disproportionately in disliked images vs the pool. However, it cannot:
- Understand that "anthro", "furry", and "kemono" are semantically related concepts
- Discover tag combination patterns (e.g. "blonde + model" signals unwanted content, but "model" alone is fine)
- Identify over-broad exclusions that are catching wanted content
- Explain *why* certain exclusions would help in natural language

## Design

### Data Preparation

`wayper/ai_suggestions.py` aggregates tag frequencies across three groups:

1. **Disliked images** (blacklist): tag frequencies from all disliked images
2. **Favorites**: tag frequencies from all favorited images
3. **Pool images** (neutral): tag frequencies from kept images

Data is aggregated as `tag(count)` frequencies (top 150 per group), not individual image tag lists. This keeps the prompt compact (~6KB vs ~90KB for per-image lists).

**Context**: Current `exclude_tags` and `exclude_combos` are included so Claude can identify over-broad rules and redundant combos.

### Claude CLI Invocation

```
claude -p --model sonnet < prompt_with_data
```

**Key decisions:**
- **No `--json-schema`**: Constrained decoding is too slow (~150s+). Instead, the prompt instructs Claude to return raw JSON, which is parsed with markdown code block extraction as fallback
- **`--model sonnet`**: Good balance of quality and speed
- **Async execution**: `asyncio.create_subprocess_exec` to avoid blocking the API server
- **180-second timeout**: Analysis typically takes 75-90 seconds
- **`asyncio.Lock`**: Prevents concurrent Claude CLI processes

### Prompt Focus Areas

The prompt directs Claude to focus on:
1. **Combos**: tag pairs/groups that together signal unwanted content, even if each tag alone is acceptable
2. **Simplify existing combos**: if one tag in a combo has 0 pool/favorites, suggest upgrading to single-tag exclude (with care for subgroups)
3. **Semantic clusters**: group related tags pointing to the same dislike pattern
4. **Over-broad exclusions**: flag existing rules catching wanted content, suggest narrower alternatives

### API Endpoints

**`POST /api/ai-suggestions`** — triggers AI analysis, returns results. HTTP 503 if CLI unavailable, 504 on timeout.

**`GET /api/ai-suggestions/status`** — returns `{phase, detail}` for progress polling during analysis.

### GUI Integration

1. **Trigger**: "AI" button in the suggestion bar header (keyboard shortcut: `A`), subdued style that highlights on hover
2. **Loading state**: Pulsing button text showing status detail + elapsed time (e.g. "Sent 6KB to Claude · 45s"), updated via 2-second status polling
3. **Results display**:
   - Analysis text at top with hover-reveal copy button (copies full analysis + all suggestions)
   - **"Suggested Additions"**: New exclusions to add, each with tag(s), reason, confidence badge, and "Exclude" button
   - **"Suggested Removals"**: Over-broad or redundant rules to remove, each with reason and "Remove" button
4. **Applying suggestions**: Each button updates the config via existing endpoint, marks the suggestion as applied
5. **Copy**: Hover the analysis text to reveal a copy button — copies full analysis and all suggestions as text

### Error Handling

| Condition | Behavior |
|-----------|----------|
| `claude` CLI not installed | Error: "AI analysis requires Claude CLI installed locally" (503) |
| CLI invocation timeout (180s) | Timeout error with retry option (504) |
| Claude returns malformed output | JSON parse error logged, error shown to user |
| No disliked images | Error message asking user to dislike some wallpapers first |
| Analysis already in progress | Immediate error, button disabled during analysis |

### Module Structure

```
wayper/
├── ai_suggestions.py    # Tag frequency aggregation + claude CLI invocation
├── suggestions.py       # Frequency-based suggestions (unchanged)
├── server/api.py        # POST /api/ai-suggestions + GET status endpoint
└── electron/
    ├── preload.js       # Clipboard API via contextBridge
    ├── renderer.js      # AI button, status polling, results panel, copy
    └── styles.css       # AI button + results panel styling
```

## Non-Goals

- No periodic/automatic AI analysis — manual trigger only
- No replacing the existing frequency-based system — AI supplements it
- No storing AI analysis results persistently — fresh analysis each time
- No API key management — relies on existing claude CLI authentication
- No image/thumbnail analysis — tags-only (thumbnails made prompts too large)
