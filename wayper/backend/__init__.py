"""Wallpaper backend: platform dispatch and shared utilities."""

from __future__ import annotations

import fcntl
import os
import sys
from pathlib import Path

from ..config import MonitorConfig, TransitionConfig, WayperConfig
from .base import WallpaperBackend, find_monitor
from .base import get_context as _get_context

LOCK_PATH = Path("/tmp/wayper.lock")


class FileLock:
    """Simple flock-based file lock for state-modifying commands."""

    def __init__(self, *, blocking: bool = True) -> None:
        self._fd: int | None = None
        self._blocking = blocking

    def __enter__(self) -> FileLock:
        self._fd = os.open(str(LOCK_PATH), os.O_WRONLY | os.O_CREAT)
        try:
            flags = fcntl.LOCK_EX if self._blocking else fcntl.LOCK_EX | fcntl.LOCK_NB
            fcntl.flock(self._fd, flags)
        except OSError:
            print("Failed to acquire lock (OSError). Exiting.")
            os.close(self._fd)
            self._fd = None
            raise SystemExit(0)
        return self

    def __exit__(self, *_: object) -> None:
        if self._fd is not None:
            os.close(self._fd)


def _create_backend() -> WallpaperBackend:
    if sys.platform == "darwin":
        from .macos import MacOSBackend

        return MacOSBackend()
    else:
        from .linux import LinuxBackend

        return LinuxBackend()


_backend = _create_backend()


# ── Module-level functions for backward compatibility ──


def set_wallpaper(monitor: str, image: Path, transition: TransitionConfig) -> None:
    _backend.set_wallpaper(monitor, image, transition)


def get_focused_monitor() -> str | None:
    return _backend.get_focused_monitor()


def query_current() -> dict[str, Path | None]:
    return _backend.query_current()


def detect_monitors() -> list[MonitorConfig]:
    """Detect current monitor configuration."""
    return _backend.detect_monitors()


def get_context(config: WayperConfig) -> tuple[str | None, MonitorConfig | None, Path | None]:
    return _get_context(_backend, config)


def notify(title: str, message: str, timeout_ms: int = 2000) -> None:
    _backend.notify(title, message, timeout_ms)


def ensure_ready() -> None:
    _backend.ensure_ready()


def is_locked() -> bool:
    """Check if the session is locked."""
    return _backend.is_locked()


__all__ = [
    "ensure_ready",
    "FileLock",
    "WallpaperBackend",
    "detect_monitors",
    "find_monitor",
    "get_context",
    "get_focused_monitor",
    "is_locked",
    "notify",
    "query_current",
    "set_wallpaper",
]
