"""System trash and undo-log integration."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from .config import WayperConfig
from .process import windows_no_window_kwargs
from .util import atomic_write


def _system_trash_dirs() -> list[Path]:
    """Return system trash file directories to search, in priority order."""
    if sys.platform == "darwin":
        return [Path.home() / ".Trash"]
    if sys.platform == "win32":
        return []
    xdg_data = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share")))
    return [xdg_data / "Trash" / "files"]


def _trash_search_dirs() -> list[Path]:
    """Return system trash directories to search."""
    return _system_trash_dirs()


def _cleanup_trashinfo(filename: str) -> None:
    """Remove .trashinfo metadata for a restored file (Linux/freedesktop only)."""
    if sys.platform in ("darwin", "win32"):
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
        raw = json.loads(config.trash_map_file.read_text())
    except (ValueError, OSError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {str(filename): path for filename, path in raw.items() if isinstance(path, str) and path}


def _write_trash_map(config: WayperConfig, mapping: dict[str, str]) -> None:
    """Write the filename → trash path mapping."""
    atomic_write(config.trash_map_file, json.dumps(mapping))


def find_in_trash(config: WayperConfig, filename: str) -> Path | None:
    """Find a file in system trash — check stored path first, then scan dirs."""
    if sys.platform == "win32":
        return None

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


def find_many_in_trash(config: WayperConfig, filenames: set[str]) -> dict[str, Path]:
    """Find multiple files in system trash while reading trash state once."""
    if not filenames or sys.platform == "win32":
        return {}

    found: dict[str, Path] = {}
    mapping = _read_trash_map(config)
    stored_by_parent: dict[Path, list[tuple[str, Path]]] = {}
    for filename in filenames:
        stored = mapping.get(filename)
        if not stored:
            continue
        path = Path(stored)
        stored_by_parent.setdefault(path.parent, []).append((filename, path))

    for parent, paths in stored_by_parent.items():
        try:
            names = {path.name for path in parent.iterdir()}
        except OSError:
            for filename, path in paths:
                if path.exists():
                    found[filename] = path
            continue

        for filename, path in paths:
            if path.name in names:
                found[filename] = path

    remaining = filenames - found.keys()
    if not remaining:
        return found

    for directory in _trash_search_dirs():
        if not directory.is_dir():
            continue
        try:
            names = {path.name for path in directory.iterdir()}
        except OSError:
            continue
        for filename in remaining & names:
            found[filename] = directory / filename
        remaining -= names
        if not remaining:
            break

    return found


def trash_state_token(config: WayperConfig) -> tuple[int, ...]:
    """Return mtimes that affect trash lookup results."""

    def mtime(path: Path) -> int:
        try:
            return path.stat().st_mtime_ns
        except OSError:
            return 0

    return (mtime(config.trash_map_file), *(mtime(path) for path in _trash_search_dirs()))


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


def _restore_from_windows_recycle_bin(filename: str, dest_dir: Path) -> Path | None:
    """Restore a file from the Windows Recycle Bin by filename using Shell.Application."""
    script = rf"""
$ErrorActionPreference = 'SilentlyContinue'
$targetName = '{_ps_escape(filename)}'
$dest = '{_ps_escape(str(dest_dir))}'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$shell = New-Object -ComObject Shell.Application
$recycle = $shell.Namespace(10)
$items = @($recycle.Items() | Where-Object {{ $_.Name -eq $targetName }})
if ($items.Count -eq 0) {{ exit 1 }}
$item = $items[0]
$item.InvokeVerb('undelete')
$deadline = (Get-Date).AddSeconds(8)
do {{
    $found = Get-ChildItem -Path $dest -Filter $targetName -Recurse -File `
        -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {{
        Write-Output $found.FullName
        exit 0
    }}
    Start-Sleep -Milliseconds 200
}} while ((Get-Date) -lt $deadline)
exit 2
"""
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
            capture_output=True,
            text=True,
            timeout=12,
            check=False,
            **windows_no_window_kwargs(),
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None

    if result.returncode != 0:
        return None
    restored = result.stdout.strip().splitlines()[-1:] or []
    if not restored:
        return None
    path = Path(restored[0])
    return path if path.exists() else None


def _ps_escape(value: str) -> str:
    return value.replace("'", "''")


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
    if sys.platform == "win32":
        restored = _restore_from_windows_recycle_bin(filename, dest_dir)
        if restored is None:
            return None
        mapping = _read_trash_map(config)
        mapping.pop(filename, None)
        _write_trash_map(config, mapping)
        return restored

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
