"""GTK4 quick actions panel: current wallpaper preview + navigation + rating."""

from __future__ import annotations

from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gdk, GLib, Gtk

from ...backend import get_focused_monitor, query_current
from ...config import WayperConfig
from ..actions import (
    do_dislike,
    do_favorite,
    do_next,
    do_open_wallhaven,
    do_prev,
    do_undislike,
    do_unfavorite,
)


class ActionsPanel:
    """Quick actions: preview current wallpaper + action buttons."""

    def __init__(self, config: WayperConfig):
        self.config = config
        self._current_path: Path | None = None
        self._current_monitor: str | None = None
        self._target_monitor: str | None = None  # None = auto (focused)
        self._timer_id: int | None = None
        self.widget = self._build()
        self._refresh()

    def _build(self) -> Gtk.Box:
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
        root.set_margin_start(20)
        root.set_margin_end(20)
        root.set_margin_top(12)
        root.set_margin_bottom(12)
        root.set_vexpand(True)
        root.set_hexpand(True)

        # Preview
        self._preview = Gtk.Picture()
        self._preview.set_content_fit(Gtk.ContentFit.CONTAIN)
        self._preview.set_can_shrink(True)
        self._preview.set_vexpand(True)
        self._preview.add_css_class("preview-area")
        root.append(self._preview)

        # Info bar
        info_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        info_bar.set_halign(Gtk.Align.CENTER)

        # Monitor selector
        self._monitor_combo = Gtk.ComboBoxText()
        self._monitor_combo.append_text("Auto")
        for mon in self.config.monitors:
            self._monitor_combo.append_text(mon.name)
        self._monitor_combo.set_active(0)
        self._monitor_combo.connect("changed", self._on_monitor_changed)
        info_bar.append(self._monitor_combo)

        self._filename_label = Gtk.Label(label="No wallpaper")
        info_bar.append(self._filename_label)

        self._fav_label = Gtk.Label(label="")
        self._fav_label.add_css_class("fav-badge")
        info_bar.append(self._fav_label)

        root.append(info_bar)

        # Button bar
        btn_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=20)
        btn_bar.set_halign(Gtk.Align.CENTER)

        # Navigation group
        nav_group = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self._btn_prev = self._make_btn("Prev [P]", self._do_prev, "nav-btn")
        self._btn_next = self._make_btn("Next [N]", self._do_next, "nav-btn")
        nav_group.append(self._btn_prev)
        nav_group.append(self._btn_next)

        # Rating group
        rate_group = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self._btn_fav = self._make_btn("Fav [F]", self._do_fav, "rate-btn")
        self._btn_unfav = self._make_btn("Unfav [U]", self._do_unfav, "rate-btn")
        self._btn_dislike = self._make_btn("Dislike [X]", self._do_dislike, "rate-btn")
        self._btn_undo = self._make_btn("Undo [Z]", self._do_undislike, "rate-btn")
        rate_group.append(self._btn_fav)
        rate_group.append(self._btn_unfav)
        rate_group.append(self._btn_dislike)
        rate_group.append(self._btn_undo)

        # Utility group
        util_group = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self._btn_open = self._make_btn("Open [O]", self._do_open, "action-btn")
        util_group.append(self._btn_open)

        btn_bar.append(nav_group)
        btn_bar.append(rate_group)
        btn_bar.append(util_group)

        root.append(btn_bar)
        return root

    def _make_btn(self, label: str, handler, css_class: str) -> Gtk.Button:
        btn = Gtk.Button(label=label)
        btn.add_css_class(css_class)
        btn.connect("clicked", lambda _: handler())
        return btn

    # ── Monitor selector ──

    def _on_monitor_changed(self, combo: Gtk.ComboBoxText):
        idx = combo.get_active()
        if idx <= 0:
            self._target_monitor = None
        else:
            self._target_monitor = combo.get_active_text()
        self._current_path = None  # Force refresh
        self._refresh()

    def _get_monitor(self) -> str | None:
        return self._target_monitor or get_focused_monitor()

    # ── Refresh ──

    def refresh(self):
        """Public refresh — force update regardless of change detection."""
        self._current_path = None
        self._refresh()

    def _refresh(self):
        current = query_current()
        monitor = self._get_monitor()
        if not monitor or monitor not in current:
            for name, path in current.items():
                if path:
                    monitor = name
                    break

        img = current.get(monitor) if monitor else None

        if img == self._current_path and monitor == self._current_monitor:
            return

        self._current_monitor = monitor
        self._current_path = img

        if img and img.exists():
            self._preview.set_filename(str(img))
        else:
            self._preview.set_filename(None)

        self._filename_label.set_label(img.name if img else "No wallpaper")

        is_fav = img and "favorites" in str(img)
        self._fav_label.set_label("Favorite" if is_fav else "")
        self._btn_fav.set_visible(not is_fav)
        self._btn_unfav.set_visible(bool(is_fav))

    # ── Polling ──

    def start_polling(self):
        if self._timer_id is not None:
            return
        self._refresh()
        self._timer_id = GLib.timeout_add_seconds(3, self._poll_refresh)

    def stop_polling(self):
        if self._timer_id is not None:
            GLib.source_remove(self._timer_id)
            self._timer_id = None

    def _poll_refresh(self) -> bool:
        self._refresh()
        return True  # continue polling

    # ── Actions ──

    def _do_next(self):
        do_next(self.config, self._target_monitor)
        self._current_path = None
        self._refresh()

    def _do_prev(self):
        do_prev(self.config, self._target_monitor)
        self._current_path = None
        self._refresh()

    def _do_fav(self):
        do_favorite(self.config, self._target_monitor)
        self._current_path = None
        self._refresh()

    def _do_unfav(self):
        do_unfavorite(self.config, self._target_monitor)
        self._current_path = None
        self._refresh()

    def _do_dislike(self):
        do_dislike(self.config, self._target_monitor)
        self._current_path = None
        self._refresh()

    def _do_undislike(self):
        do_undislike(self.config, self._target_monitor)
        self._current_path = None
        self._refresh()

    def _do_open(self):
        do_open_wallhaven(self._current_path)

    # ── Keyboard ──

    def handle_key(self, keyval: int) -> bool:
        actions = {
            Gdk.KEY_n: self._do_next,
            Gdk.KEY_p: self._do_prev,
            Gdk.KEY_f: self._do_fav,
            Gdk.KEY_u: self._do_unfav,
            Gdk.KEY_x: self._do_dislike,
            Gdk.KEY_z: self._do_undislike,
            Gdk.KEY_o: self._do_open,
        }
        if action := actions.get(keyval):
            action()
            return True
        return False
