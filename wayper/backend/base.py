"""Backend protocol: abstract interface for platform-specific wallpaper operations."""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path

from ..config import MonitorConfig, TransitionConfig, WayperConfig


class WallpaperBackend(ABC):
    """Platform-specific wallpaper operations."""

    @abstractmethod
    def set_wallpaper(self, monitor: str, image: Path, transition: TransitionConfig) -> None:
        """Set wallpaper on a specific monitor."""

    @abstractmethod
    def get_focused_monitor(self) -> str | None:
        """Get the name of the currently focused monitor."""

    @abstractmethod
    def query_current(self) -> dict[str, Path | None]:
        """Query current wallpaper for each monitor. Returns {monitor_name: image_path}."""

    @abstractmethod
    def notify(self, title: str, message: str, timeout_ms: int = 2000) -> None:
        """Send a desktop notification."""

    def ensure_ready(self) -> None:
        """Ensure the backend is ready (e.g. start required daemons). No-op by default."""


def find_monitor(config: WayperConfig, name: str | None) -> MonitorConfig | None:
    """Find monitor config by name, falling back to first config if only one exists."""
    if name is None:
        return None
    for m in config.monitors:
        if m.name == name:
            return m
    # macOS display IDs change on plug/unplug; fall back if there's only one config
    if len(config.monitors) == 1:
        return config.monitors[0]
    return None


def get_context(
    backend: WallpaperBackend,
    config: WayperConfig,
) -> tuple[str | None, MonitorConfig | None, Path | None]:
    monitor = backend.get_focused_monitor()
    mon_cfg = find_monitor(config, monitor)
    current = backend.query_current()
    img = current.get(monitor) if monitor else None
    return monitor, mon_cfg, img
