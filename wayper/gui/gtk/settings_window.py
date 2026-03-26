"""GTK4 settings window with General / Wallhaven / Monitors tabs."""

from __future__ import annotations

from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gtk

from ...config import MonitorConfig, WayperConfig, compact_home, save_config

_shared_window: SettingsWindow | None = None


class SettingsWindow(Gtk.Window):
    """Preferences window with three tabs (singleton)."""

    @classmethod
    def show_for(
        cls,
        config: WayperConfig,
        parent: Gtk.Window | None = None,
        on_save: callable = None,
    ):
        global _shared_window
        if _shared_window is not None:
            _shared_window.present()
            return
        win = cls(config=config, on_save=on_save)
        if parent:
            win.set_transient_for(parent)
        _shared_window = win
        win.present()

    def __init__(self, config: WayperConfig, on_save: callable = None):
        super().__init__(title="Wayper Settings")
        self.config = config
        self._on_save = on_save
        self.set_default_size(560, 440)
        self.set_resizable(True)
        self.connect("close-request", self._on_close)

        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.set_child(vbox)

        notebook = Gtk.Notebook()
        vbox.append(notebook)

        # General tab
        self._general_fields = {}
        notebook.append_page(self._build_general(), Gtk.Label(label="General"))

        # Wallhaven tab
        self._wallhaven_fields = {}
        notebook.append_page(self._build_wallhaven(), Gtk.Label(label="Wallhaven"))

        # Monitors tab
        notebook.append_page(self._build_monitors(), Gtk.Label(label="Monitors"))

        # Save button
        btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        btn_box.set_halign(Gtk.Align.END)
        btn_box.set_margin_end(16)
        btn_box.set_margin_bottom(12)
        btn_box.set_margin_top(8)

        save_btn = Gtk.Button(label="Save")
        save_btn.add_css_class("action-btn")
        save_btn.connect("clicked", self._on_save_clicked)
        btn_box.append(save_btn)

        vbox.append(btn_box)

        # Esc to close
        key_ctrl = Gtk.EventControllerKey()
        key_ctrl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        key_ctrl.connect("key-pressed", self._on_key)
        self.add_controller(key_ctrl)

    # ── General ──

    def _build_general(self) -> Gtk.Box:
        grid = Gtk.Grid()
        grid.set_row_spacing(10)
        grid.set_column_spacing(12)
        grid.set_margin_start(16)
        grid.set_margin_end(16)
        grid.set_margin_top(16)
        grid.set_margin_bottom(16)

        c = self.config
        fields = [
            ("API Key", "api_key", c.api_key, True),
            ("Proxy", "proxy", c.proxy or "", False),
            ("Download Dir", "download_dir", compact_home(c.download_dir), False),
            ("Quota (MB)", "quota_mb", str(c.quota_mb), False),
            ("Interval (s)", "interval", str(c.interval), False),
            ("Pool Target", "pool_target", str(c.pool_target), False),
        ]

        for row, (label, key, value, is_password) in enumerate(fields):
            lbl = Gtk.Label(label=label)
            lbl.set_halign(Gtk.Align.END)
            grid.attach(lbl, 0, row, 1, 1)

            if is_password:
                entry = Gtk.PasswordEntry()
                entry.set_text(value)
            else:
                entry = Gtk.Entry()
                entry.set_text(value)
            entry.set_hexpand(True)
            entry.add_css_class("settings-entry")
            grid.attach(entry, 1, row, 1, 1)
            self._general_fields[key] = entry

        # Default mode dropdown
        row = len(fields)
        lbl = Gtk.Label(label="Default Mode")
        lbl.set_halign(Gtk.Align.END)
        grid.attach(lbl, 0, row, 1, 1)

        mode_combo = Gtk.ComboBoxText()
        for m in ("sfw", "nsfw"):
            mode_combo.append_text(m)
        mode_combo.set_active(0 if c.default_mode == "sfw" else 1)
        mode_combo.set_hexpand(True)
        grid.attach(mode_combo, 1, row, 1, 1)
        self._general_fields["default_mode"] = mode_combo

        return grid

    # ── Wallhaven ──

    def _build_wallhaven(self) -> Gtk.Box:
        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        vbox.set_margin_start(16)
        vbox.set_margin_end(16)
        vbox.set_margin_top(16)
        vbox.set_margin_bottom(16)

        wh = self.config.wallhaven
        cats = wh.categories.ljust(3, "0")

        # Categories
        cat_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        cat_label = Gtk.Label(label="Categories")
        cat_label.set_halign(Gtk.Align.START)
        vbox.append(cat_label)

        self._cat_general = Gtk.CheckButton(label="General")
        self._cat_general.set_active(cats[0] == "1")
        self._cat_anime = Gtk.CheckButton(label="Anime")
        self._cat_anime.set_active(cats[1] == "1")
        self._cat_people = Gtk.CheckButton(label="People")
        self._cat_people.set_active(cats[2] == "1")
        cat_box.append(self._cat_general)
        cat_box.append(self._cat_anime)
        cat_box.append(self._cat_people)
        vbox.append(cat_box)

        # Sorting
        sort_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        sort_box.append(Gtk.Label(label="Sorting"))
        sort_options = ["toplist", "random", "hot", "date_added", "relevance", "views", "favorites"]
        self._sorting = Gtk.ComboBoxText()
        for s in sort_options:
            self._sorting.append_text(s)
        if wh.sorting in sort_options:
            self._sorting.set_active(sort_options.index(wh.sorting))
        self._sorting.set_hexpand(True)
        sort_box.append(self._sorting)
        vbox.append(sort_box)

        # Top Range
        range_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        range_box.append(Gtk.Label(label="Top Range"))
        range_options = ["1d", "3d", "1w", "1M", "3M", "6M", "1y"]
        self._top_range = Gtk.ComboBoxText()
        for r in range_options:
            self._top_range.append_text(r)
        if wh.top_range in range_options:
            self._top_range.set_active(range_options.index(wh.top_range))
        self._top_range.set_hexpand(True)
        range_box.append(self._top_range)
        vbox.append(range_box)

        # AI Art filter
        self._ai_filter = Gtk.CheckButton(label="Filter AI-generated art")
        self._ai_filter.set_active(wh.ai_art_filter == 1)
        vbox.append(self._ai_filter)

        # Exclude Tags (API-level OR)
        tag_label = Gtk.Label(label="Exclude Tags (comma-separated, any match)")
        tag_label.set_halign(Gtk.Align.START)
        vbox.append(tag_label)

        self._exclude_tags = Gtk.Entry()
        self._exclude_tags.set_text(", ".join(wh.exclude_tags))
        self._exclude_tags.set_hexpand(True)
        self._exclude_tags.add_css_class("settings-entry")
        self._exclude_tags.set_placeholder_text("e.g. MetArt, watermarked")
        vbox.append(self._exclude_tags)

        # Exclude Combos (client-side AND within each line)
        combo_label = Gtk.Label(label="Exclude Combos (one rule per line, tags joined by +)")
        combo_label.set_halign(Gtk.Align.START)
        vbox.append(combo_label)

        combo_scroll = Gtk.ScrolledWindow()
        combo_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        combo_scroll.set_min_content_height(80)
        combo_scroll.set_vexpand(True)

        self._exclude_combos = Gtk.TextView()
        self._exclude_combos.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        self._exclude_combos.add_css_class("settings-entry")
        buf = self._exclude_combos.get_buffer()
        combo_text = "\n".join(" + ".join(combo) for combo in wh.exclude_combos)
        buf.set_text(combo_text)
        combo_scroll.set_child(self._exclude_combos)
        vbox.append(combo_scroll)

        return vbox

    # ── Monitors ──

    def _build_monitors(self) -> Gtk.Box:
        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        vbox.set_margin_start(16)
        vbox.set_margin_end(16)
        vbox.set_margin_top(16)
        vbox.set_margin_bottom(16)

        # Header
        header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        for label, width in [("Name", 120), ("Width", 80), ("Height", 80), ("Orientation", 120)]:
            lbl = Gtk.Label(label=label)
            lbl.set_size_request(width, -1)
            lbl.set_halign(Gtk.Align.START)
            header.append(lbl)
        vbox.append(header)

        # Monitor rows
        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_vexpand(True)

        self._monitor_list = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        scroll.set_child(self._monitor_list)
        vbox.append(scroll)

        self._monitor_rows: list[dict[str, Gtk.Entry | Gtk.ComboBoxText]] = []
        for mon in self.config.monitors:
            self._add_monitor_row(mon)

        # Add/Remove buttons
        btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        add_btn = Gtk.Button(label="+")
        add_btn.add_css_class("action-btn")
        add_btn.connect(
            "clicked",
            lambda _: self._add_monitor_row(
                MonitorConfig(name="DP-1", width=1920, height=1080, orientation="landscape")
            ),
        )
        remove_btn = Gtk.Button(label="-")
        remove_btn.add_css_class("action-btn")
        remove_btn.connect("clicked", lambda _: self._remove_last_monitor())
        btn_box.append(add_btn)
        btn_box.append(remove_btn)
        vbox.append(btn_box)

        return vbox

    def _add_monitor_row(self, mon: MonitorConfig):
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)

        name_entry = Gtk.Entry()
        name_entry.set_text(mon.name)
        name_entry.set_size_request(120, -1)
        name_entry.add_css_class("settings-entry")
        row.append(name_entry)

        width_entry = Gtk.Entry()
        width_entry.set_text(str(mon.width))
        width_entry.set_size_request(80, -1)
        width_entry.add_css_class("settings-entry")
        row.append(width_entry)

        height_entry = Gtk.Entry()
        height_entry.set_text(str(mon.height))
        height_entry.set_size_request(80, -1)
        height_entry.add_css_class("settings-entry")
        row.append(height_entry)

        orient_combo = Gtk.ComboBoxText()
        orient_combo.append_text("landscape")
        orient_combo.append_text("portrait")
        orient_combo.set_active(0 if mon.orientation == "landscape" else 1)
        orient_combo.set_size_request(120, -1)
        row.append(orient_combo)

        self._monitor_list.append(row)
        self._monitor_rows.append(
            {
                "name": name_entry,
                "width": width_entry,
                "height": height_entry,
                "orientation": orient_combo,
                "row": row,
            }
        )

    def _remove_last_monitor(self):
        if not self._monitor_rows:
            return
        entry = self._monitor_rows.pop()
        self._monitor_list.remove(entry["row"])

    # ── Save ──

    def _save(self):
        c = self.config

        # General
        api_key_widget = self._general_fields["api_key"]
        c.api_key = api_key_widget.get_text()
        proxy = self._general_fields["proxy"].get_text().strip()
        c.proxy = proxy if proxy else None
        c.download_dir = Path(self._general_fields["download_dir"].get_text().strip()).expanduser()
        try:
            c.quota_mb = int(self._general_fields["quota_mb"].get_text())
        except ValueError:
            pass
        try:
            c.interval = int(self._general_fields["interval"].get_text())
        except ValueError:
            pass
        try:
            c.pool_target = int(self._general_fields["pool_target"].get_text())
        except ValueError:
            pass
        mode_widget = self._general_fields["default_mode"]
        c.default_mode = mode_widget.get_active_text() or c.default_mode

        # Wallhaven
        cats = (
            ("1" if self._cat_general.get_active() else "0")
            + ("1" if self._cat_anime.get_active() else "0")
            + ("1" if self._cat_people.get_active() else "0")
        )
        c.wallhaven.categories = cats
        c.wallhaven.sorting = self._sorting.get_active_text() or c.wallhaven.sorting
        c.wallhaven.top_range = self._top_range.get_active_text() or c.wallhaven.top_range
        c.wallhaven.ai_art_filter = 1 if self._ai_filter.get_active() else 0
        raw_tags = self._exclude_tags.get_text().strip()
        c.wallhaven.exclude_tags = (
            [t.strip() for t in raw_tags.split(",") if t.strip()] if raw_tags else []
        )
        buf = self._exclude_combos.get_buffer()
        combo_text = buf.get_text(buf.get_start_iter(), buf.get_end_iter(), False)
        c.wallhaven.exclude_combos = [
            [t.strip() for t in line.split("+") if t.strip()]
            for line in combo_text.strip().splitlines()
            if line.strip()
        ]

        # Monitors
        c.monitors = []
        for row_fields in self._monitor_rows:
            try:
                c.monitors.append(
                    MonitorConfig(
                        name=row_fields["name"].get_text().strip(),
                        width=int(row_fields["width"].get_text()),
                        height=int(row_fields["height"].get_text()),
                        orientation=row_fields["orientation"].get_active_text() or "landscape",
                    )
                )
            except ValueError:
                continue

        save_config(c)

    def _on_save_clicked(self, _btn):
        self._save()
        if self._on_save:
            self._on_save()
        self.close()

    def _on_key(self, _ctrl, keyval, _keycode, _state):
        from gi.repository import Gdk

        if keyval == Gdk.KEY_Escape:
            self.close()
            return True
        return False

    def _on_close(self, *_):
        global _shared_window
        _shared_window = None
        return False
