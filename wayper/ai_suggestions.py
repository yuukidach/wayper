"""AI-powered tag exclusion suggestions via local claude CLI."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import random
import shutil
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
from .state import ALL_PURITIES, find_in_trash

log = logging.getLogger("wayper.ai")


class AISuggestionError(Exception):
    """Raised when AI suggestion generation fails."""


def _collect_tag_groups(
    config: WayperConfig,
    metadata: dict[str, ImageMetadata],
) -> dict[str, list[list[str]]]:
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
                mime = (
                    "image/jpeg" if suffix in (".jpg", ".jpeg") else f"image/{suffix.lstrip('.')}"
                )
                results.append(f"data:{mime};base64,{b64}")
            except OSError:
                continue
        return results

    # Dislike: most recent 20 by timestamp
    dislike_paths: list[Path] = []
    for _, fn in blacklisted_entries[:20]:
        found = False
        for purity in ALL_PURITIES:
            for orient in ("landscape", "portrait"):
                candidate = pool_dir(config, purity, orient) / fn
                if candidate.exists():
                    dislike_paths.append(candidate)
                    found = True
                    break
            if found:
                break
        # Also check trash if not found in pool
        if not found:
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
    tag_groups: dict[str, list[list[str]]],
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
        parts.append(f"{i + 1}. {', '.join(tags)}\n")

    parts.append(f"\n## Favorite Images ({len(tag_groups['favorite'])} images)\n")
    for i, tags in enumerate(tag_groups["favorite"]):
        parts.append(f"{i + 1}. {', '.join(tags)}\n")

    parts.append(f"\n## Pool Images ({len(tag_groups['pool'])} images, sampled)\n")
    for i, tags in enumerate(tag_groups["pool"]):
        parts.append(f"{i + 1}. {', '.join(tags)}\n")

    # Image samples
    for group_name, label in [("dislike", "Disliked"), ("favorite", "Favorite"), ("pool", "Pool")]:
        imgs = thumbnails.get(group_name, [])
        if imgs:
            parts.append(f"\n## Sample {label} Images\n")
            for uri in imgs:
                parts.append(f"![{label} sample]({uri})\n")

    return "".join(parts)


async def _invoke_claude(prompt: str, timeout: float = 60.0) -> dict:
    """Call claude CLI in print mode and return parsed JSON response."""
    claude_bin = shutil.which("claude")
    if not claude_bin:
        raise AISuggestionError("Claude CLI not found. Install it from https://claude.ai/download")

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
        except json.JSONDecodeError as e:
            raise AISuggestionError(f"Claude returned malformed JSON in result wrapper: {e}")

    return result


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

    if not tag_groups["dislike"]:
        raise AISuggestionError(
            "No tag metadata found for disliked images. "
            "This may happen if images were downloaded before metadata tracking was enabled."
        )

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
