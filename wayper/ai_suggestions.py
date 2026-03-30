"""AI-powered tag exclusion suggestions via local claude CLI."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
from collections import Counter

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
    """Aggregate tag frequencies per group in a single pass.

    Returns dict with keys: dislike, favorite, pool.
    Each value has: count (int), tags (dict[str, int]).
    """
    result = {k: {"count": 0, "tags": Counter()} for k in ("dislike", "favorite", "pool")}

    for filename, meta in metadata.items():
        tags = meta.get("tags", [])
        if not tags:
            continue
        key = (
            "dislike"
            if filename in blacklisted
            else "favorite"
            if filename in fav_files
            else "pool"
        )
        result[key]["count"] += 1
        result[key]["tags"].update(tags)

    for group in result.values():
        group["tags"] = dict(group["tags"].most_common(150))

    return result


def _build_prompt(
    freq_groups: dict[str, dict],
    exclude_tags: list[str],
    exclude_combos: list[list[str]],
) -> str:
    """Build a compact prompt using aggregated tag frequencies."""
    parts = [
        "Analyze wallpaper tag frequencies to suggest exclusion rules.\n\n"
        "Three groups below:\n"
        "- Disliked: images the user explicitly rejected\n"
        "- Favorites: images the user explicitly favorited\n"
        "- Kept: images the user chose to keep (positive signal, NOT neutral)\n\n"
        "CRITICAL RULE: If a tag has significant presence in Kept or Favorites, "
        "the user LIKES that content. NEVER suggest excluding it as a single tag. "
        "Only suggest it in a combo if the combo isolates a specific unwanted subset "
        "(e.g. 'nude' alone is liked, but 'nude + specific_studio' might be unwanted).\n\n"
        "Focus areas:\n"
        "1. COMBOS: tag pairs/groups that together signal unwanted content, "
        "even if each tag alone is fine (e.g. 'blonde + model' is unwanted "
        "but 'model' alone is fine since it appears in Kept too)\n"
        "2. SIMPLIFY existing combos: if one tag in a combo has 0 Kept AND 0 Favorites, "
        "it MAY be upgradeable to single-tag exclude — but check if the tag crosses "
        "subgroups the user might want to keep (e.g. 'pornstar' spans both Western and Asian)\n"
        "3. SEMANTIC clusters: group related tags that point to the same dislike pattern "
        "(e.g. several AV studio names, or overlapping video game tags)\n"
        "4. OVER-BROAD exclusions: if an excluded tag also has significant Kept/Favorites "
        "presence, the rule is too wide — suggest removing it or replacing with a narrower "
        "combo (e.g. 'video games' excluded but 'video game girls' has 45 Kept images "
        "→ remove 'video games', add specific combos instead)\n\n"
        "Respond with ONLY JSON (no markdown):\n"
        '{"analysis":"pattern summary",'
        '"add_suggestions":[{"type":"tag or combo","tags":["tag1","tag2"],'
        '"reason":"why","confidence":"high/medium/low"}],'
        '"remove_suggestions":[{"type":"tag or combo","tags":["tag1","tag2"],'
        '"reason":"why this rule is wrong or too broad, and what to do instead"}]}\n',
    ]

    # Current exclusion rules
    if exclude_tags:
        parts.append(f"\nExcluded tags: {', '.join(exclude_tags)}\n")
    if exclude_combos:
        parts.append(f"Excluded combos: {'; '.join(' + '.join(c) for c in exclude_combos)}\n")

    # Tag frequencies per group
    for label, key in [("Disliked", "dislike"), ("Favorites", "favorite"), ("Kept", "pool")]:
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

    proc = await asyncio.create_subprocess_exec(
        claude_bin,
        "-p",
        "--model",
        "sonnet",
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

    text = stdout.decode().strip()
    # Extract JSON from markdown code blocks if present
    m = re.search(r"```(?:json)?\s*([\s\S]+?)```", text)
    if m:
        text = m.group(1).strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        log.warning("Claude response was not valid JSON: %s", text[:200])
        raise AISuggestionError(f"Claude returned invalid JSON: {e}")


async def generate_ai_suggestions(config: WayperConfig) -> dict:
    """Generate AI-powered tag exclusion suggestions.

    Returns dict with keys: analysis, add_suggestions, remove_suggestions.
    Raises AISuggestionError on failure.
    """
    try:
        await asyncio.wait_for(_ai_lock.acquire(), timeout=0)
    except TimeoutError:
        raise AISuggestionError("AI analysis already in progress", code="in_progress")
    try:
        return await _generate_ai_suggestions_impl(config)
    finally:
        _ai_lock.release()


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
