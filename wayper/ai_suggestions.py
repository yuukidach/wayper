"""AI-powered tag exclusion suggestions via local claude CLI."""

from __future__ import annotations

import asyncio
import json
import logging
import shutil

from .config import WayperConfig
from .pool import (
    ImageMetadata,
    favorites_dir,
    list_blacklist,
    list_images,
    load_metadata,
)
from .state import ALL_PURITIES

log = logging.getLogger("wayper.ai")

# Module-level status for UI polling
_ai_status: dict[str, str | None] = {"phase": None, "detail": None}
_ai_lock = asyncio.Lock()


def get_ai_status() -> dict[str, str | None]:
    """Return current AI analysis status for UI polling."""
    return dict(_ai_status)


class AISuggestionError(Exception):
    """Raised when AI suggestion generation fails."""

    def __init__(self, message: str, *, code: str = "error") -> None:
        super().__init__(message)
        self.code = code


def _collect_tag_frequencies(
    metadata: dict[str, ImageMetadata],
    blacklisted: set[str],
    fav_files: set[str],
) -> dict[str, dict]:
    """Aggregate tag frequencies per group instead of listing individual images.

    Returns dict with keys: dislike, favorite, pool.
    Each value has: count (int), tags (dict[str, int]).
    """
    from collections import Counter

    groups: dict[str, list[list[str]]] = {"dislike": [], "favorite": [], "pool": []}

    for filename, meta in metadata.items():
        tags = meta.get("tags", [])
        if not tags:
            continue
        if filename in blacklisted:
            groups["dislike"].append(tags)
        elif filename in fav_files:
            groups["favorite"].append(tags)
        else:
            groups["pool"].append(tags)

    result = {}
    for group, tag_lists in groups.items():
        freq: Counter[str] = Counter()
        for tags in tag_lists:
            freq.update(tags)
        # Keep only top 150 most frequent tags — rare tags are noise
        result[group] = {"count": len(tag_lists), "tags": dict(freq.most_common(150))}

    return result


AI_SCHEMA = {
    "type": "object",
    "required": ["analysis", "add_suggestions", "remove_suggestions"],
    "properties": {
        "analysis": {
            "type": "string",
            "description": (
                "Natural language analysis of dislike patterns and exclusion rule health"
            ),
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
    freq_groups: dict[str, dict],
    exclude_tags: list[str],
    exclude_combos: list[list[str]],
) -> str:
    """Build a compact prompt using aggregated tag frequencies."""
    parts = [
        "Analyze wallpaper tag data to suggest exclusion rule changes. "
        "Data shows tag frequencies across three groups: Disliked (user rejected), "
        "Favorites (user saved), Pool (kept, neutral). "
        "Format: tag(count) — count = number of images with that tag.\n\n"
        "Tasks:\n"
        "1. Find tags/combos uniquely overrepresented in dislikes vs favorites+pool\n"
        "2. Suggest new exclusions (tags appearing mostly in dislikes)\n"
        "3. Flag existing exclusions to remove (if the tag also appears often in "
        "favorites/pool, it's a false positive)\n"
        "4. Brief analysis of patterns\n\n"
        "Tags are from Wallhaven. Consider semantic relationships.\n",
    ]

    # Current exclusion rules
    parts.append("## Current Exclusions\n")
    if exclude_tags:
        parts.append(f"Tags: {', '.join(exclude_tags)}\n")
    if exclude_combos:
        parts.append(f"Combos: {'; '.join(' + '.join(c) for c in exclude_combos)}\n")
    if not exclude_tags and not exclude_combos:
        parts.append("(none)\n")

    # Tag frequencies per group
    for label, key in [("Disliked", "dislike"), ("Favorites", "favorite"), ("Pool", "pool")]:
        group = freq_groups[key]
        count = group["count"]
        tags = group["tags"]
        parts.append(f"\n## {label} ({count} images)\n")
        if tags:
            parts.append(", ".join(f"{t}({n})" for t, n in tags.items()) + "\n")
        else:
            parts.append("(no tagged images)\n")

    return "".join(parts)


async def _invoke_claude(prompt: str, timeout: float = 180.0) -> dict:
    """Call claude CLI in print mode and return parsed JSON response."""
    claude_bin = shutil.which("claude")
    if not claude_bin:
        raise AISuggestionError(
            "AI analysis requires Claude CLI installed locally. "
            "Install from https://claude.ai/download",
            code="cli_not_found",
        )

    schema_json = json.dumps(AI_SCHEMA)
    proc = await asyncio.create_subprocess_exec(
        claude_bin,
        "-p",
        "--model",
        "sonnet",
        "--output-format",
        "json",
        "--json-schema",
        schema_json,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(input=prompt.encode()),
            timeout=timeout,
        )
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise AISuggestionError(f"Claude CLI timed out after {timeout}s", code="timeout")

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
        except json.JSONDecodeError as e:
            raise AISuggestionError(f"Claude returned malformed JSON in result wrapper: {e}")

    return result


async def generate_ai_suggestions(config: WayperConfig) -> dict:
    """Generate AI-powered tag exclusion suggestions.

    Returns dict with keys: analysis, add_suggestions, remove_suggestions.
    Raises AISuggestionError on failure.
    """
    if _ai_lock.locked():
        raise AISuggestionError("AI analysis already in progress")

    async with _ai_lock:
        return await _generate_ai_suggestions_impl(config)


async def _generate_ai_suggestions_impl(config: WayperConfig) -> dict:
    """Internal implementation of AI suggestion generation."""
    metadata = load_metadata(config)
    if not metadata:
        raise AISuggestionError("No metadata available. Download some wallpapers first.")

    blacklist_entries = list_blacklist(config)
    if not blacklist_entries:
        raise AISuggestionError("No disliked images. Dislike some wallpapers first.")

    blacklisted = {fn for _, fn in blacklist_entries}
    fav_files_set: set[str] = set()
    for purity in ALL_PURITIES:
        for orient in ("landscape", "portrait"):
            for img in list_images(favorites_dir(config, purity, orient)):
                fav_files_set.add(img.name)

    _ai_status["phase"] = "preparing"
    _ai_status["detail"] = "Collecting tags"
    freq_groups = _collect_tag_frequencies(metadata, blacklisted, fav_files_set)

    if not freq_groups["dislike"]["tags"]:
        raise AISuggestionError(
            "No tag metadata found for disliked images. "
            "This may happen if images were downloaded before metadata tracking was enabled."
        )

    prompt = _build_prompt(
        freq_groups,
        config.wallhaven.exclude_tags,
        config.wallhaven.exclude_combos,
    )

    prompt_kb = len(prompt.encode()) // 1024
    log.info("Sending AI suggestion request (%d KB prompt)", prompt_kb)
    _ai_status["phase"] = "analyzing"
    _ai_status["detail"] = f"Sent {prompt_kb}KB to Claude"
    try:
        result = await _invoke_claude(prompt)
    finally:
        _ai_status["phase"] = None
        _ai_status["detail"] = None

    return {
        "analysis": result.get("analysis", ""),
        "add_suggestions": result.get("add_suggestions", []),
        "remove_suggestions": result.get("remove_suggestions", []),
    }
