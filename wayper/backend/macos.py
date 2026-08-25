"""macOS backend: AppKit wallpaper management plus osascript notifications."""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path

from ..config import MonitorConfig, TransitionConfig
from .base import WallpaperBackend

log = logging.getLogger("wayper")

try:
    from AppKit import NSApplication, NSScreen, NSWorkspace
    from Foundation import NSURL

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
    """macOS backend using AppKit for per-display wallpaper management."""

    def set_wallpaper(self, monitor: str, image: Path, transition: TransitionConfig) -> None:
        del transition  # macOS does not expose wallpaper transition controls through AppKit.
        if not _HAS_APPKIT:
            log.warning("AppKit is unavailable; cannot set wallpaper on display %s", monitor)
            return

        screen = next((item for item in NSScreen.screens() if _display_id(item) == monitor), None)
        if screen is None:
            log.warning("macOS display not found: %s", monitor)
            return

        workspace = NSWorkspace.sharedWorkspace()
        options = workspace.desktopImageOptionsForScreen_(screen)
        url = NSURL.fileURLWithPath_(str(image.expanduser().resolve()))
        ok, error = workspace.setDesktopImageURL_forScreen_options_error_(
            url,
            screen,
            options,
            None,
        )
        if not ok:
            log.warning("AppKit failed to set wallpaper %s on %s: %s", image, monitor, error)

    def detect_monitors(self) -> list[MonitorConfig]:
        """Detect current monitor configuration using AppKit."""
        if not _HAS_APPKIT:
            return []

        monitors = []
        for screen in NSScreen.screens():
            frame = screen.frame()
            # NSScreen frames are expressed in logical points. Wallpaper images are
            # composited in the screen's backing coordinate space, so using the frame
            # size directly makes Retina wallpapers half-resolution on each axis.
            backing_frame = screen.convertRectToBacking_(frame)
            width = round(backing_frame.size.width)
            height = round(backing_frame.size.height)
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
