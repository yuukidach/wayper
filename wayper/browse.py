"""GTK4 wallpaper browser."""

from __future__ import annotations

import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk

from .backend import find_monitor, get_focused_monitor, set_wallpaper
from .config import WayperConfig
from .pool import (
    IMAGE_EXTENSIONS,
    add_to_blacklist,
    favorites_dir,
    list_blacklist,
    list_images,
    pool_dir,
    remove_from_blacklist,
)
from .state import push_undo, read_mode, write_mode

THUMB_SIZE = 200
CATEGORIES = ("favorites", "pool", "disliked")
LABELS = {"favorites": "Favorites [1]", "pool": "Pool [2]", "disliked": "Disliked [3]"}

# Context action label and keyboard hint per category
ACTION_CONFIG = {
    "favorites": "Remove",
    "pool": "Reject",
    "disliked": "Restore",
}

CSS = b"""
window {
    background-color: #1e1e2e;
    color: #cdd6f4;
}
headerbar {
    background-color: #181825;
    color: #cdd6f4;
    border-bottom: 1px solid #313244;
}
.category-btn {
    background: #313244;
    color: #cdd6f4;
    border-radius: 8px;
    padding: 4px 14px;
    min-height: 28px;
    border: none;
    box-shadow: none;
}
.category-btn:hover {
    background: #45475a;
}
.category-btn:checked {
    background: #89b4fa;
    color: #1e1e2e;
}
.mode-btn {
    background: #313244;
    color: #cdd6f4;
    border-radius: 8px;
    padding: 4px 12px;
    min-height: 28px;
    border: none;
}
.mode-btn:checked {
    background: #f38ba8;
    color: #1e1e2e;
}
.preview-area {
    background-color: #181825;
    border-radius: 12px;
}
.action-btn {
    background: #313244;
    color: #cdd6f4;
    border-radius: 8px;
    padding: 6px 16px;
    border: none;
    min-height: 32px;
}
.action-btn:hover {
    background: #45475a;
}
.action-btn.destructive {
    background: #45475a;
    color: #f38ba8;
}
.action-btn.destructive:hover {
    background: #f38ba8;
    color: #1e1e2e;
}
.status-label {
    color: #6c7086;
    font-size: 12px;
}
.blocklist-placeholder {
    background: #313244;
    border-radius: 10px;
    color: #6c7086;
    font-size: 11px;
}
flowboxchild {
    background: transparent;
    border-radius: 10px;
    padding: 0;
    border: 2px solid transparent;
}
flowboxchild:selected {
    background: #313244;
    border-color: #89b4fa;
}
"""


def _get_orient(img_path: Path) -> str:
    """Detect orientation from parent directory name or image dimensions."""
    if "portrait" in str(img_path.parent):
        return "portrait"
    if "landscape" in str(img_path.parent):
        return "landscape"
    try:
        from PIL import Image

        img = Image.open(img_path)
        return "portrait" if img.height > img.width else "landscape"
    except Exception:
        return "landscape"


def _get_images(category: str, mode: str, config: WayperConfig) -> list[Path]:
    """Collect images for category and mode."""
    images: list[Path] = []
    if category == "favorites":
        for orient in ("landscape", "portrait"):
            images.extend(list_images(favorites_dir(config, mode, orient)))
    elif category == "disliked":
        images.extend(list_images(config.trash_dir / mode))
    else:
        for orient in ("landscape", "portrait"):
            images.extend(list_images(pool_dir(config, mode, orient)))
    return sorted(images, key=lambda p: p.stat().st_mtime, reverse=True)


def _wallhaven_url(img_path: Path) -> str:
    wall_id = img_path.stem.replace("wallhaven-", "")
    return f"https://wallhaven.cc/w/{wall_id}"


class BrowseWindow(Gtk.ApplicationWindow):
    def __init__(self, config: WayperConfig, category: str, **kwargs):
        super().__init__(**kwargs)
        self.config = config
        self.category = category
        self.mode = read_mode(config)
        self.selected_path: Path | None = None
        self._selected_name: str | None = None  # for blocklist-only entries
        self.images: list[Path] = []
        self._blocklist_only: list[str] = []  # names without trash files
        self._thumb_pool = ThreadPoolExecutor(max_workers=4)

        self.set_title("wayper")
        self.set_default_size(1200, 750)

        key_ctrl = Gtk.EventControllerKey.new()
        key_ctrl.connect("key-pressed", self._on_key)
        self.add_controller(key_ctrl)

        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.set_child(vbox)

        self._build_header()

        hbox = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=16)
        hbox.set_margin_start(16)
        hbox.set_margin_end(16)
        hbox.set_margin_bottom(16)
        hbox.set_vexpand(True)
        vbox.append(hbox)

        self._build_grid(hbox)
        self._build_preview(hbox)
        self._reload_images()

    def do_close_request(self):
        self._thumb_pool.shutdown(wait=False)
        return False

    # ── Header ──────────────────────────────────────────

    def _build_header(self):
        header = Gtk.HeaderBar()
        header.set_show_title_buttons(True)
        self.set_titlebar(header)

        cat_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        self._cat_buttons: dict[str, Gtk.ToggleButton] = {}
        group = None
        for cat in CATEGORIES:
            btn = Gtk.ToggleButton(label=LABELS[cat])
            btn.add_css_class("category-btn")
            if group:
                btn.set_group(group)
            else:
                group = btn
            if cat == self.category:
                btn.set_active(True)
            btn.connect("toggled", self._on_category_toggled, cat)
            cat_box.append(btn)
            self._cat_buttons[cat] = btn
        header.pack_start(cat_box)

        self._mode_btn = Gtk.ToggleButton(label=f"{self.mode.upper()} [M]")
        self._mode_btn.add_css_class("mode-btn")
        self._mode_btn.set_active(self.mode == "nsfw")
        self._mode_btn.connect("toggled", self._on_mode_toggled)
        header.pack_end(self._mode_btn)

    # ── Grid ────────────────────────────────────────────

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

    # ── Data loading ────────────────────────────────────

    def _reload_images(self):
        self.images = _get_images(self.category, self.mode, self.config)
        # Build blocklist-only entries (no trash file)
        if self.category == "disliked":
            trash_names = {p.name for p in self.images}
            self._blocklist_only = [
                name for _ts, name in list_blacklist(self.config)
                if name not in trash_names
            ]
        else:
            self._blocklist_only = []
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
            label.set_ellipsize(3)  # PANGO_ELLIPSIZE_END
            label.set_max_width_chars(12)
            box.append(label)

            self._load_thumb_async(str(img_path), picture)
            self.flowbox.append(box)

        # Blocklist-only entries (no file on disk)
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
                # Load at 2x then center-crop to square for uniform grid
                pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                    path, THUMB_SIZE * 2, THUMB_SIZE * 2, True,
                )
                w, h = pixbuf.get_width(), pixbuf.get_height()
                side = min(w, h)
                cropped = pixbuf.new_subpixbuf((w - side) // 2, (h - side) // 2, side, side)
                scaled = cropped.scale_simple(
                    THUMB_SIZE, THUMB_SIZE, GdkPixbuf.InterpType.BILINEAR,
                )
                GLib.idle_add(_set, scaled)
            except Exception:
                pass

        def _set(pixbuf):
            texture = Gdk.Texture.new_for_pixbuf(pixbuf)
            picture.set_paintable(texture)
            return False

        self._thumb_pool.submit(worker)

    # ── Callbacks ───────────────────────────────────────

    def _on_category_toggled(self, btn: Gtk.ToggleButton, cat: str):
        if btn.get_active():
            self.category = cat
            self._reload_images()

    def _on_mode_toggled(self, btn: Gtk.ToggleButton):
        self.mode = "nsfw" if btn.get_active() else "sfw"
        btn.set_label(f"{self.mode.upper()} [M]")
        write_mode(self.config, self.mode)
        self._reload_images()

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

    def _on_key(self, ctrl, keyval, keycode, state):
        actions = {
            Gdk.KEY_q: self.close,
            Gdk.KEY_Escape: self.close,
            Gdk.KEY_Return: self._set_wallpaper,
            Gdk.KEY_f: self._favorite,
            Gdk.KEY_x: self._context_action,
            Gdk.KEY_d: self._delete,
            Gdk.KEY_o: self._open_url,
            Gdk.KEY_m: lambda: self._mode_btn.set_active(not self._mode_btn.get_active()),
            Gdk.KEY_1: lambda: self._cat_buttons["favorites"].set_active(True),
            Gdk.KEY_2: lambda: self._cat_buttons["pool"].set_active(True),
            Gdk.KEY_3: lambda: self._cat_buttons["disliked"].set_active(True),
        }
        if action := actions.get(keyval):
            action()
            return True
        return False

    # ── Actions ─────────────────────────────────────────

    def _set_wallpaper(self):
        if not self.selected_path or not self.selected_path.exists():
            return
        monitor = get_focused_monitor()
        if not monitor:
            return
        mon_cfg = find_monitor(self.config, monitor)
        if mon_cfg:
            set_wallpaper(monitor, self.selected_path, self.config.transition)

    def _open_url(self):
        if self.selected_path:
            url = _wallhaven_url(self.selected_path)
        elif self._selected_name:
            url = _wallhaven_url(Path(self._selected_name))
        else:
            return
        subprocess.Popen(
            ["xdg-open", url],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )

    def _favorite(self):
        """Move selected image to favorites."""
        if not self.selected_path or not self.selected_path.exists():
            return
        path = self.selected_path
        orient = _get_orient(path)
        dest = favorites_dir(self.config, self.mode, orient) / path.name
        dest.parent.mkdir(parents=True, exist_ok=True)
        path.rename(dest)
        self._reload_images()

    def _context_action(self):
        """Remove (favorites), Dislike (pool), or Restore (disliked)."""
        if self.category == "disliked" and self._selected_name and not self.selected_path:
            # Blocklist-only entry: just remove from blacklist
            remove_from_blacklist(self.config, self._selected_name)
            self._reload_images()
            return

        if not self.selected_path or not self.selected_path.exists():
            return
        path = self.selected_path
        orient = _get_orient(path)

        if self.category == "favorites":
            dest = pool_dir(self.config, self.mode, orient) / path.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            path.rename(dest)
        elif self.category == "pool":
            add_to_blacklist(self.config, path.name)
            push_undo(self.config, path.name, path.parent)
        elif self.category == "disliked":
            dest = pool_dir(self.config, self.mode, orient) / path.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            path.rename(dest)
            remove_from_blacklist(self.config, path.name)

        self._reload_images()

    def _delete(self):
        if self._selected_name and not self.selected_path:
            # Blocklist-only: remove from blacklist
            remove_from_blacklist(self.config, self._selected_name)
            self._reload_images()
            return
        if not self.selected_path or not self.selected_path.exists():
            return
        self.selected_path.unlink()
        self._reload_images()

    # ── Helpers ─────────────────────────────────────────

    def _update_status(self):
        n = len(self.images) + len(self._blocklist_only)
        self.status_label.set_text(
            f"{n} image{'s' if n != 1 else ''} · {self.mode.upper()}"
        )

    def _update_buttons(self):
        has_file = self.selected_path is not None
        has_sel = has_file or self._selected_name is not None
        self.btn_set.set_sensitive(has_file)
        self.btn_open.set_sensitive(has_sel)
        self.btn_delete.set_sensitive(has_sel)

        # Favorite button: visible in pool and disliked, only for file entries
        self.btn_fav.set_sensitive(has_file)
        self.btn_fav.set_visible(self.category in ("pool", "disliked"))

        # Context action button: Remove/Dislike/Restore/Unblock
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


class BrowseApp(Gtk.Application):
    _css_applied = False

    def __init__(self, config: WayperConfig, category: str):
        super().__init__(application_id="io.github.yuukidach.wayper.browse")
        self._config = config
        self._category = category

    def do_activate(self):
        if not BrowseApp._css_applied:
            css = Gtk.CssProvider()
            css.load_from_data(CSS)
            Gtk.StyleContext.add_provider_for_display(
                Gdk.Display.get_default(), css,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
            )
            BrowseApp._css_applied = True

        win = BrowseWindow(
            config=self._config,
            category=self._category,
            application=self,
        )
        win.present()


def run(config: WayperConfig, category: str = "favorites"):
    app = BrowseApp(config=config, category=category)
    app.run()
