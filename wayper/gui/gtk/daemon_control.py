"""GTK4 daemon control footer bar: status, start/stop, pool stats, expandable detail panel."""

from __future__ import annotations

import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import GLib, Gtk

from ...backend import query_current
from ...config import WayperConfig
from ...daemon import compute_daemon_state, is_daemon_running, read_last_rotation
from ...pool import disk_usage_mb


def _find_wayper_cli() -> str:
    """Locate the wayper CLI binary."""
    found = shutil.which("wayper")
    if found:
        return found
    return str(Path(sys.executable).parent / "wayper")


class DaemonControlBar:
    """Footer bar with daemon status, start/stop, pool stats, and expandable detail panel."""

    def __init__(self, config: WayperConfig):
        self.config = config
        self._timer_id: int | None = None
        self._countdown_timer_id: int | None = None
        self._last_state: tuple | None = None
        self.widget = self._build()
        self._refresh()

    def _build(self) -> Gtk.Box:
        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        # ── Compact bar ──
        bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        bar.add_css_class("daemon-bar")

        # Left: status dot + text + button
        self._status_dot = Gtk.Label(label="\u25cf")
        bar.append(self._status_dot)

        self._status_text = Gtk.Label(label="")
        bar.append(self._status_text)

        self._daemon_btn = Gtk.Button(label="Start")
        self._daemon_btn.add_css_class("action-btn")
        self._daemon_btn.connect("clicked", lambda _: self._toggle_daemon())
        bar.append(self._daemon_btn)

        # Spacer
        spacer = Gtk.Box()
        spacer.set_hexpand(True)
        bar.append(spacer)

        # Arrow toggle button
        self._arrow_btn = Gtk.ToggleButton()
        self._arrow_btn.set_icon_name("pan-down-symbolic")
        self._arrow_btn.add_css_class("action-btn")
        self._arrow_btn.connect("toggled", self._on_arrow_toggled)
        bar.append(self._arrow_btn)

        # Stats label
        self._stats_label = Gtk.Label(label="")
        self._stats_label.add_css_class("stats-label")
        bar.append(self._stats_label)

        # Inline quota bar
        self._quota_bar_inline = Gtk.ProgressBar()
        self._quota_bar_inline.add_css_class("quota-bar-inline")
        self._quota_bar_inline.set_size_request(60, -1)
        self._quota_bar_inline.set_valign(Gtk.Align.CENTER)
        bar.append(self._quota_bar_inline)

        outer.append(bar)

        # ── Revealer with detail panel ──
        self._revealer = Gtk.Revealer()
        self._revealer.set_transition_type(Gtk.RevealerTransitionType.SLIDE_DOWN)
        self._revealer.set_reveal_child(False)

        detail = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        detail.add_css_class("detail-panel")

        # Quota progress bar
        self._quota_bar = Gtk.ProgressBar()
        self._quota_bar.add_css_class("quota-bar")
        detail.append(self._quota_bar)

        # Quota label
        self._quota_label = Gtk.Label(label="", xalign=0)
        detail.append(self._quota_label)

        # PID label
        self._pid_label = Gtk.Label(label="PID: --", xalign=0)
        detail.append(self._pid_label)

        # Countdown label
        self._countdown_label = Gtk.Label(label="Next rotation: --:--", xalign=0)
        detail.append(self._countdown_label)

        # Per-monitor info container
        self._monitor_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        detail.append(self._monitor_box)

        self._revealer.set_child(detail)
        outer.append(self._revealer)

        return outer

    # ── Arrow toggle ──

    def _on_arrow_toggled(self, btn: Gtk.ToggleButton) -> None:
        expanded = btn.get_active()
        self._revealer.set_reveal_child(expanded)
        btn.set_icon_name("pan-up-symbolic" if expanded else "pan-down-symbolic")

        if expanded:
            self._update_detail_panel()
            self._start_countdown_timer()
        else:
            self._stop_countdown_timer()

    # ── Detail panel updates ──

    def _update_detail_panel(self) -> None:
        """Update all detail panel fields."""
        config = self.config
        running, pid = is_daemon_running(config)

        disk_mb = disk_usage_mb(config)
        fraction = disk_mb / config.quota_mb if config.quota_mb > 0 else 0
        fraction = min(fraction, 1.0)

        self._quota_bar.set_fraction(fraction)
        self._quota_bar.remove_css_class("warning")
        self._quota_bar.remove_css_class("critical")
        if fraction > 0.95:
            self._quota_bar.add_css_class("critical")
        elif fraction > 0.80:
            self._quota_bar.add_css_class("warning")

        self._quota_label.set_label(f"Disk: {round(disk_mb)} MB / {config.quota_mb} MB")

        # PID
        self._pid_label.set_label(f"PID: {pid}" if pid else "PID: --")

        # Countdown
        self._update_countdown()

        # Per-monitor info
        self._update_monitor_info()

    def _update_countdown(self) -> None:
        last_rot = read_last_rotation(self.config)
        if last_rot is None:
            self._countdown_label.set_label("Next rotation: --:--")
            return
        remaining = (last_rot + self.config.interval) - time.time()
        if remaining < 0:
            remaining = 0
        mm = int(remaining) // 60
        ss = int(remaining) % 60
        self._countdown_label.set_label(f"Next rotation: {mm:02d}:{ss:02d}")

    def _update_monitor_info(self) -> None:
        # Clear existing labels
        child = self._monitor_box.get_first_child()
        while child is not None:
            next_child = child.get_next_sibling()
            self._monitor_box.remove(child)
            child = next_child

        try:
            current = query_current()
        except Exception:
            return

        for monitor_name, path in current.items():
            filename = path.name if path else "—"
            label = Gtk.Label(label=f"{monitor_name}: {filename}", xalign=0)
            self._monitor_box.append(label)

    # ── Countdown timer ──

    def _start_countdown_timer(self) -> None:
        if self._countdown_timer_id is not None:
            return
        self._countdown_timer_id = GLib.timeout_add_seconds(1, self._countdown_tick)

    def _stop_countdown_timer(self) -> None:
        if self._countdown_timer_id is not None:
            GLib.source_remove(self._countdown_timer_id)
            self._countdown_timer_id = None

    def _countdown_tick(self) -> bool:
        if not self._revealer.get_reveal_child():
            self._countdown_timer_id = None
            return False
        self._update_countdown()
        return True

    # ── Refresh ──

    def force_refresh(self):
        self._last_state = None
        self._refresh()

    def _refresh(self):
        state = compute_daemon_state(self.config)
        if state == self._last_state:
            return
        self._last_state = state
        running, mode, pool_count, fav_count, disk_mb = state

        if running:
            self._status_dot.remove_css_class("status-dot-stopped")
            self._status_dot.add_css_class("status-dot-running")
            self._status_text.set_label("Running")
            self._daemon_btn.set_label("Stop")
        else:
            self._status_dot.remove_css_class("status-dot-running")
            self._status_dot.add_css_class("status-dot-stopped")
            self._status_text.set_label("Stopped")
            self._daemon_btn.set_label("Start")

        self._stats_label.set_label(
            f"Pool {pool_count} \u00b7 Fav {fav_count} \u00b7 {disk_mb / 1024:.1f} GB"
        )

        # Update inline quota bar
        fraction = disk_mb / self.config.quota_mb if self.config.quota_mb > 0 else 0
        self._quota_bar_inline.set_fraction(min(fraction, 1.0))

        # Update detail panel if visible
        if self._revealer.get_reveal_child():
            self._update_detail_panel()

    # ── Polling ──

    def start_polling(self):
        if self._timer_id is not None:
            return
        self._timer_id = GLib.timeout_add_seconds(5, self._poll_refresh)

    def stop_polling(self):
        if self._timer_id is not None:
            GLib.source_remove(self._timer_id)
            self._timer_id = None
        self._stop_countdown_timer()

    def _poll_refresh(self) -> bool:
        self._refresh()
        return True

    # ── Actions ──

    def _toggle_daemon(self):
        import os

        running, pid = is_daemon_running(self.config)
        if running and pid:
            os.kill(pid, signal.SIGTERM)
        else:
            wayper_bin = _find_wayper_cli()
            subprocess.Popen(
                [wayper_bin, "daemon"],
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        GLib.timeout_add_seconds(1, self._delayed_refresh)

    def _delayed_refresh(self) -> bool:
        self._last_state = None
        self._refresh()
        return False  # one-shot
