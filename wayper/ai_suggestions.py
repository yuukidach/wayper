"""AI-powered tag exclusion suggestions via the local Codex CLI."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path

from .config import WayperConfig
from .pool import (
    favorites_dir,
    list_blacklist,
    list_images,
    load_metadata,
)
from .state import read_mode
from .suggestions import FAV_WEIGHT, KEPT_WEIGHT, suggest_combo_patterns
from .util import atomic_write

log = logging.getLogger("wayper.ai")

# Deterministic guardrails applied after Codex returns suggestions. These keep
# the UI from offering broad excludes that would remove liked content.
MIN_AI_SUPPORT = 3
MIN_AI_PRECISION = 0.85

_AI_SUGGESTION_SCHEMA = {
    "type": "object",
    "properties": {
        "analysis": {"type": "string"},
        "add_suggestions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["tag", "combo", "uploader"]},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "reason": {"type": "string"},
                    "confidence": {
                        "type": "string",
                        "enum": ["high", "medium", "low"],
                    },
                },
                "required": ["type", "tags", "reason", "confidence"],
                "additionalProperties": False,
            },
        },
        "remove_suggestions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["tag", "combo", "uploader"]},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "reason": {"type": "string"},
                },
                "required": ["type", "tags", "reason"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["analysis", "add_suggestions", "remove_suggestions"],
    "additionalProperties": False,
}

_CODEX_MCP_TOOLS = [
    "tag_stats_top",
    "tag_stats_lookup",
    "tag_stats_combo",
    "uploader_stats_lookup",
]

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
    exclude_uploaders: list[str],
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
            "uploaders": exclude_uploaders,
        },
    }
    history.append(entry)
    history = history[-5:]
    atomic_write(path, json.dumps(history, ensure_ascii=False, indent=2))


def _format_history(
    history: list[dict],
    current_tags: list[str],
    current_combos: list[list[str]],
    current_uploaders: list[str],
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
    prev_uploaders = set(last_snap.get("uploaders", []))
    curr_tags = set(current_tags)
    curr_combos = {tuple(c) for c in current_combos}
    curr_uploaders = set(current_uploaders)

    added_tags = curr_tags - prev_tags
    removed_tags = prev_tags - curr_tags
    added_combos = curr_combos - prev_combos
    removed_combos = prev_combos - curr_combos
    added_uploaders = curr_uploaders - prev_uploaders
    removed_uploaders = prev_uploaders - curr_uploaders

    if (
        added_tags
        or removed_tags
        or added_combos
        or removed_combos
        or added_uploaders
        or removed_uploaders
    ):
        lines.append("\n### Changes since last analysis")
        for t in sorted(added_tags):
            lines.append(f"+ tag: {t}")
        for t in sorted(removed_tags):
            lines.append(f"- tag: {t}")
        for c in sorted(added_combos):
            lines.append(f"+ combo: {' + '.join(c)}")
        for c in sorted(removed_combos):
            lines.append(f"- combo: {' + '.join(c)}")
        for u in sorted(added_uploaders):
            lines.append(f"+ uploader: {u}")
        for u in sorted(removed_uploaders):
            lines.append(f"- uploader: {u}")

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


def _clean_values(values: object) -> list[str]:
    """Return non-empty strings, deduped case-insensitively in original order."""
    if not isinstance(values, list):
        return []

    cleaned = []
    seen = set()
    for value in values:
        text = str(value).strip()
        if not text:
            continue
        lower = text.lower()
        if lower in seen:
            continue
        seen.add(lower)
        cleaned.append(text)
    return cleaned


def _lower_values(values: object) -> set[str]:
    return {v.lower() for v in _clean_values(values)}


def _suggestion_type(suggestion: dict, tags: list[str]) -> str:
    raw = str(suggestion.get("type", "")).strip().lower()
    if raw in {"tag", "combo", "uploader"}:
        return raw
    return "combo" if len(tags) > 1 else "tag"


def _meta_tag_lowers(meta: dict) -> set[str]:
    return {str(t).lower() for t in meta.get("tags", []) if str(t).strip()}


def _weighted_precision(banned: int, kept: int, favorites: int) -> float:
    total = banned + kept + FAV_WEIGHT * favorites
    return banned / total if total else 0.0


def _net_benefit(banned: int, kept: int, favorites: int) -> float:
    return banned - KEPT_WEIGHT * kept - FAV_WEIGHT * favorites


def _stats_for_match(metadata: dict, blacklisted: set[str], favorites: set[str], matcher) -> dict:
    stats = {"banned": 0, "kept": 0, "favorites": 0, "banned_files": set()}
    for filename, meta in metadata.items():
        if not matcher(meta):
            continue
        if filename in blacklisted:
            stats["banned"] += 1
            stats["banned_files"].add(filename)
        else:
            stats["kept"] += 1
            if filename in favorites:
                stats["favorites"] += 1

    stats["precision"] = round(
        _weighted_precision(stats["banned"], stats["kept"], stats["favorites"]), 3
    )
    stats["net_benefit"] = round(
        _net_benefit(stats["banned"], stats["kept"], stats["favorites"]), 1
    )
    return stats


def _stats_for_tag(metadata: dict, blacklisted: set[str], favorites: set[str], tag: str) -> dict:
    tag_lower = tag.lower()
    return _stats_for_match(
        metadata,
        blacklisted,
        favorites,
        lambda meta: tag_lower in _meta_tag_lowers(meta),
    )


def _stats_for_combo(
    metadata: dict, blacklisted: set[str], favorites: set[str], tags: list[str]
) -> dict:
    combo_lower = _lower_values(tags)
    return _stats_for_match(
        metadata,
        blacklisted,
        favorites,
        lambda meta: combo_lower.issubset(_meta_tag_lowers(meta)),
    )


def _stats_for_uploader(
    metadata: dict, blacklisted: set[str], favorites: set[str], uploader: str
) -> dict:
    uploader_lower = uploader.lower()
    return _stats_for_match(
        metadata,
        blacklisted,
        favorites,
        lambda meta: str(meta.get("uploader", "")).lower() == uploader_lower,
    )


def _public_stats(stats: dict) -> dict:
    return {
        "banned": stats["banned"],
        "kept": stats["kept"],
        "favorites": stats["favorites"],
        "precision": stats["precision"],
        "net_benefit": stats["net_benefit"],
    }


def _stats_evidence(stats: dict) -> str:
    precision_pct = round(stats["precision"] * 100)
    return (
        f"{stats['banned']} banned, {stats['kept']} kept, {stats['favorites']} fav, "
        f"precision {precision_pct}%, net {stats['net_benefit']:g}"
    )


def _annotate_suggestion(raw: dict, s_type: str, tags: list[str], stats: dict) -> dict:
    suggestion = dict(raw)
    suggestion["type"] = s_type
    suggestion["tags"] = tags
    suggestion["stats"] = _public_stats(stats)

    confidence = str(suggestion.get("confidence", "")).lower()
    if confidence in {"high", "medium", "low"}:
        suggestion["confidence"] = confidence
    else:
        suggestion.pop("confidence", None)

    reason = str(suggestion.get("reason", "")).strip()
    evidence = _stats_evidence(stats)
    suggestion["reason"] = f"{reason} ({evidence})" if reason else evidence
    return suggestion


def _suggestion_key(s_type: str, tags: list[str]) -> tuple[str, tuple[str, ...]]:
    lowers = [t.lower() for t in tags]
    if s_type == "combo":
        lowers = sorted(lowers)
    return s_type, tuple(lowers)


def _has_exact_combo(combos: list[list[str]], tags: list[str]) -> bool:
    candidate = _lower_values(tags)
    return any(_lower_values(combo) == candidate for combo in combos)


def _has_covering_combo(combos: list[list[str]], tags: list[str]) -> bool:
    candidate = _lower_values(tags)
    return any(_lower_values(combo).issubset(candidate) for combo in combos)


def _all_banned_files_from_uploaders(
    stats: dict, metadata: dict, uploader_lowers: set[str]
) -> bool:
    banned_files = stats.get("banned_files", set())
    if not banned_files or not uploader_lowers:
        return False
    for filename in banned_files:
        uploader = str(metadata.get(filename, {}).get("uploader", "")).lower()
        if uploader not in uploader_lowers:
            return False
    return True


def _remove_is_supported(stats: dict, metadata: dict, excluded_uploaders_lower: set[str]) -> bool:
    return (
        stats["favorites"] > 0
        or stats["kept"] > 0
        or stats["banned"] == 0
        or _all_banned_files_from_uploaders(stats, metadata, excluded_uploaders_lower)
    )


def _validate_add_suggestion(
    raw: dict,
    s_type: str,
    tags: list[str],
    metadata: dict,
    blacklisted: set[str],
    favorites: set[str],
    config: WayperConfig,
) -> dict | None:
    excluded_tags_lower = _lower_values(config.wallhaven.exclude_tags)
    excluded_uploaders_lower = _lower_values(config.wallhaven.exclude_uploaders)

    if s_type == "tag":
        if len(tags) != 1 or tags[0].lower() in excluded_tags_lower:
            return None
        stats = _stats_for_tag(metadata, blacklisted, favorites, tags[0])
    elif s_type == "combo":
        if len(tags) < 2 or _has_covering_combo(config.wallhaven.exclude_combos, tags):
            return None
        if _lower_values(tags) & excluded_tags_lower:
            return None
        stats = _stats_for_combo(metadata, blacklisted, favorites, tags)
    elif s_type == "uploader":
        if len(tags) != 1 or tags[0].lower() in excluded_uploaders_lower:
            return None
        stats = _stats_for_uploader(metadata, blacklisted, favorites, tags[0])
    else:
        return None

    if stats["banned"] < MIN_AI_SUPPORT:
        return None
    if stats["favorites"] > 0:
        return None
    if stats["precision"] < MIN_AI_PRECISION or stats["net_benefit"] <= 0:
        return None
    if _all_banned_files_from_uploaders(stats, metadata, excluded_uploaders_lower):
        return None
    return _annotate_suggestion(raw, s_type, tags, stats)


def _validate_remove_suggestion(
    raw: dict,
    s_type: str,
    tags: list[str],
    metadata: dict,
    blacklisted: set[str],
    favorites: set[str],
    config: WayperConfig,
) -> dict | None:
    excluded_tags_lower = _lower_values(config.wallhaven.exclude_tags)
    excluded_uploaders_lower = _lower_values(config.wallhaven.exclude_uploaders)

    if s_type == "tag":
        if len(tags) != 1 or tags[0].lower() not in excluded_tags_lower:
            return None
        stats = _stats_for_tag(metadata, blacklisted, favorites, tags[0])
    elif s_type == "combo":
        if len(tags) < 2 or not _has_exact_combo(config.wallhaven.exclude_combos, tags):
            return None
        stats = _stats_for_combo(metadata, blacklisted, favorites, tags)
    elif s_type == "uploader":
        if len(tags) != 1 or tags[0].lower() not in excluded_uploaders_lower:
            return None
        stats = _stats_for_uploader(metadata, blacklisted, favorites, tags[0])
        if not (stats["favorites"] > 0 or stats["kept"] > 0 or stats["banned"] == 0):
            return None
        return _annotate_suggestion(raw, s_type, tags, stats)
    else:
        return None

    if not _remove_is_supported(stats, metadata, excluded_uploaders_lower):
        return None
    return _annotate_suggestion(raw, s_type, tags, stats)


def _filter_ai_suggestions(
    result: dict,
    metadata: dict,
    blacklisted: set[str],
    favorites: set[str],
    config: WayperConfig,
) -> dict:
    """Validate Codex suggestions against local stats before showing them."""
    parsed = {
        "analysis": str(result.get("analysis", "")),
        "add_suggestions": [],
        "remove_suggestions": [],
    }
    dropped = 0

    for action, validator in (
        ("add_suggestions", _validate_add_suggestion),
        ("remove_suggestions", _validate_remove_suggestion),
    ):
        seen = set()
        for raw in result.get(action, []):
            if not isinstance(raw, dict):
                dropped += 1
                continue
            tags = _clean_values(raw.get("tags", []))
            s_type = _suggestion_type(raw, tags)
            validated = validator(raw, s_type, tags, metadata, blacklisted, favorites, config)
            if not validated:
                dropped += 1
                continue
            key = _suggestion_key(validated["type"], validated["tags"])
            if key in seen:
                dropped += 1
                continue
            seen.add(key)
            parsed[action].append(validated)

    if dropped:
        log.info("Dropped %d AI suggestions that failed deterministic guardrails", dropped)
    return parsed


def _build_rule_health(
    metadata: dict,
    blacklisted: set[str],
    favorites: set[str],
    config: WayperConfig,
    *,
    max_results: int = 15,
) -> list[dict]:
    """Summarize existing exclusions that have collateral or no current support."""
    excluded_uploaders_lower = _lower_values(config.wallhaven.exclude_uploaders)
    items = []

    for tag in config.wallhaven.exclude_tags:
        stats = _stats_for_tag(metadata, blacklisted, favorites, tag)
        if _remove_is_supported(stats, metadata, excluded_uploaders_lower):
            items.append({"type": "tag", "tags": [tag], **_public_stats(stats)})

    for combo in config.wallhaven.exclude_combos:
        stats = _stats_for_combo(metadata, blacklisted, favorites, combo)
        if _remove_is_supported(stats, metadata, excluded_uploaders_lower):
            items.append({"type": "combo", "tags": combo, **_public_stats(stats)})

    for uploader in config.wallhaven.exclude_uploaders:
        stats = _stats_for_uploader(metadata, blacklisted, favorites, uploader)
        if stats["favorites"] > 0 or stats["kept"] > 0 or stats["banned"] == 0:
            items.append({"type": "uploader", "tags": [uploader], **_public_stats(stats)})

    items.sort(key=lambda x: (-x["favorites"], -x["kept"], x["banned"]))
    return items[:max_results]


def _build_prompt(
    banned_count: int,
    kept_count: int,
    fav_count: int,
    exclude_tags: list[str],
    exclude_combos: list[list[str]],
    exclude_uploaders: list[str] | None = None,
    active_purities: set[str] | None = None,
    history: list[dict] | None = None,
    discovered_patterns: list[dict] | None = None,
    recent_bans: list[dict] | None = None,
    cooccurrence: list[dict] | None = None,
    top_uploaders: list[dict] | None = None,
    rule_health: list[dict] | None = None,
) -> str:
    """Build a compact prompt with MCP tool query instructions."""
    purity_str = ", ".join(sorted(active_purities)) if active_purities else "all"
    parts = [
        "Analyze wallpaper tag data to suggest exclusion rules.\n\n"
        "You have access to MCP tools to query tag statistics on demand.\n"
        f"Active purity mode: {purity_str}\n"
        f"Dataset ({purity_str} only): {banned_count} banned, {kept_count} kept, "
        f"{fav_count} favorites.\n\n"
        "## Available Tools\n\n"
        f"1. tag_stats_top(top=30, group='banned', purity='{purity_str}') "
        "— top tags by group count\n"
        "   (group: 'banned', 'kept', or 'favorites')\n"
        f"2. tag_stats_lookup(tags='tag1,tag2', purity='{purity_str}') "
        "— exact ban/kept/fav counts per tag\n"
        f"3. tag_stats_combo(combo='tag1,tag2', purity='{purity_str}') "
        "— count images matching ALL tags\n\n"
        f"4. uploader_stats_lookup(uploaders='name1,name2', purity='{purity_str}') "
        "— exact ban/kept/fav counts per uploader\n\n"
        "IMPORTANT: Always pass the purity parameter to filter by the active mode.\n\n"
        "## Hard Suggestion Constraints\n\n"
        f"- Only suggest additions with at least {MIN_AI_SUPPORT} banned matches.\n"
        f"- Additions must have weighted precision >= {MIN_AI_PRECISION:.0%} using "
        "banned / (banned + kept + 3*favorites).\n"
        f"- Additions must have positive net benefit using banned - {KEPT_WEIGHT}*kept "
        f"- {FAV_WEIGHT}*favorites.\n"
        "- Never suggest adding a rule with any favorite matches.\n"
        "- Never suggest adding a rule already covered by an existing tag, combo, or uploader.\n"
        "- Removal suggestions must target existing rules only, and should be reserved for "
        "rules with kept/favorite collateral, zero current banned support, or redundancy.\n\n"
        "## Workflow\n\n"
        "1. Start with tag_stats_top to see what's common in banned images\n"
        "2. BEFORE suggesting any tag exclusion, ALWAYS verify its kept/fav count\n"
        "   with tag_stats_lookup. A tag with significant kept count must NOT be\n"
        "   suggested as a single exclude.\n"
        "3. For combos, use tag_stats_combo to check precision.\n"
        "4. For uploaders, verify with uploader_stats_lookup before suggesting.\n"
        "5. Keep tool calls to 5-12 total — don't query redundantly.\n\n"
        "CRITICAL RULE: If a tag has significant presence in Kept or Favorites, "
        "the user LIKES that content. NEVER suggest excluding it as a single tag. "
        "Only suggest it in a combo if the combo isolates a specific unwanted subset.\n\n"
        "PRIORITY ORDER for suggestions (most to least valuable):\n"
        "1. SPECIFIC IDENTIFIERS: studio names, photographer names, source sites, "
        "model names — most precise exclusion targets with minimal collateral damage\n"
        "2. NATIONALITY/ETHNICITY tags that distinguish content styles\n"
        "3. STYLE-SPECIFIC descriptors unique to unwanted content genres\n"
        "4. NARROW COMBOS using the specific tags above — only if a single tag "
        "would be too broad\n\n"
        "AVOID suggesting combos of broad/generic tags (e.g. 'nude + women', "
        "'boobs + model') — these catch content the user wants to keep.\n\n"
        "OTHER focus areas:\n"
        "- GENERALIZE individuals: look at co-occurring tags below — if a descriptor "
        "tag appears alongside many excluded individuals, check if it (alone or in a "
        "combo) can replace multiple individual exclusions. This is the HIGHEST VALUE "
        "analysis because it reduces exclude_tags list growth.\n"
        "- UPLOADER patterns: if certain uploaders dominate banned images, suggest "
        "them as candidates for exclude_uploaders (type=uploader).\n"
        "- SEMANTIC clusters: group related specific tags that point to the same "
        "ban pattern\n"
        "- SIMPLIFY existing combos: if one tag in a combo has 0 Kept AND "
        "0 Favorites, it may be upgradeable to a single-tag exclude\n"
        "- OVER-BROAD exclusions: if an excluded tag has significant Kept/Favorites "
        "presence, suggest removing it or replacing with narrower rules\n"
        "- REDUNDANT RULES: if an excluded tag/combo is fully covered by an "
        "excluded uploader (i.e. all banned images with that tag come from an "
        "excluded uploader), suggest removing the redundant tag/combo. Similarly, "
        "if a new uploader exclusion would make existing tag exclusions unnecessary, "
        "mention this in the remove_suggestions.\n\n"
        "IMPORTANT: For uploader suggestions, use type=uploader and put EACH uploader "
        "as a SEPARATE suggestion. Do NOT combine multiple uploaders into one suggestion.\n\n"
        "Respond with ONLY JSON (no markdown):\n"
        '{"analysis":"pattern summary",'
        '"add_suggestions":[{"type":"tag, combo, or uploader","tags":["tag1","tag2"],'
        '"reason":"why","confidence":"high/medium/low"}],'
        '"remove_suggestions":[{"type":"tag, combo, or uploader","tags":["tag1","tag2"],'
        '"reason":"why this rule is wrong or too broad, and what to do instead"}]}\n',
    ]

    # Current exclusion rules
    if exclude_tags:
        parts.append(f"\nExcluded tags: {', '.join(exclude_tags)}\n")
    if exclude_combos:
        parts.append(f"Excluded combos: {'; '.join(' + '.join(c) for c in exclude_combos)}\n")
    if exclude_uploaders:
        parts.append(f"Excluded uploaders: {', '.join(exclude_uploaders)}\n")

    # Statistically discovered patterns (high-precision combos from contrast mining)
    if discovered_patterns:
        parts.append(
            "\n## Discovered Patterns (auto-mined high-precision combos)\n"
            "These tag combinations are statistically associated with banning. "
            "Use them as starting points — look for underlying themes, group related "
            "combos, and suggest higher-level exclusion rules.\n"
            "IMPORTANT: Use tag_stats_lookup to verify each tag's Kept/Fav count "
            "before suggesting any of these.\n"
        )
        for p in discovered_patterns:
            parts.append(
                f"  {' + '.join(p['tags'])} → ban={p['count']}, precision={p['precision']}\n"
            )

    # Co-occurrence analysis — tags shared across excluded individuals
    if cooccurrence:
        parts.append(
            "\n## Co-occurring Tags Across Excluded Individuals\n"
            "These tags frequently appear alongside multiple different excluded tags "
            "in banned images. A tag co-occurring with many excluded individuals may "
            "represent a higher-level pattern — if it has low Kept/Fav count, it could "
            "replace many individual exclusions with one rule.\n"
            "Use tag_stats_lookup to verify before suggesting.\n"
        )
        for c in cooccurrence:
            excluded_list = ", ".join(c["excluded"][:5])
            if c["count"] > 5:
                excluded_list += f" (+{c['count'] - 5} more)"
            parts.append(f"  {c['tag']} — {c['count']} excluded tags: {excluded_list}\n")

    # Top uploaders in banned images
    if top_uploaders:
        parts.append(
            "\n## Uploader Candidates\n"
            "These uploaders pass the same conservative cost/precision screen used by "
            "the UI. Suggest adding them to exclude_uploaders (type=uploader) only if "
            "they still fit the broader pattern. Each uploader MUST be a separate "
            "suggestion.\n"
        )
        for u in top_uploaders:
            ban = u["ban_count"]
            kept = u["kept_count"]
            fav = u["fav_count"]
            total = ban + kept
            rate = ban * 100 // total if total else 0
            parts.append(
                f"  {u['uploader']} — {ban} banned, {kept} kept, {fav} fav ({rate}% ban rate)\n"
            )

    if rule_health:
        parts.append(
            "\n## Existing Rule Health Flags\n"
            "Only suggest removals from this list when the evidence clearly supports it. "
            "Rules with kept/favorite matches are likely over-broad; rules with zero banned "
            "matches may be stale; rules whose banned matches are covered by an excluded "
            "uploader may be redundant.\n"
        )
        for rule in rule_health:
            tags = " + ".join(rule["tags"])
            precision_pct = round(rule["precision"] * 100)
            parts.append(
                f"  {rule['type']}: {tags} — {rule['banned']} banned, "
                f"{rule['kept']} kept, {rule['favorites']} fav, "
                f"precision={precision_pct}%, net={rule['net_benefit']:g}\n"
            )

    # Recent bans — images that escaped current exclusion rules
    if recent_bans:
        parts.append(
            "\n## Recent Bans (escaped current filters)\n"
            "These images slipped through the existing exclusion rules but the user "
            "still disliked them. Find common patterns — they reveal gaps in the "
            "current filter set. Use tag_stats_lookup to check whether recurring tags "
            "here can be safely excluded.\n"
        )
        for b in recent_bans:
            age = b.get("age", "")
            tags = ", ".join(b.get("tags", []))
            parts.append(f"  [{age}] {b['filename']}: {tags}\n")

    # Analysis history for iterative refinement
    if history:
        parts.append(
            _format_history(history, exclude_tags, exclude_combos, exclude_uploaders or [])
        )

    return "".join(parts)


def _find_codex_bin() -> str | None:
    """Find the Codex CLI binary, checking PATH and common install locations."""
    found = shutil.which("codex")
    if found:
        return found
    # PyInstaller / GUI apps often have a stripped PATH — check common locations
    for candidate in (
        Path.home() / ".local" / "bin" / "codex",
        Path.home() / ".npm-global" / "bin" / "codex",
        Path.home() / ".volta" / "bin" / "codex",
        Path.home() / ".local" / "share" / "mise" / "shims" / "codex",
        Path("/opt/homebrew/bin/codex"),
        Path("/usr/local/bin/codex"),
        Path("/Applications/Codex.app/Contents/Resources/codex"),
    ):
        if candidate.is_file():
            return str(candidate)
    return None


def _find_mcp_bin() -> str | None:
    """Find wayper-mcp binary."""
    found = shutil.which("wayper-mcp")
    if found:
        return found
    # Check sibling of current Python interpreter (same venv/bin dir)
    venv_candidate = Path(sys.executable).parent / "wayper-mcp"
    if venv_candidate.is_file():
        return str(venv_candidate)
    # Check sibling of wayper binary (same venv/bin dir)
    wayper_bin = shutil.which("wayper")
    if wayper_bin:
        candidate = Path(wayper_bin).parent / "wayper-mcp"
        if candidate.is_file():
            return str(candidate)
    # Common install locations
    candidate = Path.home() / ".local" / "bin" / "wayper-mcp"
    if candidate.is_file():
        return str(candidate)
    return None


async def _invoke_codex(
    prompt: str, *, use_tools: bool = False, timeout: float = 600.0
) -> tuple[dict, bool]:
    """Call Codex non-interactively and return (parsed JSON, tools_used)."""
    codex_bin = _find_codex_bin()
    if not codex_bin:
        raise AISuggestionError(
            "AI analysis requires the Codex CLI installed and signed in locally. "
            "See https://developers.openai.com/codex/cli",
            code="cli_not_found",
        )

    mcp_bin = _find_mcp_bin() if use_tools else None
    if use_tools:
        if not mcp_bin:
            log.warning("wayper-mcp not found, running AI without tools")
            use_tools = False

    with tempfile.TemporaryDirectory(prefix="wayper-codex-") as temp_dir:
        schema_path = Path(temp_dir) / "ai-suggestion-schema.json"
        schema_path.write_text(json.dumps(_AI_SUGGESTION_SCHEMA), encoding="utf-8")
        cmd = [
            codex_bin,
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--color",
            "never",
            "--cd",
            temp_dir,
            "--output-schema",
            str(schema_path),
        ]
        if use_tools and mcp_bin:
            cmd += [
                "--config",
                f"mcp_servers.wayper.command={json.dumps(mcp_bin)}",
                "--config",
                "mcp_servers.wayper.args=[]",
                "--config",
                "mcp_servers.wayper.required=true",
                "--config",
                f"mcp_servers.wayper.enabled_tools={json.dumps(_CODEX_MCP_TOOLS)}",
                "--config",
                'mcp_servers.wayper.default_tools_approval_mode="approve"',
            ]
        cmd.append("-")

        t0 = time.monotonic()
        log.info("Spawning Codex CLI%s", " with Wayper MCP tools" if use_tools else "")
        proc = await asyncio.create_subprocess_exec(
            *cmd,
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
            elapsed = time.monotonic() - t0
            proc.kill()
            await proc.wait()
            raise AISuggestionError(f"Codex CLI timed out after {elapsed:.1f}s", code="timeout")

    elapsed = time.monotonic() - t0
    stderr_text = stderr.decode().strip()
    if stderr_text:
        log.info("Codex stderr (%d lines): %s", stderr_text.count("\n") + 1, stderr_text[:500])

    if proc.returncode != 0:
        detail = stderr_text or stdout.decode().strip()
        log.warning(
            "Codex CLI failed after %.1fs (exit %d): %s",
            elapsed,
            proc.returncode,
            detail[:300],
        )
        raise AISuggestionError(f"Codex CLI failed (exit {proc.returncode}): {detail}")

    log.info("Codex CLI completed in %.1fs, output %d bytes", elapsed, len(stdout))
    text = stdout.decode().strip()
    # Extract JSON from markdown code blocks if present
    m = re.search(r"```(?:json)?\s*([\s\S]+?)```", text)
    if m:
        text = m.group(1).strip()

    try:
        result = json.loads(text)
    except json.JSONDecodeError as e:
        log.warning("Codex response was not valid JSON: %s", text[:200])
        raise AISuggestionError(f"Codex returned invalid JSON: {e}")
    if not isinstance(result, dict):
        raise AISuggestionError("Codex returned JSON with an unexpected top-level type")
    return result, use_tools


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
    t_start = time.monotonic()
    metadata = load_metadata(config)
    if not metadata:
        raise AISuggestionError("No metadata available. Download some wallpapers first.")

    blacklist_entries = list_blacklist(config)
    if not blacklist_entries:
        raise AISuggestionError("No banned images. Ban some wallpapers first.")

    # Filter to current purity mode — stale data from inactive modes hurts suggestions
    active_purities = read_mode(config)
    metadata = {
        fn: meta for fn, meta in metadata.items() if meta.get("purity", "sfw") in active_purities
    }

    blacklisted = {fn for _, fn in blacklist_entries if fn in metadata}
    fav_files_set: set[str] = set()
    for purity in active_purities:
        for orient in ("landscape", "portrait"):
            for img in list_images(favorites_dir(config, purity, orient)):
                fav_files_set.add(img.name)

    _ai_status["phase"] = "preparing"
    _ai_status["detail"] = "Collecting tags"

    # Check if any banned images have tags
    has_banned_tags = any(metadata.get(fn, {}).get("tags") for fn in blacklisted if fn in metadata)
    if not has_banned_tags:
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

    # --- Co-occurrence analysis: find common tags across excluded individuals ---
    excluded_lower = {t.lower() for t in config.wallhaven.exclude_tags}
    combo_sets_lower = [{t.lower() for t in c} for c in config.wallhaven.exclude_combos]
    cooccur_map: dict[str, set[str]] = {}  # tag → set of excluded tags it co-occurs with
    uploader_ban_count: dict[str, int] = {}
    uploader_kept_count: dict[str, int] = {}
    uploader_fav_count: dict[str, int] = {}

    for fn, meta in metadata.items():
        if not meta:
            continue
        uploader = meta.get("uploader")

        if fn in blacklisted:
            tags = meta.get("tags", [])
            tags_lc = {t.lower() for t in tags}
            matched_lc = tags_lc & excluded_lower
            if matched_lc:
                for tl in tags_lc - excluded_lower:
                    cooccur_map.setdefault(tl, set()).update(matched_lc)
            if uploader:
                uploader_ban_count[uploader] = uploader_ban_count.get(uploader, 0) + 1
        elif uploader:
            if fn in fav_files_set:
                uploader_fav_count[uploader] = uploader_fav_count.get(uploader, 0) + 1
            else:
                uploader_kept_count[uploader] = uploader_kept_count.get(uploader, 0) + 1

    cooccurrence = [
        {"tag": tag, "excluded": sorted(exc), "count": len(exc)}
        for tag, exc in cooccur_map.items()
        if len(exc) >= 3
    ]
    cooccurrence.sort(key=lambda x: -x["count"])
    cooccurrence = cooccurrence[:15]

    # Uploader candidates that pass the same conservative screen as final AI output.
    top_uploaders = [
        {
            "uploader": u,
            "ban_count": c,
            "kept_count": uploader_kept_count.get(u, 0),
            "fav_count": uploader_fav_count.get(u, 0),
        }
        for u, c in sorted(uploader_ban_count.items(), key=lambda x: -x[1])
        if c >= MIN_AI_SUPPORT
        and uploader_fav_count.get(u, 0) == 0
        and _weighted_precision(c, uploader_kept_count.get(u, 0), 0) >= MIN_AI_PRECISION
        and _net_benefit(c, uploader_kept_count.get(u, 0), 0) > 0
        and u.lower() not in _lower_values(config.wallhaven.exclude_uploaders)
    ][:10]

    rule_health = _build_rule_health(metadata, blacklisted, fav_files_set, config)

    # Collect recent bans — only those that escaped current filters
    now = int(datetime.now(UTC).timestamp())
    recent_bans: list[dict] = []
    for ts, fn in blacklist_entries:
        if len(recent_bans) >= 20:
            break
        if fn not in metadata:
            continue
        tags = metadata[fn].get("tags", [])
        if not tags:
            continue
        tags_lower = {t.lower() for t in tags}
        # Skip if covered by existing exclusion rules
        if tags_lower & excluded_lower:
            continue
        if any(cs.issubset(tags_lower) for cs in combo_sets_lower):
            continue
        age_s = now - ts
        if age_s < 3600:
            age = f"{age_s // 60}m ago"
        elif age_s < 86400:
            age = f"{age_s // 3600}h ago"
        else:
            age = f"{age_s // 86400}d ago"
        recent_bans.append({"filename": fn, "tags": tags, "age": age})

    banned_count = len(blacklisted)
    kept_count = sum(1 for fn in metadata if fn not in blacklisted)
    fav_count = len(fav_files_set)

    prompt = _build_prompt(
        banned_count,
        kept_count,
        fav_count,
        config.wallhaven.exclude_tags,
        config.wallhaven.exclude_combos,
        exclude_uploaders=config.wallhaven.exclude_uploaders,
        active_purities=active_purities,
        history=history,
        discovered_patterns=combo_patterns,
        recent_bans=recent_bans,
        cooccurrence=cooccurrence,
        top_uploaders=top_uploaders,
        rule_health=rule_health,
    )

    prompt_kb = len(prompt.encode()) // 1024
    t_prep = time.monotonic() - t_start
    log.info(
        "AI prep done in %.1fs: %d KB prompt, %d history rounds, %d recent bans, %d patterns",
        t_prep,
        prompt_kb,
        len(history),
        len(recent_bans),
        len(combo_patterns),
    )
    _ai_status["phase"] = "analyzing"
    _ai_status["detail"] = f"Sent {prompt_kb}KB to Codex"
    try:
        result, tools_used = await _invoke_codex(prompt, use_tools=True)
        if tools_used:
            _ai_status["detail"] = "Codex queried tag data"
    finally:
        _ai_status["phase"] = None
        _ai_status["detail"] = None

    parsed = _filter_ai_suggestions(result, metadata, blacklisted, fav_files_set, config)
    t_total = time.monotonic() - t_start
    log.info("AI analysis complete in %.1fs total (prep %.1fs)", t_total, t_prep)
    _save_ai_history(
        config.ai_history_file,
        parsed,
        config.wallhaven.exclude_tags,
        config.wallhaven.exclude_combos,
        config.wallhaven.exclude_uploaders,
    )
    return parsed
