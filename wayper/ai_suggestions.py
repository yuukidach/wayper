"""AI-powered tag exclusion suggestions via local claude CLI."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

from .config import WayperConfig
from .pool import (
    ImageMetadata,
    favorites_dir,
    list_blacklist,
    list_images,
    load_metadata,
)
from .state import ALL_PURITIES
from .suggestions import suggest_combo_patterns
from .util import atomic_write

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


def _load_ai_history(path: Path) -> list[dict]:
    """Load all AI analysis history entries."""
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
        if isinstance(data, list):
            return data
    except (json.JSONDecodeError, OSError):
        pass
    return []


def _save_ai_history(
    path: Path,
    result: dict,
    exclude_tags: list[str],
    exclude_combos: list[list[str]],
) -> None:
    """Append an analysis result to the history file (keep last 5)."""
    history = _load_ai_history(path)
    entry = {
        "timestamp": datetime.now(UTC).isoformat(),
        "analysis": result.get("analysis", ""),
        "add_suggestions": result.get("add_suggestions", []),
        "remove_suggestions": result.get("remove_suggestions", []),
        "exclude_snapshot": {
            "tags": exclude_tags,
            "combos": exclude_combos,
        },
    }
    history.append(entry)
    history = history[-5:]
    atomic_write(path, json.dumps(history, ensure_ascii=False, indent=2))


def _format_history(
    history: list[dict],
    current_tags: list[str],
    current_combos: list[list[str]],
) -> str:
    """Format analysis history as a compact timeline for the prompt."""
    if not history:
        return ""

    lines = ["\n## Analysis History\n"]
    lines.append(
        "Reflect on past rounds. Do NOT repeat ignored suggestions. "
        "Build on accepted patterns and deepen your analysis.\n"
    )
    for i, entry in enumerate(history, 1):
        ts = entry.get("timestamp", "")[:10]
        lines.append(f"\n### Round {i} ({ts})")
        lines.append(f"Insight: {entry.get('analysis', 'N/A')}")

        applied = []
        ignored = []
        for section in ("add_suggestions", "remove_suggestions"):
            for s in entry.get(section, []):
                tag_str = " + ".join(s.get("tags", []))
                fb = s.get("feedback")
                if fb and fb.startswith("applied"):
                    applied.append(tag_str)
                else:
                    ignored.append(tag_str)

        if applied:
            lines.append(f"Accepted: {', '.join(applied)}")
        if ignored:
            lines.append(f"Ignored: {', '.join(ignored)}")

    # Diff between last snapshot and current state
    last_snap = history[-1].get("exclude_snapshot", {})
    prev_tags = set(last_snap.get("tags", []))
    prev_combos = {tuple(c) for c in last_snap.get("combos", [])}
    curr_tags = set(current_tags)
    curr_combos = {tuple(c) for c in current_combos}

    added_tags = curr_tags - prev_tags
    removed_tags = prev_tags - curr_tags
    added_combos = curr_combos - prev_combos
    removed_combos = prev_combos - curr_combos

    if added_tags or removed_tags or added_combos or removed_combos:
        lines.append("\n### Changes since last analysis")
        for t in sorted(added_tags):
            lines.append(f"+ tag: {t}")
        for t in sorted(removed_tags):
            lines.append(f"- tag: {t}")
        for c in sorted(added_combos):
            lines.append(f"+ combo: {' + '.join(c)}")
        for c in sorted(removed_combos):
            lines.append(f"- combo: {' + '.join(c)}")

    return "\n".join(lines) + "\n"


def update_ai_history_feedback(path: Path, tags: list[str], action: str) -> None:
    """Record that a suggestion was applied or dismissed.

    action: 'applied_add', 'applied_remove', 'dismissed'
    """
    history = _load_ai_history(path)
    if not history:
        return

    last = history[-1]
    tags_lower = {t.lower() for t in tags}
    for section in ("add_suggestions", "remove_suggestions"):
        for s in last.get(section, []):
            if {t.lower() for t in s.get("tags", [])} == tags_lower:
                s["feedback"] = action
                atomic_write(path, json.dumps(history, ensure_ascii=False, indent=2))
                return


def _build_prompt(
    freq_groups: dict[str, dict],
    exclude_tags: list[str],
    exclude_combos: list[list[str]],
    history: list[dict] | None = None,
    discovered_patterns: list[dict] | None = None,
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
        "PRIORITY ORDER for suggestions (most to least valuable):\n"
        "1. SPECIFIC IDENTIFIERS: studio names, photographer names, source sites, "
        "model names — these are the most precise exclusion targets with minimal "
        "collateral damage (e.g. 'MetArt', 'Femjoy', 'Suicide Girls')\n"
        "2. NATIONALITY/ETHNICITY tags that distinguish content styles "
        "(e.g. 'American women', 'Ukrainian' if the user only bans that origin)\n"
        "3. STYLE-SPECIFIC descriptors unique to unwanted content genres "
        "(e.g. 'studio', 'seductive pose', body-type tags like 'fit body')\n"
        "4. NARROW COMBOS using the specific tags above — only if a single tag "
        "would be too broad (e.g. 'blonde' alone is fine, but 'blonde + studio_name' "
        "targets a specific genre)\n\n"
        "AVOID suggesting combos of broad/generic tags (e.g. 'nude + women', "
        "'boobs + model') — these have high statistical precision but catch "
        "content the user wants to keep. The user's ban pattern is about GENRE "
        "and SOURCE, not about basic content attributes.\n\n"
        "OTHER focus areas:\n"
        "- SEMANTIC clusters: group related specific tags that point to the same "
        "ban pattern (e.g. multiple Western photography studios → one theme)\n"
        "- SIMPLIFY existing combos: if one tag in a combo has 0 Kept AND "
        "0 Favorites, it may be upgradeable to a single-tag exclude\n"
        "- OVER-BROAD exclusions: if an excluded tag has significant Kept/Favorites "
        "presence, suggest removing it or replacing with narrower rules\n\n"
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

    # Statistically discovered patterns (high-precision combos from contrast mining)
    if discovered_patterns:
        parts.append(
            "\n## Discovered Patterns (auto-mined high-precision combos)\n"
            "These tag combinations are statistically associated with banning. "
            "Use them as starting points — look for underlying themes, group related "
            "combos, and suggest higher-level exclusion rules.\n"
        )
        for p in discovered_patterns:
            tags_str = " + ".join(p["tags"])
            parts.append(f"  {tags_str} (ban={p['count']}, precision={p['precision']})\n")

    # Tag frequencies per group
    for label, key in [("Banned", "dislike"), ("Favorites", "favorite"), ("Kept", "pool")]:
        group = freq_groups[key]
        count = group["count"]
        tags = group["tags"]
        parts.append(f"\n## {label} ({count} images)\n")
        if tags:
            parts.append(", ".join(f"{t}({n})" for t, n in tags.items()) + "\n")
        else:
            parts.append("(no tagged images)\n")

    # Analysis history for iterative refinement
    if history:
        parts.append(_format_history(history, exclude_tags, exclude_combos))

    return "".join(parts)


def _find_claude_bin() -> str | None:
    """Find claude CLI binary, checking PATH and common install locations."""
    found = shutil.which("claude")
    if found:
        return found
    # PyInstaller / GUI apps often have a stripped PATH — check common locations
    for candidate in (
        Path.home() / ".local" / "bin" / "claude",
        Path("/usr/local/bin/claude"),
    ):
        if candidate.is_file():
            return str(candidate)
    return None


async def _invoke_claude(prompt: str, timeout: float = 600.0) -> dict:
    """Call claude CLI in print mode and return parsed JSON response."""
    claude_bin = _find_claude_bin()
    if not claude_bin:
        raise AISuggestionError(
            "AI analysis requires Claude CLI installed locally. "
            "Install from https://claude.ai/download",
            code="cli_not_found",
        )

    proc = await asyncio.create_subprocess_exec(
        claude_bin,
        "-p",
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
    if _ai_lock.locked():
        log.warning("AI analysis already in progress, rejecting request")
        raise AISuggestionError("AI analysis already in progress", code="in_progress")
    await _ai_lock.acquire()
    log.info("AI lock acquired, starting analysis")
    try:
        return await _generate_ai_suggestions_impl(config)
    finally:
        _ai_lock.release()
        log.info("AI lock released")


async def _generate_ai_suggestions_impl(config: WayperConfig) -> dict:
    """Internal implementation of AI suggestion generation."""
    metadata = load_metadata(config)
    if not metadata:
        raise AISuggestionError("No metadata available. Download some wallpapers first.")

    blacklist_entries = list_blacklist(config)
    if not blacklist_entries:
        raise AISuggestionError("No banned images. Ban some wallpapers first.")

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
            "No tag metadata found for banned images. "
            "This may happen if images were downloaded before metadata tracking was enabled."
        )

    # Run contrast pattern mining to feed AI with discovered combos
    combo_patterns = suggest_combo_patterns(
        metadata,
        blacklisted,
        config.wallhaven.exclude_tags,
        config.wallhaven.exclude_combos,
        fav_files_set,
        max_results=15,
    )

    history = _load_ai_history(config.ai_history_file)

    prompt = _build_prompt(
        freq_groups,
        config.wallhaven.exclude_tags,
        config.wallhaven.exclude_combos,
        history=history,
        discovered_patterns=combo_patterns,
    )

    prompt_kb = len(prompt.encode()) // 1024
    log.info("AI suggestion request: %d KB prompt, %d history rounds", prompt_kb, len(history))
    _ai_status["phase"] = "analyzing"
    _ai_status["detail"] = f"Sent {prompt_kb}KB to Claude"
    try:
        result = await _invoke_claude(prompt)
    finally:
        _ai_status["phase"] = None
        _ai_status["detail"] = None

    parsed = {
        "analysis": result.get("analysis", ""),
        "add_suggestions": result.get("add_suggestions", []),
        "remove_suggestions": result.get("remove_suggestions", []),
    }
    _save_ai_history(
        config.ai_history_file,
        parsed,
        config.wallhaven.exclude_tags,
        config.wallhaven.exclude_combos,
    )
    return parsed
