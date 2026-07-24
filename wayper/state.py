"""Persistent state: mode, undo log, system trash integration."""

from __future__ import annotations

import time
from pathlib import Path

from .config import WayperConfig
from .process import windows_no_window_kwargs
from .trash import (
    _cleanup_trashinfo,
    _ps_escape,
    _read_trash_map,
    _restore_from_windows_recycle_bin,
    _system_trash_dirs,
    _trash_file,
    _trash_search_dirs,
    _write_trash_map,
    find_in_trash,
    find_many_in_trash,
    pop_undo,
    push_undo,
    restore_from_trash,
    trash_state_token,
)
from .util import atomic_write

ALL_PURITIES = ("sfw", "sketchy", "nsfw")

# The trash implementation moved to ``wayper.trash``.  Keep the old module
# names in the export list so callers (and older plugins) can continue to
# import them from ``wayper.state``.
__all__ = [
    "ALL_PURITIES",
    "read_mode",
    "write_mode",
    "read_last_wallpaper_change",
    "record_wallpaper_change",
    "toggle_base",
    "toggle_purity",
    "purity_from_path",
    "orientation_from_path",
    "windows_no_window_kwargs",
    "find_in_trash",
    "find_many_in_trash",
    "pop_undo",
    "push_undo",
    "restore_from_trash",
    "trash_state_token",
    "_cleanup_trashinfo",
    "_ps_escape",
    "_read_trash_map",
    "_restore_from_windows_recycle_bin",
    "_system_trash_dirs",
    "_trash_file",
    "_trash_search_dirs",
    "_write_trash_map",
]


def _parse_mode(raw: str) -> set[str]:
    """Parse a mode string like 'sfw,sketchy' into a validated set."""
    parts = {p.strip() for p in raw.split(",") if p.strip()}
    valid = parts & set(ALL_PURITIES)
    return valid or {"sfw"}


def read_mode(config: WayperConfig) -> set[str]:
    sf = config.state_file
    if sf.exists():
        raw = sf.read_text().strip()
        if raw:
            return _parse_mode(raw)
    return {"sfw"}


def write_mode(config: WayperConfig, mode: set[str]) -> None:
    config.state_file.parent.mkdir(parents=True, exist_ok=True)
    # Canonical order: sfw, sketchy, nsfw
    ordered = [p for p in ALL_PURITIES if p in mode]
    atomic_write(config.state_file, ",".join(ordered))


def read_last_wallpaper_change(config: WayperConfig) -> float | None:
    """Read the wall-clock timestamp of the last wallpaper change."""
    path = config.download_dir / ".last_rotation"
    try:
        return float(path.read_text().strip())
    except (FileNotFoundError, ValueError, OSError):
        return None


def record_wallpaper_change(config: WayperConfig, when: float | None = None) -> None:
    """Record the timestamp used to schedule the next daemon rotation."""
    config.download_dir.mkdir(parents=True, exist_ok=True)
    atomic_write(
        config.download_dir / ".last_rotation", str(when if when is not None else time.time())
    )


def toggle_base(current: set[str]) -> set[str]:
    """Swap sfw<->nsfw, preserving sketchy membership."""
    result = current.copy()
    if "nsfw" in result:
        result.discard("nsfw")
        result.add("sfw")
    elif "sfw" in result:
        result.discard("sfw")
        result.add("nsfw")
    else:
        # Only sketchy active — add nsfw
        result.add("nsfw")
    return result


def toggle_purity(current: set[str], purity: str) -> set[str]:
    """Toggle a single purity; refuses to remove the last one."""
    result = current.copy()
    if purity in result:
        if len(result) <= 1:
            return current  # Can't remove the last one
        result.discard(purity)
    else:
        result.add(purity)
    return result


def purity_from_path(config: WayperConfig, img: Path) -> str:
    """Determine purity from an image's filesystem path."""
    try:
        rel = img.relative_to(config.download_dir)
        parts = rel.parts
        if parts[0] == "favorites":
            return parts[1] if len(parts) > 1 and parts[1] in ALL_PURITIES else "sfw"
        return parts[0] if parts[0] in ALL_PURITIES else "sfw"
    except (ValueError, IndexError):
        return "sfw"


_ORIENTATIONS = {"landscape", "portrait"}


def orientation_from_path(config: WayperConfig, img: Path) -> str:
    """Determine orientation from an image's filesystem path."""
    try:
        rel = img.relative_to(config.download_dir)
        for part in rel.parts:
            if part in _ORIENTATIONS:
                return part
    except (ValueError, IndexError):
        pass
    return "landscape"
