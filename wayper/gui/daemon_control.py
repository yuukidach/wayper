"""Daemon control footer bar: status, start/stop, mode toggle, pool stats."""

from __future__ import annotations

import signal
import subprocess
import sys
from pathlib import Path

import objc
from AppKit import (
    NSBezelStyleAccessoryBarAction,
    NSButton,
    NSFont,
    NSMakeRect,
    NSStackView,
    NSStackViewGravityCenter,
    NSStackViewGravityLeading,
    NSStackViewGravityTrailing,
    NSTextField,
    NSTimer,
    NSUserInterfaceLayoutOrientationHorizontal,
    NSView,
)
from Foundation import NSObject
from Quartz import CGColorCreateGenericRGB

from ..config import WayperConfig
from ..daemon import is_daemon_running, signal_daemon
from ..pool import count_images, disk_usage_mb, favorites_dir, pool_dir
from ..state import read_mode, write_mode
from .colors import C_BASE, C_GREEN, C_RED, C_SUBTEXT, C_TEXT


def _find_wayper_cli() -> str:
    """Locate the wayper CLI binary — works inside PyInstaller bundles and venvs."""
    import shutil
    # PyInstaller bundle: cli lives next to the GUI executable
    if getattr(sys, 'frozen', False):
        bundle_dir = Path(sys.executable).parent
        for name in ('wayper-cli', 'wayper'):
            candidate = bundle_dir / name
            if candidate.exists():
                return str(candidate)
    found = shutil.which('wayper')
    if found:
        return found
    return str(Path(sys.executable).parent / 'wayper')


class DaemonControlBar(NSObject):
    """Footer bar with daemon status, mode toggle, and pool stats."""

    def initWithConfig_(self, config):
        self = objc.super(DaemonControlBar, self).init()
        if self is None:
            return None
        self.config = config
        self._timer: NSTimer | None = None
        self._last_state: tuple | None = None
        self.view = self._build_ui()
        self._refresh()
        return self

    def _build_ui(self) -> NSView:
        bar = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 800, 32))
        bar.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        bar.setSpacing_(16)
        bar.setWantsLayer_(True)
        bar.layer().setBackgroundColor_(
            CGColorCreateGenericRGB(C_BASE.redComponent(), C_BASE.greenComponent(),
                                   C_BASE.blueComponent(), 1)
        )

        # Left: daemon status + button
        left = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 300, 28))
        left.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        left.setSpacing_(6)

        daemon_label = NSTextField.labelWithString_("Daemon:")
        daemon_label.setTextColor_(C_SUBTEXT)
        daemon_label.setFont_(NSFont.systemFontOfSize_(11))
        left.addView_inGravity_(daemon_label, NSStackViewGravityLeading)

        self._status_dot = NSTextField.labelWithString_("\u25cf")
        self._status_dot.setFont_(NSFont.systemFontOfSize_(11))
        left.addView_inGravity_(self._status_dot, NSStackViewGravityLeading)

        self._status_text = NSTextField.labelWithString_("")
        self._status_text.setTextColor_(C_TEXT)
        self._status_text.setFont_(NSFont.systemFontOfSize_(11))
        left.addView_inGravity_(self._status_text, NSStackViewGravityLeading)

        self._daemon_btn = NSButton.buttonWithTitle_target_action_("Start", self, "toggleDaemon:")
        self._daemon_btn.setBezelStyle_(NSBezelStyleAccessoryBarAction)
        self._daemon_btn.setFont_(NSFont.systemFontOfSize_(11))
        left.addView_inGravity_(self._daemon_btn, NSStackViewGravityLeading)

        bar.addView_inGravity_(left, NSStackViewGravityLeading)

        # Center: mode toggle
        center = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 150, 28))
        center.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        center.setSpacing_(6)

        mode_label = NSTextField.labelWithString_("Mode:")
        mode_label.setTextColor_(C_SUBTEXT)
        mode_label.setFont_(NSFont.systemFontOfSize_(11))
        center.addView_inGravity_(mode_label, NSStackViewGravityLeading)

        self._mode_btn = NSButton.buttonWithTitle_target_action_("SFW", self, "toggleMode:")
        self._mode_btn.setBezelStyle_(NSBezelStyleAccessoryBarAction)
        self._mode_btn.setFont_(NSFont.systemFontOfSize_(11))
        center.addView_inGravity_(self._mode_btn, NSStackViewGravityLeading)

        bar.addView_inGravity_(center, NSStackViewGravityCenter)

        # Right: pool + disk stats
        right = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 250, 28))
        right.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        right.setSpacing_(12)

        self._pool_label = NSTextField.labelWithString_("")
        self._pool_label.setTextColor_(C_SUBTEXT)
        self._pool_label.setFont_(NSFont.systemFontOfSize_(11))
        right.addView_inGravity_(self._pool_label, NSStackViewGravityTrailing)

        self._disk_label = NSTextField.labelWithString_("")
        self._disk_label.setTextColor_(C_SUBTEXT)
        self._disk_label.setFont_(NSFont.systemFontOfSize_(11))
        right.addView_inGravity_(self._disk_label, NSStackViewGravityTrailing)

        bar.addView_inGravity_(right, NSStackViewGravityTrailing)

        return bar

    # ── Refresh with change detection ──

    def forceRefresh(self):
        """Public API: invalidate cache and refresh UI."""
        self._last_state = None
        self._refresh()

    def _refresh(self):
        # Cheap checks first
        running, _ = is_daemon_running(self.config)
        mode = read_mode(self.config)

        # Quick state check before expensive I/O
        if self._last_state and self._last_state[:2] == (running, mode):
            return

        pool_count = sum(
            count_images(pool_dir(self.config, mode, o))
            for o in ("landscape", "portrait")
        )
        fav_count = sum(
            count_images(favorites_dir(self.config, mode, o))
            for o in ("landscape", "portrait")
        )
        disk_mb = disk_usage_mb(self.config)

        state = (running, mode, pool_count, fav_count, round(disk_mb))
        if state == self._last_state:
            return
        self._last_state = state

        if running:
            self._status_dot.setTextColor_(C_GREEN)
            self._status_text.setStringValue_("Running")
            self._daemon_btn.setTitle_("Stop")
        else:
            self._status_dot.setTextColor_(C_RED)
            self._status_text.setStringValue_("Stopped")
            self._daemon_btn.setTitle_("Start")

        self._mode_btn.setTitle_("NSFW" if mode == "nsfw" else "SFW")
        self._pool_label.setStringValue_(f"Pool: {pool_count}  Fav: {fav_count}")
        self._disk_label.setStringValue_(f"Disk: {disk_mb / 1024:.1f} GB")

    def startPolling(self):
        if self._timer:
            return
        self._timer = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            5.0, self, "pollRefresh:", None, True,
        )

    def stopPolling(self):
        if self._timer:
            self._timer.invalidate()
            self._timer = None

    @objc.typedSelector(b"v@:@")
    def pollRefresh_(self, timer):
        self._refresh()

    # ── Actions ──

    @objc.typedSelector(b"v@:@")
    def toggleDaemon_(self, sender):
        running, pid = is_daemon_running(self.config)
        if running and pid:
            import os
            os.kill(pid, signal.SIGTERM)
        else:
            wayper_bin = _find_wayper_cli()
            subprocess.Popen(
                [wayper_bin, "daemon"],
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            1.0, self, "pollRefresh:", None, False,
        )

    @objc.typedSelector(b"v@:@")
    def toggleMode_(self, sender):
        mode = read_mode(self.config)
        new_mode = "sfw" if mode == "nsfw" else "nsfw"
        write_mode(self.config, new_mode)
        signal_daemon(self.config, signal.SIGUSR2)
        self._last_state = None  # force UI update
        self._refresh()
