"""GTK4 main window: HeaderBar + Stack view switching + daemon footer."""

from __future__ import annotations

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gdk, Gtk

from ...config import WayperConfig
from ...state import read_mode, write_mode
from .actions_view import ActionsPanel
from .browse_view import CATEGORIES, BrowsePanel
from .daemon_control import DaemonControlBar
from .settings_window import SettingsWindow

LABELS = {"pool": "Pool [1]", "favorites": "Favorites [2]", "disliked": "Disliked [3]"}


class MainWindow(Gtk.ApplicationWindow):
    """Main GUI window with toolbar, browse/actions views, and daemon footer."""

    def __init__(self, config: WayperConfig, **kwargs):
        super().__init__(**kwargs)
        self.config = config
        self._active_view = 0  # 0=Browse, 1=Quick Actions, 2=Wallhaven
        self._mode = read_mode(config)

        self._browse = BrowsePanel(config, category="pool")
        self._actions = ActionsPanel(config)
        self._daemon = DaemonControlBar(config)
        self._wallhaven = None  # Lazy init

        self.set_title("Wayper")
        self.set_default_size(1200, 750)

        # Keyboard
        key_ctrl = Gtk.EventControllerKey.new()
        key_ctrl.connect("key-pressed", self._on_key)
        self.add_controller(key_ctrl)

        self._build_header()
        self._build_body()
        self._show_view(0)
        self._daemon.start_polling()

    def _build_header(self):
        header = Gtk.HeaderBar()
        header.set_show_title_buttons(True)
        self.set_titlebar(header)

        # Left: category buttons
        self._cat_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=2)
        self._cat_buttons: dict[str, Gtk.ToggleButton] = {}
        group = None
        for cat in CATEGORIES:
            btn = Gtk.ToggleButton(label=LABELS[cat])
            btn.add_css_class("category-btn")
            if group:
                btn.set_group(group)
            else:
                group = btn
            if cat == "pool":
                btn.set_active(True)
            btn.connect("toggled", self._on_category_toggled, cat)
            self._cat_box.append(btn)
            self._cat_buttons[cat] = btn
        header.pack_start(self._cat_box)

        # Center: view selector
        view_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=2)
        self._view_browse_btn = Gtk.ToggleButton(label="Browse [B]")
        self._view_browse_btn.add_css_class("view-btn")
        self._view_browse_btn.set_active(True)
        self._view_actions_btn = Gtk.ToggleButton(label="Quick Actions [A]")
        self._view_actions_btn.add_css_class("view-btn")
        self._view_actions_btn.set_group(self._view_browse_btn)
        self._view_wallhaven_btn = Gtk.ToggleButton(label="Wallhaven [W]")
        self._view_wallhaven_btn.add_css_class("view-btn")
        self._view_wallhaven_btn.set_group(self._view_browse_btn)
        self._view_browse_btn.connect("toggled", self._on_view_toggled, 0)
        self._view_actions_btn.connect("toggled", self._on_view_toggled, 1)
        self._view_wallhaven_btn.connect("toggled", self._on_view_toggled, 2)
        view_box.append(self._view_browse_btn)
        view_box.append(self._view_actions_btn)
        view_box.append(self._view_wallhaven_btn)
        header.set_title_widget(view_box)

        # Right: settings gear + mode toggle
        settings_btn = Gtk.Button.new_from_icon_name("emblem-system-symbolic")
        settings_btn.connect("clicked", lambda _: self._open_settings())
        header.pack_end(settings_btn)

        self._mode_btn = Gtk.ToggleButton(label=f"{self._mode.upper()} [M]")
        self._mode_btn.add_css_class("mode-btn")
        self._mode_btn.set_active(self._mode == "nsfw")
        self._mode_btn.connect("toggled", self._on_mode_toggled)
        header.pack_end(self._mode_btn)

    def _build_body(self):
        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.set_child(vbox)

        # Stack for browse / actions / wallhaven
        self._stack = Gtk.Stack()
        self._stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
        self._stack.set_vexpand(True)
        self._stack.add_named(self._browse.widget, "browse")
        self._stack.add_named(self._actions.widget, "actions")
        vbox.append(self._stack)

        # Separator
        sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        vbox.append(sep)

        # Daemon footer
        self._daemon.widget.set_margin_start(12)
        self._daemon.widget.set_margin_end(12)
        self._daemon.widget.set_margin_top(4)
        self._daemon.widget.set_margin_bottom(6)
        vbox.append(self._daemon.widget)

    def _ensure_wallhaven_view(self):
        """Lazy-init the Wallhaven panel."""
        if self._wallhaven is not None:
            return
        from .wallhaven_view import WallhavenPanel

        self._wallhaven = WallhavenPanel(self.config)
        self._stack.add_named(self._wallhaven.widget, "wallhaven")

    # ── View switching ──

    def _show_view(self, idx: int):
        self._active_view = idx
        if idx == 0:
            self._stack.set_visible_child_name("browse")
            self._actions.stop_polling()
        elif idx == 1:
            self._stack.set_visible_child_name("actions")
            self._actions.start_polling()
        elif idx == 2:
            self._ensure_wallhaven_view()
            self._stack.set_visible_child_name("wallhaven")
            self._actions.stop_polling()
        self._cat_box.set_visible(idx == 0)

    # ── Callbacks ──

    def _on_category_toggled(self, btn: Gtk.ToggleButton, cat: str):
        if btn.get_active():
            self._browse.set_category(cat)

    def _on_view_toggled(self, btn: Gtk.ToggleButton, idx: int):
        if btn.get_active():
            self._show_view(idx)

    def _on_mode_toggled(self, btn: Gtk.ToggleButton):
        self._mode = "nsfw" if btn.get_active() else "sfw"
        btn.set_label(f"{self._mode.upper()} [M]")
        write_mode(self.config, self._mode)
        self._browse.set_mode(self._mode)
        self._daemon.force_refresh()

    _VIEW_KEYS = {
        Gdk.KEY_b: 0,
        Gdk.KEY_a: 1,
        Gdk.KEY_w: 2,
    }
    _VIEW_BUTTONS = ("_view_browse_btn", "_view_actions_btn", "_view_wallhaven_btn")

    def _on_key(self, ctrl, keyval, keycode, state):
        # Global keys
        if keyval == Gdk.KEY_m:
            self._mode_btn.set_active(not self._mode_btn.get_active())
            return True

        # View switching keys
        if (view_idx := self._VIEW_KEYS.get(keyval)) is not None:
            getattr(self, self._VIEW_BUTTONS[view_idx]).set_active(True)
            return True

        # Category keys (browse view only)
        if self._active_view == 0 and keyval in (Gdk.KEY_1, Gdk.KEY_2, Gdk.KEY_3):
            idx = keyval - Gdk.KEY_1
            cat = CATEGORIES[idx]
            self._cat_buttons[cat].set_active(True)
            return True

        # Delegate to active panel
        if self._active_view == 0:
            return self._browse.handle_key(keyval, state)
        if self._active_view == 1:
            return self._actions.handle_key(keyval)
        return False

    def _open_settings(self):
        SettingsWindow.show_for(self.config, parent=self, on_save=self._on_settings_saved)

    def _on_settings_saved(self):
        """Reload views after settings change."""
        self._mode = read_mode(self.config)
        self._mode_btn.set_active(self._mode == "nsfw")
        self._mode_btn.set_label(f"{self._mode.upper()} [M]")
        self._browse.set_mode(self._mode)
        self._browse.set_category(self._browse.category)
        self._actions.refresh()
        self._daemon.force_refresh()

    # ── Cleanup ──

    def do_close_request(self):
        self._actions.stop_polling()
        self._daemon.stop_polling()
        self._browse.shutdown()
        if self._wallhaven:
            self._wallhaven.shutdown()
        return False
