"""GTK4 Wallhaven online browse panel: search, preview, and download."""

from __future__ import annotations

import asyncio
import threading
import webbrowser
from concurrent.futures import ThreadPoolExecutor

import gi
import httpx

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("GdkPixbuf", "2.0")
gi.require_version("Pango", "1.0")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk, Pango

from ...browse._common import format_size
from ...config import WayperConfig
from ...image import resize_crop
from ...pool import favorites_dir, is_blacklisted, pool_dir, save_metadata
from ...state import read_mode
from ...wallhaven import WallhavenClient
from . import populate_tags

THUMB_SIZE = 200


class WallhavenPanel:
    """Browse and download wallpapers from Wallhaven."""

    def __init__(self, config: WayperConfig):
        self.config = config
        self._client = WallhavenClient(config)
        self._sync_http = httpx.Client(proxy=config.proxy, timeout=15)
        self._thumb_pool = ThreadPoolExecutor(max_workers=4)
        self._results: list[dict] = []
        self._page: int = 1
        self._searching: bool = False
        self._debounce_id: int | None = None
        self._selected_item: dict | None = None
        self._thumb_cache = config.download_dir / ".thumb_cache"
        self._thumb_cache.mkdir(parents=True, exist_ok=True)
        self.widget = self._build()

    def _build(self) -> Gtk.Box:
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        root.set_margin_start(16)
        root.set_margin_end(16)
        root.set_margin_top(8)
        root.set_margin_bottom(16)
        root.set_vexpand(True)
        root.set_hexpand(True)

        # Search bar
        search_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        search_bar.add_css_class("search-bar")

        self._search_entry = Gtk.SearchEntry()
        self._search_entry.set_placeholder_text("Search Wallhaven...")
        self._search_entry.set_hexpand(True)
        self._search_entry.connect("search-changed", self._on_search_changed)
        self._search_entry.connect("activate", self._on_search_activate)
        search_bar.append(self._search_entry)

        # Sort combo
        self._sort_combo = Gtk.ComboBoxText()
        for label in ("Toplist", "Random", "Hot", "Date Added", "Views", "Favorites"):
            self._sort_combo.append_text(label)
        self._sort_combo.set_active(0)
        self._sort_combo.connect("changed", self._on_sort_changed)
        search_bar.append(self._sort_combo)

        # Search button
        search_btn = Gtk.Button(label="Search")
        search_btn.add_css_class("action-btn")
        search_btn.connect("clicked", lambda _: self._do_search())
        search_bar.append(search_btn)

        root.append(search_bar)

        # Main content: grid + preview
        content = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=16)
        content.set_vexpand(True)

        # Left: grid
        grid_col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        grid_col.set_size_request(460, -1)

        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_vexpand(True)

        self._flowbox = Gtk.FlowBox()
        self._flowbox.set_valign(Gtk.Align.START)
        self._flowbox.set_max_children_per_line(4)
        self._flowbox.set_min_children_per_line(2)
        self._flowbox.set_selection_mode(Gtk.SelectionMode.SINGLE)
        self._flowbox.set_homogeneous(True)
        self._flowbox.set_row_spacing(8)
        self._flowbox.set_column_spacing(8)
        self._flowbox.connect("selected-children-changed", self._on_selected)
        scroll.set_child(self._flowbox)
        grid_col.append(scroll)

        # Status + Load More
        bottom_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        bottom_bar.set_halign(Gtk.Align.CENTER)

        self._status_label = Gtk.Label(label="Search to browse Wallhaven")
        self._status_label.add_css_class("status-label")
        bottom_bar.append(self._status_label)

        self._spinner = Gtk.Spinner()
        bottom_bar.append(self._spinner)

        self._load_more_btn = Gtk.Button(label="Load more")
        self._load_more_btn.add_css_class("action-btn")
        self._load_more_btn.connect("clicked", lambda _: self._load_more())
        self._load_more_btn.set_visible(False)
        bottom_bar.append(self._load_more_btn)

        grid_col.append(bottom_bar)
        content.append(grid_col)

        # Right: preview + metadata
        right = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        right.set_hexpand(True)

        self._preview = Gtk.Picture()
        self._preview.set_content_fit(Gtk.ContentFit.CONTAIN)
        self._preview.set_can_shrink(True)
        self._preview.set_vexpand(True)
        self._preview.add_css_class("preview-area")
        right.append(self._preview)

        # Metadata
        self._meta_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self._meta_box.add_css_class("wallhaven-meta")

        self._res_label = Gtk.Label(label="")
        self._res_label.set_halign(Gtk.Align.START)
        self._meta_box.append(self._res_label)

        self._size_label = Gtk.Label(label="")
        self._size_label.set_halign(Gtk.Align.START)
        self._meta_box.append(self._size_label)

        self._views_label = Gtk.Label(label="")
        self._views_label.set_halign(Gtk.Align.START)
        self._meta_box.append(self._views_label)

        # Tags flow
        self._tags_box = Gtk.FlowBox()
        self._tags_box.set_valign(Gtk.Align.START)
        self._tags_box.set_max_children_per_line(10)
        self._tags_box.set_min_children_per_line(2)
        self._tags_box.set_selection_mode(Gtk.SelectionMode.NONE)
        self._tags_box.set_row_spacing(4)
        self._tags_box.set_column_spacing(4)
        self._meta_box.append(self._tags_box)

        right.append(self._meta_box)
        self._meta_box.set_visible(False)

        # Action buttons
        btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        btn_box.set_halign(Gtk.Align.CENTER)

        self._dl_btn = Gtk.Button(label="Download [Enter]")
        self._dl_btn.add_css_class("download-btn")
        self._dl_btn.connect("clicked", lambda _: self._download_selected())
        self._dl_btn.set_sensitive(False)
        btn_box.append(self._dl_btn)

        self._open_btn = Gtk.Button(label="Open URL [O]")
        self._open_btn.add_css_class("action-btn")
        self._open_btn.connect("clicked", lambda _: self._open_url())
        self._open_btn.set_sensitive(False)
        btn_box.append(self._open_btn)

        self._dl_spinner = Gtk.Spinner()
        btn_box.append(self._dl_spinner)

        right.append(btn_box)
        content.append(right)

        root.append(content)
        return root

    # ── Search ──

    def _on_search_changed(self, entry: Gtk.SearchEntry):
        """Debounce search input."""
        if self._debounce_id is not None:
            GLib.source_remove(self._debounce_id)
        self._debounce_id = GLib.timeout_add(500, self._debounce_search)

    def _debounce_search(self) -> bool:
        self._debounce_id = None
        self._do_search()
        return False

    def _on_search_activate(self, entry: Gtk.SearchEntry):
        """Immediate search on Enter."""
        if self._debounce_id is not None:
            GLib.source_remove(self._debounce_id)
            self._debounce_id = None
        self._do_search()

    def _on_sort_changed(self, combo: Gtk.ComboBoxText):
        if self._results:
            self._do_search()

    def _do_search(self, append: bool = False):
        if self._searching:
            return
        if not append:
            self._page = 1
            self._results.clear()

        self._searching = True
        self._spinner.start()
        self._status_label.set_label("Searching...")

        query = self._search_entry.get_text().strip()
        sort_keys = ["toplist", "random", "hot", "date_added", "views", "favorites"]
        sort_idx = self._sort_combo.get_active()
        sorting = sort_keys[sort_idx] if 0 <= sort_idx < len(sort_keys) else "toplist"
        mode = read_mode(self.config)
        page = self._page

        def _worker():
            try:
                results = asyncio.run(
                    self._client.search_with_meta(
                        query=query,
                        page=page,
                        purity=mode,
                        sorting=sorting,
                    )
                )
                GLib.idle_add(self._on_results, results, append)
            except Exception:
                GLib.idle_add(self._on_results, [], append)

        threading.Thread(target=_worker, daemon=True).start()

    def _on_results(self, data: list[dict], append: bool):
        self._searching = False
        self._spinner.stop()

        if append:
            self._results.extend(data)
        else:
            self._results = data
            while child := self._flowbox.get_first_child():
                self._flowbox.remove(child)

        for item in data:
            self._add_result_card(item)

        n = len(self._results)
        self._status_label.set_label(f"{n} result{'s' if n != 1 else ''}")
        self._load_more_btn.set_visible(len(data) >= 24)
        return False

    def _add_result_card(self, item: dict):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        box.add_css_class("wallhaven-card")
        box._item = item

        picture = Gtk.Picture()
        picture.set_size_request(THUMB_SIZE, THUMB_SIZE)
        picture.set_content_fit(Gtk.ContentFit.COVER)
        picture.set_can_shrink(True)
        picture.add_css_class("thumb-skeleton")
        box.append(picture)

        # Resolution label
        res = item.get("resolution", "")
        label = Gtk.Label(label=res)
        label.set_ellipsize(Pango.EllipsizeMode.END)
        label.set_max_width_chars(12)
        box.append(label)

        # Load thumbnail
        thumb_url = item.get("thumbs", {}).get("small", "")
        if thumb_url:
            self._load_wallhaven_thumb(thumb_url, item.get("id", ""), picture)

        self._flowbox.append(box)

    def _load_wallhaven_thumb(self, url: str, wall_id: str, picture: Gtk.Picture):
        """Download and display a Wallhaven thumbnail."""
        cache_path = self._thumb_cache / f"{wall_id}.jpg"

        def worker():
            try:
                if not cache_path.exists():
                    resp = self._sync_http.get(url)
                    resp.raise_for_status()
                    cache_path.write_bytes(resp.content)

                pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                    str(cache_path), THUMB_SIZE, THUMB_SIZE, True
                )
                w, h = pixbuf.get_width(), pixbuf.get_height()
                side = min(w, h)
                cropped = pixbuf.new_subpixbuf((w - side) // 2, (h - side) // 2, side, side)
                scaled = cropped.scale_simple(THUMB_SIZE, THUMB_SIZE, GdkPixbuf.InterpType.BILINEAR)
                GLib.idle_add(_set, scaled)
            except Exception:
                pass

        def _set(pixbuf):
            texture = Gdk.Texture.new_for_pixbuf(pixbuf)
            picture.set_paintable(texture)
            picture.remove_css_class("thumb-skeleton")
            picture.add_css_class("thumb-loaded")
            return False

        self._thumb_pool.submit(worker)

    def _load_more(self):
        self._page += 1
        self._do_search(append=True)

    # ── Selection ──

    def _on_selected(self, flowbox: Gtk.FlowBox):
        selected = flowbox.get_selected_children()
        if not selected:
            self._selected_item = None
            self._preview.set_filename(None)
            self._meta_box.set_visible(False)
            self._dl_btn.set_sensitive(False)
            self._open_btn.set_sensitive(False)
            return

        box = selected[0].get_child()
        item = getattr(box, "_item", None)
        if not item:
            return

        self._selected_item = item

        # Show large thumbnail in preview
        large_url = item.get("thumbs", {}).get("large", "")
        wall_id = item.get("id", "")
        large_cache = self._thumb_cache / f"{wall_id}_large.jpg"

        def _load_large():
            try:
                if not large_cache.exists():
                    resp = self._sync_http.get(large_url)
                    resp.raise_for_status()
                    large_cache.write_bytes(resp.content)
                GLib.idle_add(
                    lambda: (
                        self._preview.set_filename(str(large_cache)),
                        False,
                    )[-1]
                )
            except Exception:
                pass

        self._thumb_pool.submit(_load_large)

        # Update metadata
        res = item.get("resolution", "?")
        file_size = item.get("file_size", 0)
        views = item.get("views", 0)
        favs = item.get("favorites", 0)

        self._res_label.set_label(f"Resolution: {res}")
        self._size_label.set_label(f"Size: {format_size(file_size)}")
        self._views_label.set_label(f"Views: {views:,}  |  Favs: {favs:,}")
        self._meta_box.set_visible(True)

        populate_tags(self._tags_box, [t.get("name", "") for t in item.get("tags", [])[:10]])

        self._dl_btn.set_sensitive(True)
        self._open_btn.set_sensitive(True)

    # ── Actions ──

    def _download_selected(self):
        item = self._selected_item
        if not item:
            return

        url = item.get("path", "")
        if not url:
            return

        self._dl_btn.set_sensitive(False)
        self._dl_spinner.start()

        filename = url.rsplit("/", 1)[-1]
        mode = read_mode(self.config)
        res = item.get("resolution", "1920x1080")
        w, h = (int(x) for x in res.split("x")) if "x" in res else (1920, 1080)
        orient = "portrait" if h > w else "landscape"
        dest_dir = pool_dir(self.config, mode, orient)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / filename

        # Check if already exists
        fav_dir = favorites_dir(self.config, mode, orient)
        if dest.exists() or (fav_dir / filename).exists():
            self._dl_btn.set_sensitive(True)
            self._dl_spinner.stop()
            self._dl_btn.set_label("Already exists")
            GLib.timeout_add_seconds(
                2, lambda: (self._dl_btn.set_label("Download [Enter]"), False)[-1]
            )
            return

        if is_blacklisted(self.config, filename):
            self._dl_btn.set_sensitive(True)
            self._dl_spinner.stop()
            self._dl_btn.set_label("Blacklisted")
            GLib.timeout_add_seconds(
                2, lambda: (self._dl_btn.set_label("Download [Enter]"), False)[-1]
            )
            return

        def _worker():
            try:
                success = asyncio.run(self._client.download_image(url, dest))
                if success:
                    save_metadata(self.config, filename, item)
                    # Resize to monitor dimensions
                    for m in self.config.monitors:
                        if m.orientation == orient:
                            resize_crop(dest, m.width, m.height)
                            break
                    GLib.idle_add(_done, True)
                else:
                    GLib.idle_add(_done, False)
            except Exception:
                GLib.idle_add(_done, False)

        def _done(success):
            self._dl_spinner.stop()
            self._dl_btn.set_sensitive(True)
            if success:
                self._dl_btn.set_label("Downloaded!")
            else:
                self._dl_btn.set_label("Failed")
            GLib.timeout_add_seconds(
                2, lambda: (self._dl_btn.set_label("Download [Enter]"), False)[-1]
            )
            return False

        threading.Thread(target=_worker, daemon=True).start()

    def _open_url(self):
        if self._selected_item:
            url = self._selected_item.get("url", "")
            if url:
                webbrowser.open(url)

    # ── Keyboard ──

    def handle_key(self, keyval: int) -> bool:
        if keyval == Gdk.KEY_o:
            self._open_url()
            return True
        if keyval == Gdk.KEY_Return:
            self._download_selected()
            return True
        if keyval == Gdk.KEY_slash:
            self._search_entry.grab_focus()
            return True
        return False

    # ── Cleanup ──

    def shutdown(self):
        self._thumb_pool.shutdown(wait=False)
        self._sync_http.close()
        if self._debounce_id is not None:
            GLib.source_remove(self._debounce_id)
