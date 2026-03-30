"""Persistent state: mode, undo log, system trash integration."""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

from .config import WayperConfig
from .util import atomic_write

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
    return {"sfw"}


def write_mode(config: WayperConfig, mode: set[str]) -> None:
    config.state_file.parent.mkdir(parents=True, exist_ok=True)
    # Canonical order: sfw, sketchy, nsfw
    ordered = [p for p in ALL_PURITIES if p in mode]
    atomic_write(config.state_file, ",".join(ordered))


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


# ---------------------------------------------------------------------------
# System trash helpers
# ---------------------------------------------------------------------------


def _system_trash_dirs() -> list[Path]:
    """Return system trash file directories to search, in priority order."""
    if sys.platform == "darwin":
        return [Path.home() / ".Trash"]
    xdg_data = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share")))
    return [xdg_data / "Trash" / "files"]


def _trash_search_dirs() -> list[Path]:
    """Return system trash directories to search."""
    return _system_trash_dirs()


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


def _read_trash_map(config: WayperConfig) -> dict[str, str]:
    """Read the filename → trash path mapping."""
    if not config.trash_map_file.exists():
        return {}
    try:
        return json.loads(config.trash_map_file.read_text())
    except (ValueError, OSError):
        return {}


def _write_trash_map(config: WayperConfig, mapping: dict[str, str]) -> None:
    """Write the filename → trash path mapping."""
    atomic_write(config.trash_map_file, json.dumps(mapping))


def find_in_trash(config: WayperConfig, filename: str) -> Path | None:
    """Find a file in system trash — check stored path first, then scan dirs."""
    # Check stored trash path (works without FDA)
    mapping = _read_trash_map(config)
    stored = mapping.get(filename)
    if stored:
        p = Path(stored)
        if p.exists():
            return p

    # Fallback: scan system trash dirs (requires FDA on macOS)
    for d in _trash_search_dirs():
        candidate = d / filename
        if candidate.exists():
            return candidate
    return None


# ---------------------------------------------------------------------------
# Undo / trash operations
# ---------------------------------------------------------------------------


def _trash_file(config: WayperConfig, src: Path) -> None:
    """Move file to system trash and record the trash path."""
    if not src.exists():
        return

    trash_path: str | None = None

    if sys.platform == "darwin":
        try:
            from AppKit import NSFileManager
            from Foundation import NSURL

            fm = NSFileManager.defaultManager()
            file_url = NSURL.fileURLWithPath_(str(src))
            ok, result_url, err = fm.trashItemAtURL_resultingItemURL_error_(file_url, None, None)
            if ok and result_url:
                trash_path = result_url.path()
        except ImportError:
            import send2trash

            send2trash.send2trash(src)
    else:
        import send2trash

        send2trash.send2trash(src)

    if trash_path:
        mapping = _read_trash_map(config)
        mapping[src.name] = trash_path
        _write_trash_map(config, mapping)


def push_undo(config: WayperConfig, filename: str, original_dir: Path) -> None:
    """Send file to system trash and record in undo log."""
    src = original_dir / filename
    _trash_file(config, src)

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
    atomic_write(config.undo_file, "\n".join(lines[:-1]) + "\n" if lines[:-1] else "")
    return filename, Path(orig_dir_str)


def restore_from_trash(config: WayperConfig, filename: str, dest_dir: Path) -> Path | None:
    """Restore file from system trash to dest_dir."""
    trashed = find_in_trash(config, filename)
    if not trashed:
        return None
    dest = dest_dir / filename
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(trashed), str(dest))
    _cleanup_trashinfo(filename)

    mapping = _read_trash_map(config)
    mapping.pop(filename, None)
    _write_trash_map(config, mapping)

    return dest
