"""Persistent state: mode, undo log, trash."""

from __future__ import annotations

from pathlib import Path

from .config import WayperConfig

MAX_UNDO = 5


def read_mode(config: WayperConfig) -> str:
    sf = config.state_file
    if sf.exists():
        return sf.read_text().strip() or config.default_mode
    return config.default_mode


def write_mode(config: WayperConfig, mode: str) -> None:
    config.state_file.parent.mkdir(parents=True, exist_ok=True)
    config.state_file.write_text(mode)


def push_undo(config: WayperConfig, filename: str, original_dir: Path) -> None:
    """Move file to trash and record in undo log. Trim to MAX_UNDO entries."""
    config.trash_dir.mkdir(parents=True, exist_ok=True)
    src = original_dir / filename
    if src.exists():
        src.rename(config.trash_dir / filename)

    with open(config.undo_file, "a") as f:
        f.write(f"{filename} {original_dir}\n")

    # Trim old entries
    lines = config.undo_file.read_text().splitlines()
    if len(lines) > MAX_UNDO:
        for old_line in lines[:-MAX_UNDO]:
            old_name = old_line.split(maxsplit=1)[0]
            old_trash = config.trash_dir / old_name
            old_trash.unlink(missing_ok=True)
        config.undo_file.write_text("\n".join(lines[-MAX_UNDO:]) + "\n")


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
    """Move file from trash back to dest_dir. Returns final path or None."""
    trashed = config.trash_dir / filename
    if not trashed.exists():
        return None
    dest = dest_dir / filename
    trashed.rename(dest)
    return dest
