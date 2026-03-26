"""GTK4 browse panel: thumbnail grid + preview + action buttons."""

from __future__ import annotations

import shutil
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("GdkPixbuf", "2.0")
gi.require_version("Pango", "1.0")
from gi.repository import Gdk, GdkPixbuf, Gio, GLib, Gtk, Pango

from ...backend import find_monitor, get_focused_monitor, set_wallpaper
from ...browse._common import (
    format_size,
    get_blocklist_only,
    get_images,
    get_orient,
    perform_context_action,
    perform_delete,
    perform_favorite,
    sort_images,
    wallhaven_url,
)
from ...config import WayperConfig
from ...history import push as push_history
from ...image import validate_image
from ...pool import IMAGE_EXTENSIONS, list_blacklist, pool_dir
from ...state import read_mode, write_mode
from .daemon_control import _find_wayper_cli

THUMB_SIZE = 200
CATEGORIES = ("pool", "favorites", "disliked")
ACTION_CONFIG = {
    "favorites": "Remove",
    "pool": "Reject",
    "disliked": "Restore",
}


class BrowsePanel:
    """Embeddable browse panel with thumbnail grid, preview, and action buttons."""

    def __init__(self, config: WayperConfig, category: str = "pool"):
        self.config = config
        self.category = category
        self.mode = read_mode(config)
        self.selected_path: Path | None = None
        self._selected_name: str | None = None
        self.images: list[Path] = []
        self._blocklist_only: list[str] = []
        self._thumb_pool = ThreadPoolExecutor(max_workers=4)
        self._zoom_level: float = 1.0
        self._preview_orig_w: int = 0
        self._preview_orig_h: int = 0
        # Filter state
        self._filter_text: str = ""
        self._filter_orientation: str | None = None
        self._sort_key: str = "newest"
        # Multi-select state
        self._selected_paths: list[Path] = []
        self._last_clicked_index: int | None = None
        self._filter_debounce_id: int | None = None
        self.widget = self._build()
        self._reload_images()

    def _build(self) -> Gtk.Box:
        hbox = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=16)
        hbox.set_margin_start(16)
        hbox.set_margin_end(16)
        hbox.set_margin_bottom(16)
        hbox.set_margin_top(8)
        hbox.set_vexpand(True)
        hbox.set_hexpand(True)

        self._build_grid(hbox)
        self._build_preview(hbox)
        return hbox

    def _build_grid(self, parent: Gtk.Box):
        grid_col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        grid_col.set_size_request(460, -1)
        grid_col.set_vexpand(True)

        # Search/filter bar
        filter_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        filter_bar.add_css_class("search-bar")

        self._search_entry = Gtk.SearchEntry()
        self._search_entry.set_placeholder_text("Filter... [/]")
        self._search_entry.set_hexpand(True)
        self._search_entry.set_can_focus(False)
        self._search_entry.connect("search-changed", self._on_search_changed)
        filter_bar.append(self._search_entry)

        self._land_btn = Gtk.ToggleButton(label="Landscape")
        self._land_btn.add_css_class("filter-btn")
        self._land_btn.connect("toggled", self._on_orient_toggled, "landscape")
        filter_bar.append(self._land_btn)

        self._port_btn = Gtk.ToggleButton(label="Portrait")
        self._port_btn.add_css_class("filter-btn")
        self._port_btn.connect("toggled", self._on_orient_toggled, "portrait")
        filter_bar.append(self._port_btn)

        self._sort_combo = Gtk.ComboBoxText()
        for label in ("Newest", "Oldest", "Largest", "Smallest", "Name"):
            self._sort_combo.append_text(label)
        self._sort_combo.set_active(0)
        self._sort_combo.connect("changed", self._on_sort_changed)
        filter_bar.append(self._sort_combo)

        self._list_btn = Gtk.ToggleButton(label="\u2630")
        self._list_btn.add_css_class("filter-btn")
        self._list_btn.set_tooltip_text("List view")
        self._list_btn.connect("toggled", self._on_view_toggle)
        filter_bar.append(self._list_btn)

        grid_col.append(filter_bar)

        # Wrap scroll in revealer for category crossfade
        self._grid_revealer = Gtk.Revealer()
        self._grid_revealer.set_transition_type(Gtk.RevealerTransitionType.CROSSFADE)
        self._grid_revealer.set_transition_duration(200)
        self._grid_revealer.set_reveal_child(True)
        self._grid_revealer.set_vexpand(True)

        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_vexpand(True)

        self.flowbox = Gtk.FlowBox()
        self.flowbox.set_valign(Gtk.Align.START)
        self.flowbox.set_max_children_per_line(4)
        self.flowbox.set_min_children_per_line(2)
        self.flowbox.set_selection_mode(Gtk.SelectionMode.MULTIPLE)
        self.flowbox.set_homogeneous(True)
        self.flowbox.set_row_spacing(8)
        self.flowbox.set_column_spacing(8)
        self.flowbox.connect("selected-children-changed", self._on_selected)

        # Drop target for importing images
        drop = Gtk.DropTarget.new(Gdk.FileList, Gdk.DragAction.COPY)
        drop.connect("drop", self._on_drop)
        self.flowbox.add_controller(drop)

        scroll.set_child(self.flowbox)

        # Empty state
        self._empty_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self._empty_box.set_valign(Gtk.Align.CENTER)
        self._empty_box.set_halign(Gtk.Align.CENTER)
        self._empty_box.add_css_class("empty-state")
        self._empty_icon = Gtk.Label()
        self._empty_icon.add_css_class("empty-icon")
        self._empty_box.append(self._empty_icon)
        self._empty_title = Gtk.Label()
        self._empty_title.add_css_class("empty-title")
        self._empty_box.append(self._empty_title)
        self._empty_desc = Gtk.Label()
        self._empty_desc.add_css_class("empty-desc")
        self._empty_desc.set_wrap(True)
        self._empty_desc.set_max_width_chars(40)
        self._empty_desc.set_justify(Gtk.Justification.CENTER)
        self._empty_box.append(self._empty_desc)

        self._empty_cta = Gtk.Button(label="Start Daemon")
        self._empty_cta.add_css_class("action-btn")
        self._empty_cta.set_halign(Gtk.Align.CENTER)
        self._empty_cta.set_margin_top(12)
        self._empty_cta.connect("clicked", self._on_empty_cta)
        self._empty_cta.set_visible(False)
        self._empty_box.append(self._empty_cta)

        # List view
        list_scroll = Gtk.ScrolledWindow()
        list_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        list_scroll.set_vexpand(True)
        self._list_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self._list_box.set_valign(Gtk.Align.START)
        list_scroll.set_child(self._list_box)

        # Stack to switch between grid, list, and empty state
        self._grid_stack = Gtk.Stack()
        self._grid_stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
        self._grid_stack.set_vexpand(True)
        self._grid_stack.add_named(scroll, "grid")
        self._grid_stack.add_named(list_scroll, "list")
        self._grid_stack.add_named(self._empty_box, "empty")

        self._grid_revealer.set_child(self._grid_stack)
        grid_col.append(self._grid_revealer)

        parent.append(grid_col)

    def _build_preview(self, parent: Gtk.Box):
        right = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        right.set_hexpand(True)

        # Preview with info overlay and zoom/pan
        preview_overlay = Gtk.Overlay()
        preview_overlay.set_vexpand(True)

        # Scrolled window for zoom/pan
        self._preview_scroll = Gtk.ScrolledWindow()
        self._preview_scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        self._preview_scroll.set_vexpand(True)
        self._preview_scroll.add_css_class("preview-area")

        self.preview = Gtk.Picture()
        self.preview.set_content_fit(Gtk.ContentFit.CONTAIN)
        self.preview.set_can_shrink(True)
        self.preview.set_vexpand(True)
        self._preview_scroll.set_child(self.preview)
        preview_overlay.set_child(self._preview_scroll)

        # Ctrl+scroll zoom
        scroll_ctrl = Gtk.EventControllerScroll.new(Gtk.EventControllerScrollFlags.VERTICAL)
        scroll_ctrl.connect("scroll", self._on_preview_scroll)
        self._preview_scroll.add_controller(scroll_ctrl)

        # Double-click to toggle zoom
        dbl_click = Gtk.GestureClick.new()
        dbl_click.set_button(1)
        dbl_click.connect("released", self._on_preview_double_click)
        self._preview_scroll.add_controller(dbl_click)

        # Info overlay at bottom
        self._preview_info_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        self._preview_info_box.set_valign(Gtk.Align.END)
        self._preview_info_box.set_halign(Gtk.Align.FILL)
        self._preview_info_box.set_hexpand(True)
        self._preview_info_box.add_css_class("preview-overlay")

        self._preview_res_label = Gtk.Label(label="")
        self._preview_size_label = Gtk.Label(label="")
        self._preview_id_label = Gtk.Label(label="")
        self._preview_info_box.append(self._preview_res_label)
        self._preview_info_box.append(self._preview_size_label)
        self._preview_info_box.append(self._preview_id_label)
        self._preview_info_box.set_visible(False)

        preview_overlay.add_overlay(self._preview_info_box)
        right.append(preview_overlay)

        # Monitor selector (only if multiple monitors)
        if len(self.config.monitors) > 1:
            mon_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            mon_box.set_halign(Gtk.Align.CENTER)
            mon_label = Gtk.Label(label="Monitor:")
            mon_label.add_css_class("status-label")
            mon_box.append(mon_label)
            self._monitor_combo = Gtk.ComboBoxText()
            self._monitor_combo.append_text("Focused")
            for mon in self.config.monitors:
                self._monitor_combo.append_text(mon.name)
            self._monitor_combo.set_active(0)
            mon_box.append(self._monitor_combo)
            right.append(mon_box)
        else:
            self._monitor_combo = None

        # Action buttons
        btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        btn_box.set_halign(Gtk.Align.CENTER)

        def _btn(label, handler, *css_classes):
            b = Gtk.Button(label=label)
            for c in ("action-btn", *css_classes):
                b.add_css_class(c)
            b.connect("clicked", lambda _: handler())
            btn_box.append(b)
            return b

        self.btn_set = _btn("Set wallpaper [Enter]", self._set_wallpaper)
        self.btn_open = _btn("Open URL [O]", self._open_url)
        self.btn_fav = _btn("Favorite [F]", self._favorite)
        self.btn_action = _btn("Remove [X]", self._context_action)
        self.btn_delete = _btn("Delete [D]", self._delete, "destructive")

        right.append(btn_box)

        self.status_label = Gtk.Label()
        self.status_label.add_css_class("status-label")
        right.append(self.status_label)

        parent.append(right)
        self._update_buttons()

    # ── Filter callbacks ──

    def _on_search_changed(self, entry: Gtk.SearchEntry):
        self._filter_text = entry.get_text().strip().lower()
        if self._filter_debounce_id is not None:
            GLib.source_remove(self._filter_debounce_id)
        self._filter_debounce_id = GLib.timeout_add(150, self._debounced_filter)

    def _debounced_filter(self) -> bool:
        self._filter_debounce_id = None
        self._apply_filters()
        return False

    def _on_orient_toggled(self, btn: Gtk.ToggleButton, orient: str):
        if btn.get_active():
            # Deactivate the other orientation button
            other = self._port_btn if orient == "landscape" else self._land_btn
            if other.get_active():
                other.set_active(False)
            self._filter_orientation = orient
        else:
            self._filter_orientation = None
        self._apply_filters()

    def _on_sort_changed(self, combo: Gtk.ComboBoxText):
        keys = ["newest", "oldest", "largest", "smallest", "name"]
        idx = combo.get_active()
        self._sort_key = keys[idx] if 0 <= idx < len(keys) else "newest"
        self._apply_filters()

    def _apply_filters(self):
        """Filter and sort images, then repopulate grid."""
        filtered = self.images

        if self._filter_text:
            filtered = [p for p in filtered if self._filter_text in p.name.lower()]

        if self._filter_orientation:
            filtered = [p for p in filtered if self._filter_orientation in str(p.parent).lower()]

        filtered = sort_images(filtered, self._sort_key)
        if self._list_btn.get_active():
            self._populate_list(filtered)
        else:
            self._populate_grid(filtered)
        n = len(filtered)
        self.status_label.set_text(f"{n} image{'s' if n != 1 else ''} \u00b7 {self.mode.upper()}")

    # ── Data loading ──

    def _reload_images(self):
        self.images = get_images(self.category, self.mode, self.config)
        self._blocklist_only = (
            get_blocklist_only(self.images, self.config) if self.category == "disliked" else []
        )
        # Animate category switch via revealer crossfade
        self._grid_revealer.set_reveal_child(False)
        if self._list_btn.get_active():
            self._populate_list()
        else:
            self._populate_grid()
        self._update_status()
        self._update_buttons()
        self.selected_path = None
        self._selected_name = None
        self._set_preview(None)
        GLib.timeout_add(50, self._reveal_grid)

    def _reveal_grid(self) -> bool:
        self._grid_revealer.set_reveal_child(True)
        return False

    def _populate_grid(self, images: list[Path] | None = None):
        while child := self.flowbox.get_first_child():
            self.flowbox.remove(child)

        display_images = images if images is not None else self.images

        # Show empty state or grid
        bl_count = len(self._blocklist_only)
        if len(display_images) == 0 and bl_count == 0:
            self._show_empty_state()
        else:
            self._grid_stack.set_visible_child_name("grid")

        for img_path in display_images:
            box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
            box._image_path = img_path
            box._blocklist_name = None

            # Overlay for thumbnail info on hover
            overlay = Gtk.Overlay()
            picture = Gtk.Picture()
            picture.set_size_request(THUMB_SIZE, THUMB_SIZE)
            picture.set_content_fit(Gtk.ContentFit.COVER)
            picture.set_can_shrink(True)
            picture.add_css_class("thumb-skeleton")
            overlay.set_child(picture)

            # Info label (shown on hover)
            info_label = Gtk.Label(label="")
            info_label.add_css_class("thumb-overlay")
            info_label.set_valign(Gtk.Align.END)
            info_label.set_halign(Gtk.Align.FILL)
            info_label.set_visible(False)
            overlay.add_overlay(info_label)
            box.append(overlay)

            label = Gtk.Label(label=img_path.stem[-8:])
            label.set_ellipsize(Pango.EllipsizeMode.END)
            label.set_max_width_chars(12)
            box.append(label)

            # Hover controller on the box itself
            motion = Gtk.EventControllerMotion.new()
            motion.connect("enter", self._on_thumb_hover_enter, info_label)
            motion.connect("leave", self._on_thumb_hover_leave, info_label)
            box.add_controller(motion)

            # Right-click context menu
            right_click = Gtk.GestureClick.new()
            right_click.set_button(3)
            right_click.connect("released", self._on_right_click, box)
            box.add_controller(right_click)

            # Left-click: plain click = single select, Ctrl+click = toggle
            left_click = Gtk.GestureClick.new()
            left_click.set_button(1)
            left_click.connect("pressed", self._on_thumb_click)
            box.add_controller(left_click)

            # Drag source for export
            drag = Gtk.DragSource.new()
            drag.set_actions(Gdk.DragAction.COPY)
            drag.connect("prepare", self._on_drag_prepare, img_path)
            box.add_controller(drag)

            self._load_thumb_async(str(img_path), picture, info_label)
            self.flowbox.append(box)

    def _on_view_toggle(self, btn: Gtk.ToggleButton):
        if btn.get_active():
            self._populate_list()
            self._grid_stack.set_visible_child_name("list")
        else:
            self._populate_grid()
            self._grid_stack.set_visible_child_name("grid")

    def _populate_list(self, images: list[Path] | None = None):
        import time as _time

        while child := self._list_box.get_first_child():
            self._list_box.remove(child)

        display_images = images if images is not None else self.images

        # Build timestamp lookup for blocklist entries
        bl_timestamps: dict[str, int] = {}
        if self.category == "disliked":
            for ts, name in list_blacklist(self.config):
                bl_timestamps[name] = ts

        # Images with files
        for img_path in display_images:
            wall_id = img_path.stem.split("-", 1)[-1] if "-" in img_path.stem else img_path.stem
            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            row.add_css_class("list-row")
            row._image_path = img_path
            row._blocklist_name = None

            id_btn = Gtk.Button(label=f"#{wall_id}")
            id_btn.add_css_class("list-id")
            id_btn.connect("clicked", lambda _, p=img_path: webbrowser.open(wallhaven_url(p)))
            row.append(id_btn)

            badge = Gtk.Label(label="file")
            badge.add_css_class("list-badge")
            badge.add_css_class("list-badge-file")
            row.append(badge)

            try:
                size = format_size(img_path.stat().st_size)
            except OSError:
                size = "—"
            size_label = Gtk.Label(label=size)
            size_label.add_css_class("status-label")
            row.append(size_label)

            ts = bl_timestamps.get(img_path.name, 0)
            if ts:
                date_str = _time.strftime("%Y-%m-%d", _time.localtime(ts))
            else:
                date_str = ""
            date_label = Gtk.Label(label=date_str)
            date_label.add_css_class("status-label")
            row.append(date_label)

            spacer = Gtk.Box()
            spacer.set_hexpand(True)
            row.append(spacer)

            action_label = ACTION_CONFIG.get(self.category)
            if action_label:
                act_btn = Gtk.Button(label=action_label)
                act_btn.add_css_class("filter-btn")
                act_btn.connect(
                    "clicked",
                    lambda _, p=img_path: (
                        perform_context_action(self.config, p, self.category, self.mode),
                        self._reload_images(),
                    ),
                )
                row.append(act_btn)

            del_btn = Gtk.Button(label="Delete")
            del_btn.add_css_class("filter-btn")
            del_btn.add_css_class("destructive")
            del_btn.connect(
                "clicked",
                lambda _, p=img_path: (
                    perform_delete(self.config, p),
                    self._reload_images(),
                ),
            )
            row.append(del_btn)

            self._list_box.append(row)

        # Blocklist-only entries
        for name in self._blocklist_only:
            wall_id = Path(name).stem
            wall_id = wall_id.split("-", 1)[-1] if "-" in wall_id else wall_id
            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            row.add_css_class("list-row")
            row._image_path = None
            row._blocklist_name = name

            id_btn = Gtk.Button(label=f"#{wall_id}")
            id_btn.add_css_class("list-id")
            id_btn.connect(
                "clicked",
                lambda _, n=name: webbrowser.open(wallhaven_url(Path(n))),
            )
            row.append(id_btn)

            badge = Gtk.Label(label="blocked")
            badge.add_css_class("list-badge")
            badge.add_css_class("list-badge-blocked")
            row.append(badge)

            # No file size for blocklist-only
            spacer_size = Gtk.Label(label="—")
            spacer_size.add_css_class("status-label")
            row.append(spacer_size)

            ts = bl_timestamps.get(name, 0)
            if ts:
                date_str = _time.strftime("%Y-%m-%d", _time.localtime(ts))
            else:
                date_str = ""
            date_label = Gtk.Label(label=date_str)
            date_label.add_css_class("status-label")
            row.append(date_label)

            spacer = Gtk.Box()
            spacer.set_hexpand(True)
            row.append(spacer)

            unblock_btn = Gtk.Button(label="Unblock")
            unblock_btn.add_css_class("filter-btn")
            unblock_btn.connect(
                "clicked",
                lambda _, n=name: (
                    perform_context_action(self.config, None, self.category, self.mode, n),
                    self._reload_images(),
                ),
            )
            row.append(unblock_btn)

            del_btn = Gtk.Button(label="Delete")
            del_btn.add_css_class("filter-btn")
            del_btn.add_css_class("destructive")
            del_btn.connect(
                "clicked",
                lambda _, n=name: (
                    perform_delete(self.config, None, n),
                    self._reload_images(),
                ),
            )
            row.append(del_btn)

            self._list_box.append(row)

        # Show empty state if nothing to display
        total = len(display_images) + len(self._blocklist_only)
        if total == 0:
            self._show_empty_state()
        else:
            self._grid_stack.set_visible_child_name("list")

    _EMPTY_STATE = {
        "pool": (
            "",
            "Pool is empty",
            "The daemon will download wallpapers\nautomatically, or drag images here",
        ),
        "favorites": (
            "\u2606",
            "No favorites yet",
            "Press F to favorite a wallpaper\nfrom the pool",
        ),
        "disliked": (
            "\u2205",
            "Nothing disliked",
            "Press X to reject wallpapers\nyou don\u2019t want to see again",
        ),
    }

    def _show_empty_state(self):
        icon, title, desc = self._EMPTY_STATE.get(self.category, ("", "No images", ""))
        self._empty_icon.set_label(icon)
        self._empty_title.set_label(title)
        self._empty_desc.set_label(desc)
        # Apply category color
        for c in ("cat-pool", "cat-favorites", "cat-disliked"):
            self._empty_icon.remove_css_class(c)
        self._empty_icon.add_css_class(f"cat-{self.category}")
        # CTA button only for pool
        self._empty_cta.set_visible(self.category == "pool")
        self._grid_stack.set_visible_child_name("empty")

    def _on_empty_cta(self, _btn):
        import subprocess

        subprocess.Popen(
            [_find_wayper_cli(), "daemon"],
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def _on_right_click(self, gesture, n_press, x, y, box: Gtk.Box):
        """Show context menu on right-click."""
        img_path = getattr(box, "_image_path", None)
        bl_name = getattr(box, "_blocklist_name", None)
        if not img_path and not bl_name:
            return

        menu = Gio.Menu()

        # Set wallpaper submenu (per-monitor)
        if img_path:
            if len(self.config.monitors) > 1:
                sub = Gio.Menu()
                for mon in self.config.monitors:
                    sub.append(mon.name, f"ctx.set-{mon.name}")
                menu.append_submenu("Set wallpaper", sub)
            else:
                menu.append("Set wallpaper", "ctx.set-focused")

        # Favorite
        if img_path and self.category in ("pool", "disliked"):
            menu.append("Favorite", "ctx.favorite")

        # Open URL
        menu.append("Open Wallhaven URL", "ctx.open-url")

        # Context action
        action_label = ACTION_CONFIG.get(self.category)
        if self.category == "disliked" and bl_name and not img_path:
            action_label = "Unblock"
        if action_label:
            menu.append(action_label, "ctx.context-action")

        # Separator + destructive
        section = Gio.Menu()
        section.append("Delete", "ctx.delete")
        menu.append_section(None, section)

        # Copy path
        if img_path:
            copy_section = Gio.Menu()
            copy_section.append("Copy path", "ctx.copy-path")
            menu.append_section(None, copy_section)

        # Create action group
        group = Gio.SimpleActionGroup()

        def _add(name, callback):
            action = Gio.SimpleAction.new(name, None)
            action.connect("activate", lambda *_: callback())
            group.add_action(action)

        # Set wallpaper actions
        if img_path:
            if len(self.config.monitors) > 1:
                for mon in self.config.monitors:
                    _name = f"set-{mon.name}"
                    _mon = mon.name

                    def _make_setter(m):
                        return lambda: self._set_wallpaper(img_path, m)

                    _add(_name, _make_setter(_mon))
            else:
                _add("set-focused", lambda: self._set_wallpaper(img_path))

        if img_path:
            _add(
                "favorite",
                lambda: (
                    perform_favorite(self.config, img_path, self.mode),
                    self._remove_item(box),
                ),
            )

        _add(
            "open-url",
            lambda: webbrowser.open(wallhaven_url(img_path or Path(bl_name))),
        )

        _add(
            "context-action",
            lambda: (
                perform_context_action(self.config, img_path, self.category, self.mode, bl_name),
                self._remove_item(box),
            ),
        )

        _add(
            "delete",
            lambda: (
                perform_delete(self.config, img_path, bl_name),
                self._remove_item(box),
            ),
        )

        if img_path:
            _add("copy-path", lambda: self._copy_to_clipboard(str(img_path)))

        box.insert_action_group("ctx", group)

        popover = Gtk.PopoverMenu.new_from_model(menu)
        popover.set_parent(box)
        popover.set_has_arrow(False)
        popover.set_pointing_to(Gdk.Rectangle())
        popover.popup()

    def _copy_to_clipboard(self, text: str):
        display = Gdk.Display.get_default()
        if display:
            clipboard = display.get_clipboard()
            clipboard.set(text)

    # ── Drag-and-drop ──

    def _on_drag_prepare(self, drag_source, x, y, img_path: Path):
        """Prepare drag data as file URI list."""
        uri = f"file://{img_path}\r\n"
        return Gdk.ContentProvider.new_for_bytes("text/uri-list", GLib.Bytes.new(uri.encode()))

    def _on_drop(self, drop_target, value, x, y) -> bool:
        """Handle dropped files: validate and import into pool."""
        files = value.get_files()
        imported = 0
        for gfile in files:
            path = Path(gfile.get_path())
            if path.suffix.lower() not in IMAGE_EXTENSIONS:
                continue
            if not validate_image(path):
                continue
            orient = get_orient(path)
            dest_dir = pool_dir(self.config, self.mode, orient)
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / path.name
            if not dest.exists():
                shutil.copy2(str(path), str(dest))
                imported += 1

        if imported > 0:
            self._reload_images()
        return True

    def _on_thumb_hover_enter(self, ctrl, x, y, info_label: Gtk.Label):
        if info_label.get_label():
            info_label.set_visible(True)

    def _on_thumb_hover_leave(self, ctrl, info_label: Gtk.Label):
        info_label.set_visible(False)

    def _load_thumb_async(self, path: str, picture: Gtk.Picture, info_label: Gtk.Label):
        def worker():
            try:
                # Read original dimensions (header-only, fast)
                _fmt, orig_w, orig_h = GdkPixbuf.Pixbuf.get_file_info(path)
                file_size = Path(path).stat().st_size

                pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                    path,
                    THUMB_SIZE * 2,
                    THUMB_SIZE * 2,
                    True,
                )
                w, h = pixbuf.get_width(), pixbuf.get_height()
                side = min(w, h)
                cropped = pixbuf.new_subpixbuf((w - side) // 2, (h - side) // 2, side, side)
                scaled = cropped.scale_simple(
                    THUMB_SIZE,
                    THUMB_SIZE,
                    GdkPixbuf.InterpType.BILINEAR,
                )
                GLib.idle_add(_set, scaled, orig_w, orig_h, file_size)
            except Exception:
                pass

        def _set(pixbuf, orig_w, orig_h, file_size):
            texture = Gdk.Texture.new_for_pixbuf(pixbuf)
            picture.set_paintable(texture)
            picture.remove_css_class("thumb-skeleton")
            picture.add_css_class("thumb-loaded")
            info_label.set_label(f"{orig_w}x{orig_h} | {format_size(file_size)}")
            return False

        self._thumb_pool.submit(worker)

    # ── Preview helpers ──

    def _set_preview(self, path: Path | None):
        """Set preview image and update info overlay."""
        self._zoom_level = 1.0
        self.preview.set_content_fit(Gtk.ContentFit.CONTAIN)
        self.preview.set_can_shrink(True)
        self.preview.set_size_request(-1, -1)

        if path and path.exists():
            self.preview.set_filename(str(path))
            # Read image info for overlay
            try:
                _fmt, w, h = GdkPixbuf.Pixbuf.get_file_info(str(path))
                self._preview_orig_w = w
                self._preview_orig_h = h
                file_size = path.stat().st_size
                wall_id = path.stem.split("-", 1)[-1] if "-" in path.stem else path.stem
                self._preview_res_label.set_label(f"{w}x{h}")
                self._preview_size_label.set_label(format_size(file_size))
                self._preview_id_label.set_label(f"#{wall_id}")
                self._preview_info_box.set_visible(True)
            except Exception:
                self._preview_info_box.set_visible(False)
        else:
            self.preview.set_filename(None)
            self._preview_info_box.set_visible(False)
            self._preview_orig_w = 0
            self._preview_orig_h = 0

    def _on_preview_scroll(self, ctrl, dx, dy):
        """Ctrl+scroll to zoom preview."""
        state = ctrl.get_current_event_state()
        if not (state & Gdk.ModifierType.CONTROL_MASK):
            return False
        if not self.selected_path:
            return False

        # Zoom in/out
        if dy < 0:
            self._zoom_level = min(5.0, self._zoom_level * 1.15)
        else:
            self._zoom_level = max(1.0, self._zoom_level / 1.15)

        self._apply_zoom()
        return True

    def _on_preview_double_click(self, gesture, n_press, x, y):
        """Double-click to toggle between fit and 1:1 zoom."""
        if n_press != 2 or not self.selected_path:
            return
        if self._zoom_level > 1.01:
            self._zoom_level = 1.0
        else:
            self._zoom_level = 3.0
        self._apply_zoom()

    def _apply_zoom(self):
        if self._zoom_level <= 1.01:
            self.preview.set_content_fit(Gtk.ContentFit.CONTAIN)
            self.preview.set_can_shrink(True)
            self.preview.set_size_request(-1, -1)
        else:
            self.preview.set_content_fit(Gtk.ContentFit.FILL)
            self.preview.set_can_shrink(False)
            w = int(self._preview_orig_w * self._zoom_level)
            h = int(self._preview_orig_h * self._zoom_level)
            self.preview.set_size_request(w, h)

    # ── Multi-select ──

    def _on_thumb_click(self, gesture, n_press, x, y):
        """Handle click: plain = single select, Ctrl = toggle, Shift = range."""
        state = gesture.get_current_event_state()
        ctrl = bool(state & Gdk.ModifierType.CONTROL_MASK)
        shift = bool(state & Gdk.ModifierType.SHIFT_MASK)

        widget = gesture.get_widget()
        # Find the FlowBoxChild parent
        child = widget.get_parent()
        while child and not isinstance(child, Gtk.FlowBoxChild):
            child = child.get_parent()
        if not child:
            return

        if shift and self._last_clicked_index is not None:
            # Range select from last clicked to this one
            target_idx = child.get_index()
            lo = min(self._last_clicked_index, target_idx)
            hi = max(self._last_clicked_index, target_idx)
            if not ctrl:
                self.flowbox.unselect_all()
            for i in range(lo, hi + 1):
                c = self.flowbox.get_child_at_index(i)
                if c:
                    self.flowbox.select_child(c)
            gesture.set_state(Gtk.EventSequenceState.CLAIMED)
        elif ctrl:
            # Toggle this item
            if child.is_selected():
                self.flowbox.unselect_child(child)
            else:
                self.flowbox.select_child(child)
            self._last_clicked_index = child.get_index()
            gesture.set_state(Gtk.EventSequenceState.CLAIMED)
        else:
            # Plain click: select only this, or deselect if already the sole selection
            if child.is_selected() and len(self._selected_paths) <= 1:
                self.flowbox.unselect_all()
            else:
                self.flowbox.unselect_all()
                self.flowbox.select_child(child)
            self._last_clicked_index = child.get_index()
            gesture.set_state(Gtk.EventSequenceState.CLAIMED)

    def _batch_favorite(self):
        if not self._selected_paths:
            return
        for p in self._selected_paths:
            if p.exists():
                perform_favorite(self.config, p, self.mode)
        self._reload_images()

    def _batch_context_action(self):
        if not self._selected_paths:
            return
        for p in self._selected_paths:
            perform_context_action(self.config, p, self.category, self.mode)
        self._reload_images()

    def _batch_delete(self):
        if not self._selected_paths:
            return
        for p in self._selected_paths:
            perform_delete(self.config, p)
        self._reload_images()

    # ── Callbacks ──

    def _on_selected(self, flowbox: Gtk.FlowBox):
        selected = flowbox.get_selected_children()
        if not selected:
            self.selected_path = None
            self._selected_name = None
            self._selected_paths.clear()
            self._set_preview(None)
            self._update_buttons()
            self._update_status()
            return

        # Collect selected paths
        self._selected_paths = []
        for child in selected:
            box = child.get_child()
            p = getattr(box, "_image_path", None)
            if p:
                self._selected_paths.append(p)

        # Always show last selected in preview
        last_box = selected[-1].get_child()
        self.selected_path = getattr(last_box, "_image_path", None)
        self._selected_name = getattr(last_box, "_blocklist_name", None)
        self._set_preview(self.selected_path)
        self._update_buttons()
        self._update_status()

    # ── Actions ──

    def _get_target_monitor(self) -> str | None:
        """Get the selected target monitor, or focused monitor if 'Focused'."""
        if self._monitor_combo and self._monitor_combo.get_active() > 0:
            return self._monitor_combo.get_active_text()
        return get_focused_monitor()

    def _set_wallpaper(self, target_path: Path | None = None, monitor: str | None = None):
        path = target_path or self.selected_path
        if not path or not path.exists():
            return
        mon = monitor or self._get_target_monitor()
        if not mon:
            return
        mon_cfg = find_monitor(self.config, mon)
        if mon_cfg:
            set_wallpaper(mon, path, self.config.transition)
            push_history(self.config, mon, path)

    def _open_url(self):
        if self.selected_path:
            url = wallhaven_url(self.selected_path)
        elif self._selected_name:
            url = wallhaven_url(Path(self._selected_name))
        else:
            return
        webbrowser.open(url)

    def _favorite(self):
        if not self.selected_path or not self.selected_path.exists():
            return
        perform_favorite(self.config, self.selected_path, self.mode)
        self._remove_selected()

    def _context_action(self):
        perform_context_action(
            self.config,
            self.selected_path,
            self.category,
            self.mode,
            self._selected_name,
        )
        self._remove_selected()

    def _delete(self):
        perform_delete(self.config, self.selected_path, self._selected_name)
        self._remove_selected()

    def _remove_selected(self):
        """Remove current selection from grid and select the next item."""
        selected = self.flowbox.get_selected_children()
        if not selected:
            return
        box = selected[0].get_child()
        self._remove_item(box)

    def _remove_item(self, box: Gtk.Box):
        """Remove a specific item from the grid and select the next one."""
        child = box.get_parent()
        while child and not isinstance(child, Gtk.FlowBoxChild):
            child = child.get_parent()
        if not child:
            return

        idx = child.get_index()
        img_path = getattr(box, "_image_path", None)
        if img_path and img_path in self.images:
            self.images.remove(img_path)

        self.flowbox.remove(child)
        self._update_status()

        total = len(self.images)
        if total > 0:
            next_idx = min(idx, total - 1)
            next_child = self.flowbox.get_child_at_index(next_idx)
            if next_child:
                self.flowbox.select_child(next_child)
        else:
            self.selected_path = None
            self._selected_name = None
            self._set_preview(None)
            self._update_buttons()
            self._show_empty_state()

    # ── Helpers ──

    def _update_status(self):
        n_img = len(self.images)
        n_bl = len(self._blocklist_only)
        if len(self._selected_paths) > 1:
            sel = len(self._selected_paths)
            total = n_img + n_bl
            self.status_label.set_text(f"{sel} selected / {total} \u00b7 {self.mode.upper()}")
        else:
            parts = [f"{n_img} image{'s' if n_img != 1 else ''}"]
            if n_bl > 0:
                parts.append(f"{n_bl} blocked")
            self.status_label.set_text(f"{' + '.join(parts)} \u00b7 {self.mode.upper()}")

    def _update_buttons(self):
        multi = len(self._selected_paths) > 1
        if multi:
            n_sel = len(self._selected_paths)
            self.btn_set.set_sensitive(False)
            self.btn_set.set_visible(False)
            self.btn_open.set_sensitive(False)
            self.btn_open.set_visible(False)

            self.btn_fav.set_label(f"Fav All ({n_sel}) [F]")
            self.btn_fav.set_sensitive(True)
            self.btn_fav.set_visible(self.category in ("pool", "disliked"))

            action_label = ACTION_CONFIG.get(self.category)
            if action_label:
                self.btn_action.set_label(f"{action_label} All ({n_sel}) [X]")
                self.btn_action.set_sensitive(True)
                self.btn_action.set_visible(True)
            else:
                self.btn_action.set_visible(False)

            self.btn_delete.set_label(f"Delete All ({n_sel}) [D]")
            self.btn_delete.set_sensitive(True)
            return

        # Single select mode
        self.btn_set.set_visible(True)
        self.btn_open.set_visible(True)
        self.btn_fav.set_label("Favorite [F]")
        self.btn_delete.set_label("Delete [D]")

        has_file = self.selected_path is not None
        has_sel = has_file or self._selected_name is not None
        self.btn_set.set_sensitive(has_file)
        self.btn_open.set_sensitive(has_sel)
        self.btn_delete.set_sensitive(has_sel)

        self.btn_fav.set_sensitive(has_file)
        self.btn_fav.set_visible(self.category in ("pool", "disliked"))

        if self.category == "disliked" and self._selected_name and not has_file:
            label = "Unblock"
        else:
            label = ACTION_CONFIG.get(self.category)
        if label:
            self.btn_action.set_label(f"{label} [X]")
            self.btn_action.set_sensitive(has_sel)
            self.btn_action.set_visible(True)
        else:
            self.btn_action.set_visible(False)

    # ── Public API ──

    def set_category(self, cat: str):
        if cat != self.category:
            self.category = cat
            self._reload_images()

    def set_mode(self, mode: str):
        if mode != self.mode:
            self.mode = mode
            write_mode(self.config, mode)
            self._reload_images()

    def handle_key(self, keyval: int, state: Gdk.ModifierType = 0) -> bool:
        ctrl = bool(state & Gdk.ModifierType.CONTROL_MASK)

        if ctrl and keyval == Gdk.KEY_a:
            self.flowbox.select_all()
            return True
        if ctrl and keyval == Gdk.KEY_A:
            self.flowbox.unselect_all()
            return True

        if keyval == Gdk.KEY_slash:
            self._search_entry.set_can_focus(True)
            self._search_entry.grab_focus()
            return True
        if keyval == Gdk.KEY_Escape:
            self._search_entry.set_text("")
            self._search_entry.set_can_focus(False)
            self.flowbox.unselect_all()
            self.widget.grab_focus()
            return True

        multi = len(self._selected_paths) > 1
        if multi:
            actions = {
                Gdk.KEY_f: self._batch_favorite,
                Gdk.KEY_x: self._batch_context_action,
                Gdk.KEY_d: self._batch_delete,
            }
        else:
            actions = {
                Gdk.KEY_Return: self._set_wallpaper,
                Gdk.KEY_f: self._favorite,
                Gdk.KEY_x: self._context_action,
                Gdk.KEY_d: self._delete,
                Gdk.KEY_o: self._open_url,
            }
        if action := actions.get(keyval):
            action()
            return True
        return False

    def shutdown(self):
        self._thumb_pool.shutdown(wait=False)
        if self._filter_debounce_id is not None:
            GLib.source_remove(self._filter_debounce_id)
