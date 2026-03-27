"""Daemon control footer bar: status, start/stop, pool stats, expandable detail panel."""

from __future__ import annotations

import signal
import subprocess
import sys
import time
from pathlib import Path

import objc
from AppKit import (
    NSAnimationContext,
    NSBezelStyleRounded,
    NSButton,
    NSFont,
    NSImage,
    NSMakeRect,
    NSProgressIndicator,
    NSProgressIndicatorBarStyle,
    NSStackView,
    NSStackViewGravityLeading,
    NSStackViewGravityTrailing,
    NSTextField,
    NSTimer,
    NSUserInterfaceLayoutOrientationHorizontal,
    NSUserInterfaceLayoutOrientationVertical,
    NSView,
)
from Foundation import NSObject
from Quartz import CABasicAnimation

from ...backend import query_current
from ...daemon import compute_daemon_state, is_daemon_running, read_last_rotation
from ...pool import disk_usage_mb
from .colors import C_GREEN, C_MANTLE_CG, C_RED, C_SUBTEXT, C_TEXT


def _find_wayper_cli() -> str:
    """Locate the wayper CLI binary — works inside PyInstaller bundles and venvs."""
    import shutil

    # PyInstaller bundle: cli lives next to the GUI executable
    if getattr(sys, "frozen", False):
        bundle_dir = Path(sys.executable).parent
        for name in ("wayper-cli", "wayper"):
            candidate = bundle_dir / name
            if candidate.exists():
                return str(candidate)
    found = shutil.which("wayper")
    if found:
        return found
    return str(Path(sys.executable).parent / "wayper")


class DaemonControlBar(NSObject):
    """Footer bar with daemon status, start/stop, pool stats, and expandable detail panel."""

    def initWithConfig_(self, config):
        self = objc.super(DaemonControlBar, self).init()
        if self is None:
            return None
        self.config = config
        self._timer: NSTimer | None = None
        self._countdown_timer: NSTimer | None = None
        self._last_state: tuple | None = None
        self._detail_visible = False
        self.view = self._build_ui()
        self._refresh()
        return self

    def _build_ui(self) -> NSView:
        outer = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 800, 32))
        outer.setOrientation_(NSUserInterfaceLayoutOrientationVertical)
        outer.setSpacing_(4)

        # ── Compact bar ──
        bar = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 800, 28))
        bar.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        bar.setSpacing_(8)
        bar.setWantsLayer_(True)
        bar.layer().setBackgroundColor_(C_MANTLE_CG)
        bar.layer().setCornerRadius_(8)

        # Left: daemon status dot + text + start/stop button
        self._status_dot = NSTextField.labelWithString_("\u25cf")
        self._status_dot.setFont_(NSFont.systemFontOfSize_(11))
        self._status_dot.setWantsLayer_(True)
        bar.addView_inGravity_(self._status_dot, NSStackViewGravityLeading)

        self._status_text = NSTextField.labelWithString_("")
        self._status_text.setTextColor_(C_TEXT)
        self._status_text.setFont_(NSFont.systemFontOfSize_(11))
        bar.addView_inGravity_(self._status_text, NSStackViewGravityLeading)

        self._daemon_btn = NSButton.buttonWithTitle_target_action_("Start", self, "toggleDaemon:")
        self._daemon_btn.setBezelStyle_(NSBezelStyleRounded)
        self._daemon_btn.setFont_(NSFont.systemFontOfSize_(11))
        self._daemon_btn.setContentTintColor_(C_GREEN)
        bar.addView_inGravity_(self._daemon_btn, NSStackViewGravityLeading)

        # Inline quota bar
        self._quota_bar_inline = NSProgressIndicator.alloc().initWithFrame_(
            NSMakeRect(0, 0, 60, 12)
        )
        self._quota_bar_inline.setStyle_(NSProgressIndicatorBarStyle)
        self._quota_bar_inline.setIndeterminate_(False)
        self._quota_bar_inline.setMinValue_(0)
        self._quota_bar_inline.setMaxValue_(100)
        bar.addView_inGravity_(self._quota_bar_inline, NSStackViewGravityTrailing)

        # Right: stats
        self._stats_label = NSTextField.labelWithString_("")
        self._stats_label.setTextColor_(C_SUBTEXT)
        self._stats_label.setFont_(NSFont.monospacedSystemFontOfSize_weight_(11, 0))
        bar.addView_inGravity_(self._stats_label, NSStackViewGravityTrailing)

        # Detail toggle button (SF Symbol chevron)
        chevron_img = NSImage.imageWithSystemSymbolName_accessibilityDescription_(
            "chevron.down", "Details"
        )
        self._detail_btn = NSButton.buttonWithImage_target_action_(
            chevron_img, self, "toggleDetail:"
        )
        self._detail_btn.setBezelStyle_(NSBezelStyleRounded)
        self._detail_btn.setContentTintColor_(C_SUBTEXT)
        bar.addView_inGravity_(self._detail_btn, NSStackViewGravityTrailing)

        outer.addView_inGravity_(bar, NSStackViewGravityLeading)

        # ── Detail panel ──
        detail = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 800, 100))
        detail.setOrientation_(NSUserInterfaceLayoutOrientationVertical)
        detail.setSpacing_(4)
        detail.setAlignment_(6)  # NSLayoutAttributeLeading
        detail.setWantsLayer_(True)
        detail.layer().setBackgroundColor_(C_MANTLE_CG)
        detail.layer().setCornerRadius_(8)

        # Full quota bar
        self._quota_bar = NSProgressIndicator.alloc().initWithFrame_(NSMakeRect(0, 0, 780, 14))
        self._quota_bar.setStyle_(NSProgressIndicatorBarStyle)
        self._quota_bar.setIndeterminate_(False)
        self._quota_bar.setMinValue_(0)
        self._quota_bar.setMaxValue_(100)
        detail.addView_inGravity_(self._quota_bar, NSStackViewGravityLeading)

        self._quota_label = NSTextField.labelWithString_("Disk: -- MB / -- MB")
        self._quota_label.setTextColor_(C_SUBTEXT)
        self._quota_label.setFont_(NSFont.systemFontOfSize_(11))
        detail.addView_inGravity_(self._quota_label, NSStackViewGravityLeading)

        self._pid_label = NSTextField.labelWithString_("PID: --")
        self._pid_label.setTextColor_(C_SUBTEXT)
        self._pid_label.setFont_(NSFont.systemFontOfSize_(11))
        detail.addView_inGravity_(self._pid_label, NSStackViewGravityLeading)

        self._countdown_label = NSTextField.labelWithString_("Next rotation: --:--")
        self._countdown_label.setTextColor_(C_SUBTEXT)
        self._countdown_label.setFont_(NSFont.systemFontOfSize_(11))
        detail.addView_inGravity_(self._countdown_label, NSStackViewGravityLeading)

        # Per-monitor info container
        self._monitor_box = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 780, 20))
        self._monitor_box.setOrientation_(NSUserInterfaceLayoutOrientationVertical)
        self._monitor_box.setSpacing_(2)
        detail.addView_inGravity_(self._monitor_box, NSStackViewGravityLeading)

        self._detail_panel = detail
        self._detail_panel.setHidden_(True)
        outer.addView_inGravity_(detail, NSStackViewGravityLeading)

        return outer

    # ── Detail toggle ──

    @objc.typedSelector(b"v@:@")
    def toggleDetail_(self, sender):
        self._detail_visible = not self._detail_visible
        symbol = "chevron.up" if self._detail_visible else "chevron.down"
        img = NSImage.imageWithSystemSymbolName_accessibilityDescription_(symbol, "Details")
        self._detail_btn.setImage_(img)

        if self._detail_visible:
            self._update_detail_panel()
            self._start_countdown_timer()
        else:
            self._stop_countdown_timer()

        NSAnimationContext.runAnimationGroup_completionHandler_(
            lambda ctx: (
                ctx.setDuration_(0.2),
                self._detail_panel.animator().setHidden_(not self._detail_visible),
            ),
            None,
        )

    # ── Detail panel updates ──

    def _update_detail_panel(self):
        config = self.config
        running, pid = is_daemon_running(config)

        disk_mb = disk_usage_mb(config)
        fraction = disk_mb / config.quota_mb if config.quota_mb > 0 else 0
        fraction = min(fraction, 1.0)

        self._quota_bar.setDoubleValue_(fraction * 100)
        self._quota_label.setStringValue_(f"Disk: {round(disk_mb)} MB / {config.quota_mb} MB")
        self._pid_label.setStringValue_(f"PID: {pid}" if pid else "PID: --")

        self._update_countdown()
        self._update_monitor_info()

    def _update_countdown(self):
        last_rot = read_last_rotation(self.config)
        if last_rot is None:
            self._countdown_label.setStringValue_("Next rotation: --:--")
            return
        remaining = (last_rot + self.config.interval) - time.time()
        if remaining < 0:
            remaining = 0
        mm = int(remaining) // 60
        ss = int(remaining) % 60
        self._countdown_label.setStringValue_(f"Next rotation: {mm:02d}:{ss:02d}")

    def _update_monitor_info(self):
        # Clear existing labels
        for sub in list(self._monitor_box.views()):
            self._monitor_box.removeView_(sub)

        try:
            current = query_current()
        except Exception:
            return

        for monitor_name, path in current.items():
            filename = path.name if path else "\u2014"
            lbl = NSTextField.labelWithString_(f"{monitor_name}: {filename}")
            lbl.setTextColor_(C_SUBTEXT)
            lbl.setFont_(NSFont.systemFontOfSize_(11))
            self._monitor_box.addView_inGravity_(lbl, NSStackViewGravityLeading)

    # ── Countdown timer ──

    def _start_countdown_timer(self):
        if self._countdown_timer:
            return
        self._countdown_timer = (
            NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
                1.0, self, "countdownTick:", None, True
            )
        )

    def _stop_countdown_timer(self):
        if self._countdown_timer:
            self._countdown_timer.invalidate()
            self._countdown_timer = None

    @objc.typedSelector(b"v@:@")
    def countdownTick_(self, timer):
        if not self._detail_visible:
            self._stop_countdown_timer()
            return
        self._update_countdown()

    # ── Refresh with change detection ──

    def forceRefresh(self):
        """Public API: invalidate cache and refresh UI."""
        self._last_state = None
        self._refresh()

    def _refresh(self):
        state = compute_daemon_state(self.config)
        if state == self._last_state:
            return
        self._last_state = state
        running, mode, pool_count, fav_count, disk_mb = state

        if running:
            self._status_dot.setTextColor_(C_GREEN)
            self._status_text.setStringValue_("Running")
            self._daemon_btn.setTitle_("Stop")
            self._daemon_btn.setContentTintColor_(C_RED)
            # Pulse animation on status dot
            if not self._status_dot.layer().animationForKey_("pulse"):
                pulse = CABasicAnimation.animationWithKeyPath_("opacity")
                pulse.setFromValue_(1.0)
                pulse.setToValue_(0.4)
                pulse.setDuration_(1.0)
                pulse.setAutoreverses_(True)
                pulse.setRepeatCount_(float("inf"))
                self._status_dot.layer().addAnimation_forKey_(pulse, "pulse")
        else:
            self._status_dot.setTextColor_(C_RED)
            self._status_text.setStringValue_("Stopped")
            self._daemon_btn.setTitle_("Start")
            self._daemon_btn.setContentTintColor_(C_GREEN)
            self._status_dot.layer().removeAnimationForKey_("pulse")

        self._stats_label.setStringValue_(
            f"Pool {pool_count} \u00b7 Fav {fav_count} \u00b7 {disk_mb / 1024:.1f} GB"
        )

        # Update inline quota bar
        fraction = disk_mb / self.config.quota_mb if self.config.quota_mb > 0 else 0
        self._quota_bar_inline.setDoubleValue_(min(fraction, 1.0) * 100)

        # Update detail panel if visible
        if self._detail_visible:
            self._update_detail_panel()

    def startPolling(self):
        if self._timer:
            return
        self._timer = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            5.0,
            self,
            "pollRefresh:",
            None,
            True,
        )

    def stopPolling(self):
        if self._timer:
            self._timer.invalidate()
            self._timer = None
        self._stop_countdown_timer()

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
            1.0,
            self,
            "pollRefresh:",
            None,
            False,
        )
