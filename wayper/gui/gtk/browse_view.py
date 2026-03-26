"""GTK4 browse panel: thumbnail grid + preview + action buttons."""

from __future__ import annotations

import webbrowser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk

from ...backend import find_monitor, get_focused_monitor, set_wallpaper
from ...browse._common import (
    get_blocklist_only,
    get_images,
    perform_context_action,
    perform_delete,
    perform_favorite,
    wallhaven_url,
)
from ...config import WayperConfig
from ...history import push as push_history
from ...state import read_mode, write_mode

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
        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_size_request(460, -1)
        scroll.set_vexpand(True)

        self.flowbox = Gtk.FlowBox()
        self.flowbox.set_valign(Gtk.Align.START)
        self.flowbox.set_max_children_per_line(4)
        self.flowbox.set_min_children_per_line(2)
        self.flowbox.set_selection_mode(Gtk.SelectionMode.SINGLE)
        self.flowbox.set_homogeneous(True)
        self.flowbox.set_row_spacing(8)
        self.flowbox.set_column_spacing(8)
        self.flowbox.connect("selected-children-changed", self._on_selected)

        scroll.set_child(self.flowbox)
        parent.append(scroll)

    def _build_preview(self, parent: Gtk.Box):
        right = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        right.set_hexpand(True)

        self.preview = Gtk.Picture()
        self.preview.set_content_fit(Gtk.ContentFit.CONTAIN)
        self.preview.set_can_shrink(True)
        self.preview.set_vexpand(True)
        self.preview.add_css_class("preview-area")
        right.append(self.preview)

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

    # ── Data loading ──

    def _reload_images(self):
        self.images = get_images(self.category, self.mode, self.config)
        self._blocklist_only = (
            get_blocklist_only(self.images, self.config) if self.category == "disliked" else []
        )
        self._populate_grid()
        self._update_status()
        self._update_buttons()
        self.selected_path = None
        self._selected_name = None
        self.preview.set_filename(None)

    def _populate_grid(self):
        while child := self.flowbox.get_first_child():
            self.flowbox.remove(child)

        for img_path in self.images:
            box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
            box._image_path = img_path
            box._blocklist_name = None

            picture = Gtk.Picture()
            picture.set_size_request(THUMB_SIZE, THUMB_SIZE)
            picture.set_content_fit(Gtk.ContentFit.COVER)
            picture.set_can_shrink(True)
            box.append(picture)

            label = Gtk.Label(label=img_path.stem[-8:])
            label.set_ellipsize(3)
            label.set_max_width_chars(12)
            box.append(label)

            self._load_thumb_async(str(img_path), picture)
            self.flowbox.append(box)

        for name in self._blocklist_only:
            box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
            box._image_path = None
            box._blocklist_name = name

            placeholder = Gtk.Label(label="No file")
            placeholder.set_size_request(THUMB_SIZE, THUMB_SIZE)
            placeholder.add_css_class("blocklist-placeholder")
            box.append(placeholder)

            stem = Path(name).stem
            label = Gtk.Label(label=stem[-8:])
            label.set_ellipsize(3)
            label.set_max_width_chars(12)
            box.append(label)

            self.flowbox.append(box)

    def _load_thumb_async(self, path: str, picture: Gtk.Picture):
        def worker():
            try:
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
                GLib.idle_add(_set, scaled)
            except Exception:
                pass

        def _set(pixbuf):
            texture = Gdk.Texture.new_for_pixbuf(pixbuf)
            picture.set_paintable(texture)
            return False

        self._thumb_pool.submit(worker)

    # ── Callbacks ──

    def _on_selected(self, flowbox: Gtk.FlowBox):
        selected = flowbox.get_selected_children()
        if not selected:
            self.selected_path = None
            self._selected_name = None
            self.preview.set_filename(None)
            self._update_buttons()
            return

        box = selected[0].get_child()
        self.selected_path = getattr(box, "_image_path", None)
        self._selected_name = getattr(box, "_blocklist_name", None)
        if self.selected_path:
            self.preview.set_filename(str(self.selected_path))
        else:
            self.preview.set_filename(None)
        self._update_buttons()

    # ── Actions ──

    def _set_wallpaper(self):
        if not self.selected_path or not self.selected_path.exists():
            return
        monitor = get_focused_monitor()
        if not monitor:
            return
        mon_cfg = find_monitor(self.config, monitor)
        if mon_cfg:
            set_wallpaper(monitor, self.selected_path, self.config.transition)
            push_history(self.config, monitor, self.selected_path)

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
        child = selected[0]
        idx = child.get_index()

        # Remove from internal lists
        box = child.get_child()
        img_path = getattr(box, "_image_path", None)
        bl_name = getattr(box, "_blocklist_name", None)
        if img_path and img_path in self.images:
            self.images.remove(img_path)
        elif bl_name and bl_name in self._blocklist_only:
            self._blocklist_only.remove(bl_name)

        self.flowbox.remove(child)
        self._update_status()

        # Select next (or previous if was last)
        total = len(self.images) + len(self._blocklist_only)
        if total > 0:
            next_idx = min(idx, total - 1)
            next_child = self.flowbox.get_child_at_index(next_idx)
            if next_child:
                self.flowbox.select_child(next_child)
        else:
            self.selected_path = None
            self._selected_name = None
            self.preview.set_filename(None)
            self._update_buttons()

    # ── Helpers ──

    def _update_status(self):
        n = len(self.images) + len(self._blocklist_only)
        self.status_label.set_text(f"{n} image{'s' if n != 1 else ''} \u00b7 {self.mode.upper()}")

    def _update_buttons(self):
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

    def handle_key(self, keyval: int) -> bool:
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
