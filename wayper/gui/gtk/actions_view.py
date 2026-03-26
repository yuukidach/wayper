"""GTK4 quick actions panel: current wallpaper preview + navigation + rating."""

from __future__ import annotations

import webbrowser
from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gdk, GLib, Gtk

from ...backend import get_context, get_focused_monitor, query_current, set_wallpaper
from ...browse._common import wallhaven_url
from ...config import NO_TRANSITION, WayperConfig
from ...history import go_prev, pick_next
from ...history import push as push_history
from ...pool import add_to_blacklist, favorites_dir, pick_random, pool_dir, remove_from_blacklist
from ...state import pop_undo, push_undo, read_mode, restore_from_trash


class ActionsPanel:
    """Quick actions: preview current wallpaper + action buttons."""

    def __init__(self, config: WayperConfig):
        self.config = config
        self._current_path: Path | None = None
        self._current_monitor: str | None = None
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

        self._monitor_label = Gtk.Label(label="\u2014")
        self._monitor_label.add_css_class("info-label")
        info_bar.append(self._monitor_label)

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

    # ── Refresh ──

    def refresh(self):
        """Public refresh — force update regardless of change detection."""
        self._last_state = None
        self._refresh()

    def _refresh(self):
        current = query_current()
        monitor = get_focused_monitor()
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

        self._monitor_label.set_label(monitor or "\u2014")
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
        monitor, mon_cfg, _ = get_context(self.config)
        if not mon_cfg:
            return
        img = pick_next(self.config, monitor, mon_cfg.orientation)
        if img:
            set_wallpaper(monitor, img, self.config.transition)
        self._current_path = None
        self._refresh()

    def _do_prev(self):
        monitor, mon_cfg, _ = get_context(self.config)
        if not mon_cfg:
            return
        img = go_prev(self.config, monitor)
        if img:
            set_wallpaper(monitor, img, self.config.transition)
        self._current_path = None
        self._refresh()

    def _do_fav(self):
        monitor, mon_cfg, img = get_context(self.config)
        if not img or not mon_cfg:
            return
        if "favorites" in str(img):
            return
        mode = read_mode(self.config)
        dest_dir = favorites_dir(self.config, mode, mon_cfg.orientation)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / img.name
        img.rename(dest)
        set_wallpaper(monitor, dest, NO_TRANSITION)
        self._current_path = None
        self._refresh()

    def _do_unfav(self):
        monitor, mon_cfg, img = get_context(self.config)
        if not img or not mon_cfg:
            return
        if "favorites" not in str(img):
            return
        mode = read_mode(self.config)
        dest_dir = pool_dir(self.config, mode, mon_cfg.orientation)
        dest = dest_dir / img.name
        img.rename(dest)
        set_wallpaper(monitor, dest, NO_TRANSITION)
        self._current_path = None
        self._refresh()

    def _do_dislike(self):
        monitor, mon_cfg, img = get_context(self.config)
        if not img or not mon_cfg:
            return
        if "favorites" in str(img):
            return
        mode = read_mode(self.config)
        next_img = pick_random(self.config, mode, mon_cfg.orientation)
        if next_img:
            set_wallpaper(monitor, next_img, self.config.transition)
            push_history(self.config, monitor, next_img)
        add_to_blacklist(self.config, img.name)
        push_undo(self.config, img.name, img.parent)
        self._current_path = None
        self._refresh()

    def _do_undislike(self):
        entry = pop_undo(self.config)
        if not entry:
            return
        filename, orig_dir = entry
        restored = restore_from_trash(self.config, filename, orig_dir)
        remove_from_blacklist(self.config, filename)
        if restored:
            monitor = get_focused_monitor()
            if monitor:
                set_wallpaper(monitor, restored, self.config.transition)
        self._current_path = None
        self._refresh()

    def _do_open(self):
        if self._current_path:
            webbrowser.open(wallhaven_url(self._current_path))

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
