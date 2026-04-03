"""AI-powered tag exclusion suggestions via local claude CLI."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
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
    banned_count: int,
    kept_count: int,
    fav_count: int,
    exclude_tags: list[str],
    exclude_combos: list[list[str]],
    active_purities: set[str] | None = None,
    history: list[dict] | None = None,
    discovered_patterns: list[dict] | None = None,
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
        "IMPORTANT: Always pass the purity parameter to filter by the active mode.\n\n"
        "## Workflow\n\n"
        "1. Start with tag_stats_top to see what's common in banned images\n"
        "2. BEFORE suggesting any tag exclusion, ALWAYS verify its kept/fav count\n"
        "   with tag_stats_lookup. A tag with significant kept count must NOT be\n"
        "   suggested as a single exclude.\n"
        "3. For combos, use tag_stats_combo to check precision.\n"
        "4. Keep tool calls to 5-10 total — don't query redundantly.\n\n"
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
        "- SEMANTIC clusters: group related specific tags that point to the same "
        "ban pattern\n"
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
            "IMPORTANT: Use tag_stats_lookup to verify each tag's Kept/Fav count "
            "before suggesting any of these.\n"
        )
        for p in discovered_patterns:
            parts.append(
                f"  {' + '.join(p['tags'])} → ban={p['count']}, precision={p['precision']}\n"
            )

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


def _find_mcp_bin() -> str | None:
    """Find wayper-mcp binary."""
    found = shutil.which("wayper-mcp")
    if found:
        return found
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


async def _invoke_claude(
    prompt: str, *, use_tools: bool = False, timeout: float = 600.0
) -> tuple[dict, bool]:
    """Call claude CLI in print mode and return (parsed JSON, tools_used)."""
    claude_bin = _find_claude_bin()
    if not claude_bin:
        raise AISuggestionError(
            "AI analysis requires Claude CLI installed locally. "
            "Install from https://claude.ai/download",
            code="cli_not_found",
        )

    cmd = [claude_bin, "-p"]
    if use_tools:
        mcp_bin = _find_mcp_bin()
        if mcp_bin:
            # Inline MCP config — works for any user without pre-existing .mcp.json
            mcp_json = json.dumps({"mcpServers": {"wayper": {"command": mcp_bin, "args": []}}})
            cmd += [
                "--mcp-config",
                mcp_json,
                "--allowedTools",
                "mcp__wayper__tag_stats_top mcp__wayper__tag_stats_lookup"
                " mcp__wayper__tag_stats_combo",
            ]
        else:
            log.warning("wayper-mcp not found, running AI without tools")
            use_tools = False

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
        return json.loads(text), use_tools
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

    banned_count = len(blacklisted)
    kept_count = sum(1 for fn in metadata if fn not in blacklisted)
    fav_count = len(fav_files_set)

    prompt = _build_prompt(
        banned_count,
        kept_count,
        fav_count,
        config.wallhaven.exclude_tags,
        config.wallhaven.exclude_combos,
        active_purities=active_purities,
        history=history,
        discovered_patterns=combo_patterns,
    )

    prompt_kb = len(prompt.encode()) // 1024
    log.info(
        "AI suggestion request: %d KB prompt, %d history rounds",
        prompt_kb,
        len(history),
    )
    _ai_status["phase"] = "analyzing"
    _ai_status["detail"] = f"Sent {prompt_kb}KB to Claude"
    try:
        result, tools_used = await _invoke_claude(prompt, use_tools=True)
        if tools_used:
            _ai_status["detail"] = "Claude querying tag data..."
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
