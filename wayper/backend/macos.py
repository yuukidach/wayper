"""macOS backend: osascript + AppKit."""

from __future__ import annotations

import subprocess
from pathlib import Path

from ..config import MonitorConfig, TransitionConfig
from .base import WallpaperBackend

try:
    from AppKit import NSApplication, NSScreen, NSWorkspace

    # Hide Python from Dock — background service, not a GUI app
    # 2 = NSApplicationActivationPolicyProhibited
    NSApplication.sharedApplication().setActivationPolicy_(2)

    _HAS_APPKIT = True
except ImportError:
    _HAS_APPKIT = False

try:
    import Quartz

    _HAS_QUARTZ = True
except ImportError:
    _HAS_QUARTZ = False


def _display_id(screen) -> str:
    return str(screen.deviceDescription()["NSScreenNumber"])


class MacOSBackend(WallpaperBackend):
    """macOS backend using osascript for wallpaper setting, AppKit for queries."""

    def set_wallpaper(self, monitor: str, image: Path, transition: TransitionConfig) -> None:
        safe_path = str(image).replace("\\", "\\\\").replace('"', '\\"')
        script = (
            'tell application "System Events" to '
            f'tell every desktop to set picture to POSIX file "{safe_path}"'
        )
        subprocess.run(
            ["osascript", "-e", script],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def detect_monitors(self) -> list[MonitorConfig]:
        """Detect current monitor configuration using AppKit."""
        if not _HAS_APPKIT:
            return []

        monitors = []
        for screen in NSScreen.screens():
            frame = screen.frame()
            width = int(frame.size.width)
            height = int(frame.size.height)
            # NSScreen coordinates are points, not pixels, but orientation is correct
            orientation = "portrait" if height > width else "landscape"
            name = _display_id(screen)
            monitors.append(
                MonitorConfig(name=name, width=width, height=height, orientation=orientation)
            )
        return monitors

    def get_focused_monitor(self) -> str | None:
        if not _HAS_APPKIT:
            return None

        main = NSScreen.mainScreen()
        if main is None:
            return None
        return _display_id(main)

    def query_current(self) -> dict[str, Path | None]:
        if not _HAS_APPKIT:
            return {}

        workspace = NSWorkspace.sharedWorkspace()
        current: dict[str, Path | None] = {}
        for screen in NSScreen.screens():
            url = workspace.desktopImageURLForScreen_(screen)
            current[_display_id(screen)] = Path(url.path()) if url else None
        return current

    @staticmethod
    def _screen_for_monitor(monitor: str):
        for screen in NSScreen.screens():
            if _display_id(screen) == monitor:
                return screen
        return None

    def is_locked(self) -> bool:
        """Check if the session is locked."""
        if _HAS_QUARTZ:
            d = Quartz.CGSessionCopyCurrentDictionary()
            # CGSSessionScreenIsLocked is 1 if locked, usually absent if not
            return bool(d and d.get("CGSSessionScreenIsLocked"))
        return False

    def notify(self, title: str, message: str, timeout_ms: int = 2000) -> None:
        safe_msg = message.replace("\\", "\\\\").replace('"', '\\"')
        safe_title = title.replace("\\", "\\\\").replace('"', '\\"')
        script = f'display notification "{safe_msg}" with title "{safe_title}"'
        subprocess.Popen(
            ["osascript", "-e", script],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
