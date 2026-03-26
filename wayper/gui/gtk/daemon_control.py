"""GTK4 daemon control footer bar: status, start/stop, pool stats."""

from __future__ import annotations

import shutil
import signal
import subprocess
import sys
from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import GLib, Gtk

from ...config import WayperConfig
from ...daemon import is_daemon_running
from ...pool import count_images, disk_usage_mb, favorites_dir, pool_dir
from ...state import read_mode


def _find_wayper_cli() -> str:
    """Locate the wayper CLI binary."""
    found = shutil.which("wayper")
    if found:
        return found
    return str(Path(sys.executable).parent / "wayper")


class DaemonControlBar:
    """Footer bar with daemon status, start/stop, and pool stats."""

    def __init__(self, config: WayperConfig):
        self.config = config
        self._timer_id: int | None = None
        self._last_state: tuple | None = None
        self.widget = self._build()
        self._refresh()

    def _build(self) -> Gtk.Box:
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

        # Right: stats
        self._stats_label = Gtk.Label(label="")
        self._stats_label.add_css_class("stats-label")
        bar.append(self._stats_label)

        return bar

    # ── Refresh ──

    def force_refresh(self):
        self._last_state = None
        self._refresh()

    def _refresh(self):
        running, _ = is_daemon_running(self.config)
        mode = read_mode(self.config)

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

    # ── Polling ──

    def start_polling(self):
        if self._timer_id is not None:
            return
        self._timer_id = GLib.timeout_add_seconds(5, self._poll_refresh)

    def stop_polling(self):
        if self._timer_id is not None:
            GLib.source_remove(self._timer_id)
            self._timer_id = None

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

