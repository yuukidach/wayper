"""Pure configuration mapping used by the HTTP adapter."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from wayper.config import WayperConfig


@dataclass(frozen=True, slots=True)
class ConfigChanges:
    download_dir_changed: bool
    exclude_tags_changed: bool
    exclude_uploaders_changed: bool


def config_payload(config: WayperConfig, mode: set[str]) -> dict[str, object]:
    """Return the public, secret-safe configuration representation."""
    return {
        "download_dir": str(config.download_dir),
        "interval_min": config.interval // 60,
        "mode": sorted(mode),
        "quota_mb": config.quota_mb,
        "proxy": config.proxy or "",
        "pause_on_lock": config.pause_on_lock,
        "safe_mode": config.safe_mode,
        "has_api_key": bool(config.api_key),
        "has_wh_password": bool(config.wallhaven_password),
        "wallhaven_username": config.wallhaven_username,
        "blacklist_ttl_days": config.blacklist_ttl_days,
        "wallhaven": {
            "categories": config.wallhaven.categories,
            "top_range": config.wallhaven.top_range,
            "sorting": config.wallhaven.sorting,
            "ai_art_filter": config.wallhaven.ai_art_filter,
            "batch_size": config.wallhaven.batch_size,
            "min_favorites": config.wallhaven.min_favorites,
            "exclude_tags": config.wallhaven.exclude_tags,
            "exclude_combos": config.wallhaven.exclude_combos,
            "exclude_uploaders": config.wallhaven.exclude_uploaders,
        },
    }


def _deduplicate(items: list, key: Callable[[object], object]) -> list:
    seen: set[object] = set()
    result = []
    for item in items:
        marker = key(item)
        if marker not in seen:
            seen.add(marker)
            result.append(item)
    return result


def apply_config_updates(
    config: WayperConfig,
    updates: dict,
    *,
    resolve_download_dir: Callable[[object], Path],
) -> ConfigChanges:
    """Apply API update values and describe externally visible changes."""
    old_download_dir = config.download_dir
    old_exclude_tags = tuple(config.wallhaven.exclude_tags)
    old_exclude_uploaders = tuple(config.wallhaven.exclude_uploaders)

    if "interval_min" in updates:
        config.interval = updates["interval_min"] * 60
    elif "interval" in updates:
        config.interval = updates["interval"]

    scalar_fields: dict[str, tuple[str, Callable[[object], object]]] = {
        "quota_mb": ("quota_mb", lambda value: value),
        "proxy": ("proxy", lambda value: str(value).strip() or None),
        "pause_on_lock": ("pause_on_lock", bool),
        "safe_mode": ("safe_mode", bool),
        "api_key": ("api_key", lambda value: str(value).strip()),
        "wallhaven_username": ("wallhaven_username", lambda value: str(value).strip()),
        "wallhaven_password": ("wallhaven_password", lambda value: value),
        "blacklist_ttl_days": ("blacklist_ttl_days", lambda value: max(0, int(value))),
    }
    for key, (attribute, transform) in scalar_fields.items():
        if key in updates:
            setattr(config, attribute, transform(updates[key]))

    if "download_dir" in updates:
        config.download_dir = resolve_download_dir(updates["download_dir"])

    wallhaven = updates.get("wallhaven")
    if isinstance(wallhaven, dict):
        for key in ("categories", "top_range", "sorting", "ai_art_filter"):
            if key in wallhaven:
                setattr(config.wallhaven, key, wallhaven[key])
        if "batch_size" in wallhaven:
            config.wallhaven.batch_size = max(1, int(wallhaven["batch_size"]))
        if "min_favorites" in wallhaven:
            config.wallhaven.min_favorites = max(0, int(wallhaven["min_favorites"]))
        if "exclude_tags" in wallhaven:
            config.wallhaven.exclude_tags = _deduplicate(
                wallhaven["exclude_tags"], lambda value: str(value).casefold()
            )
        if "exclude_combos" in wallhaven:
            config.wallhaven.exclude_combos = _deduplicate(
                wallhaven["exclude_combos"],
                lambda combo: frozenset(str(tag).casefold() for tag in combo),
            )
        if "exclude_uploaders" in wallhaven:
            config.wallhaven.exclude_uploaders = _deduplicate(
                wallhaven["exclude_uploaders"], lambda value: str(value).casefold()
            )

    return ConfigChanges(
        download_dir_changed=config.download_dir != old_download_dir,
        exclude_tags_changed=tuple(config.wallhaven.exclude_tags) != old_exclude_tags,
        exclude_uploaders_changed=(
            tuple(config.wallhaven.exclude_uploaders) != old_exclude_uploaders
        ),
    )
