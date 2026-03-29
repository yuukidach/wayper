"""Persistent state: mode, undo log, system trash integration."""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from .config import WayperConfig

ALL_PURITIES = ("sfw", "sketchy", "nsfw")


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
    return _parse_mode(config.default_mode)


def write_mode(config: WayperConfig, mode: set[str]) -> None:
    config.state_file.parent.mkdir(parents=True, exist_ok=True)
    # Canonical order: sfw, sketchy, nsfw
    ordered = [p for p in ALL_PURITIES if p in mode]
    config.state_file.write_text(",".join(ordered))


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


# ---------------------------------------------------------------------------
# System trash helpers
# ---------------------------------------------------------------------------


def _system_trash_dirs() -> list[Path]:
    """Return system trash file directories to search, in priority order."""
    if sys.platform == "darwin":
        return [Path.home() / ".Trash"]
    xdg_data = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share")))
    return [xdg_data / "Trash" / "files"]


def _trash_search_dirs(config: WayperConfig) -> list[Path]:
    """All directories to search for trashed files: system + legacy."""
    dirs = _system_trash_dirs()
    # Legacy .trash/ fallback
    dirs.extend(
        [
            config.trash_dir / "sfw",
            config.trash_dir / "sketchy",
            config.trash_dir / "nsfw",
            config.trash_dir,
        ]
    )
    return dirs


def _cleanup_trashinfo(filename: str) -> None:
    """Remove .trashinfo metadata for a restored file (Linux/freedesktop only)."""
    if sys.platform == "darwin":
        return
    xdg_data = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share")))
    trashinfo = xdg_data / "Trash" / "info" / f"{filename}.trashinfo"
    try:
        trashinfo.unlink(missing_ok=True)
    except OSError:
        pass


def find_in_trash(config: WayperConfig, filename: str) -> Path | None:
    """Find a file in system trash or legacy .trash/ directory."""
    for d in _trash_search_dirs(config):
        candidate = d / filename
        if candidate.exists():
            return candidate
    return None


# ---------------------------------------------------------------------------
# Undo / trash operations
# ---------------------------------------------------------------------------


def push_undo(config: WayperConfig, filename: str, original_dir: Path) -> None:
    """Send file to system trash and record in undo log."""
    import send2trash

    src = original_dir / filename
    if src.exists():
        try:
            send2trash.send2trash(src)
        except Exception:
            # Fallback: move to legacy .trash/ if system trash fails (e.g. cross-mount)
            trash = config.trash_dir
            trash.mkdir(parents=True, exist_ok=True)
            src.rename(trash / filename)

    with open(config.undo_file, "a") as f:
        f.write(f"{filename} {original_dir}\n")


def pop_undo(config: WayperConfig) -> tuple[str, Path] | None:
    """Pop last undo entry. Returns (filename, original_dir) or None."""
    if not config.undo_file.exists():
        return None
    lines = config.undo_file.read_text().splitlines()
    if not lines:
        return None

    last = lines[-1]
    parts = last.split(maxsplit=1)
    if len(parts) != 2:
        return None

    filename, orig_dir_str = parts
    config.undo_file.write_text("\n".join(lines[:-1]) + "\n" if lines[:-1] else "")
    return filename, Path(orig_dir_str)


def restore_from_trash(config: WayperConfig, filename: str, dest_dir: Path) -> Path | None:
    """Restore file from system trash or legacy .trash/ to dest_dir."""
    trashed = find_in_trash(config, filename)
    if not trashed:
        return None
    dest = dest_dir / filename
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(trashed), str(dest))
    _cleanup_trashinfo(filename)
    return dest
