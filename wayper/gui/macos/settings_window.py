"""macOS Preferences window with General / Wallhaven / Monitors tabs."""

from __future__ import annotations

from pathlib import Path

import objc
from AppKit import (
    NSBackingStoreBuffered,
    NSBezelStyleRounded,
    NSButton,
    NSFont,
    NSMakeRect,
    NSMakeSize,
    NSOpenPanel,
    NSPopUpButton,
    NSScrollView,
    NSSecureTextField,
    NSStackView,
    NSTableColumn,
    NSTableView,
    NSTabViewController,
    NSTabViewItem,
    NSTextField,
    NSUserInterfaceLayoutOrientationVertical,
    NSView,
    NSViewController,
    NSWindow,
    NSWindowStyleMaskClosable,
    NSWindowStyleMaskMiniaturizable,
    NSWindowStyleMaskResizable,
    NSWindowStyleMaskTitled,
)
from Foundation import NSEdgeInsets, NSObject

from ...config import MonitorConfig, WayperConfig, compact_home, save_config
from .colors import C_BASE, C_SUBTEXT, C_TEXT

_LABEL_W = 140
_FIELD_W = 280
_ROW_H = 24
_PAD = 16


def _make_field(cls, value: str = "", placeholder: str = ""):
    tf = cls.alloc().initWithFrame_(NSMakeRect(0, 0, _FIELD_W, _ROW_H))
    tf.setStringValue_(value)
    tf.setPlaceholderString_(placeholder)
    tf.setTextColor_(C_TEXT)
    tf.setBackgroundColor_(C_BASE)
    tf.setFont_(NSFont.systemFontOfSize_(13))
    return tf


def _text_field(value: str = "", placeholder: str = "") -> NSTextField:
    return _make_field(NSTextField, value, placeholder)


def _secure_field(value: str = "", placeholder: str = "") -> NSSecureTextField:
    return _make_field(NSSecureTextField, value, placeholder)


def _label(text: str) -> NSTextField:
    lbl = NSTextField.labelWithString_(text)
    lbl.setTextColor_(C_SUBTEXT)
    lbl.setFont_(NSFont.systemFontOfSize_(13))
    lbl.setAlignment_(2)  # NSTextAlignmentRight
    return lbl


def _popup(items: list[str], selected: str) -> NSPopUpButton:
    btn = NSPopUpButton.alloc().initWithFrame_pullsDown_(NSMakeRect(0, 0, _FIELD_W, _ROW_H), False)
    btn.addItemsWithTitles_(items)
    if selected in items:
        btn.selectItemWithTitle_(selected)
    return btn


def _checkbox(title: str, checked: bool) -> NSButton:
    btn = NSButton.checkboxWithTitle_target_action_(title, None, None)
    btn.setState_(1 if checked else 0)
    btn.setFont_(NSFont.systemFontOfSize_(13))
    return btn


def _row(label_text: str, control: NSView) -> NSStackView:
    lbl = _label(label_text)
    lbl.setFrame_(NSMakeRect(0, 0, _LABEL_W, _ROW_H))
    row = NSStackView.stackViewWithViews_([lbl, control])
    row.setSpacing_(12)
    return row


def _make_pane(rows: list[NSStackView]) -> NSView:
    stack = NSStackView.stackViewWithViews_(rows)
    stack.setOrientation_(NSUserInterfaceLayoutOrientationVertical)
    stack.setAlignment_(6)  # NSLayoutAttributeLeading
    stack.setSpacing_(12)
    stack.setEdgeInsets_(NSEdgeInsets(_PAD, _PAD, _PAD, _PAD))
    return stack


# ── General Pane ──


class GeneralPane(NSViewController):
    def initWithConfig_(self, config: WayperConfig):
        self = objc.super(GeneralPane, self).init()
        if self is None:
            return None
        self.config = config
        return self

    def loadView(self):
        c = self.config

        self._api_key = _secure_field(c.api_key, "Wallhaven API key")
        self._proxy = _text_field(c.proxy or "", "http://127.0.0.1:7897")
        self._download_dir = _text_field(compact_home(c.download_dir))
        self._browse_btn = NSButton.buttonWithTitle_target_action_("Browse...", self, "browseDir:")
        dir_row_inner = NSStackView.stackViewWithViews_([self._download_dir, self._browse_btn])
        dir_row_inner.setSpacing_(6)

        self._quota = _text_field(str(c.quota_mb))
        self._mode = _popup(["sfw", "nsfw"], c.default_mode)
        self._interval = _text_field(str(c.interval))
        self._pool_target = _text_field(str(c.pool_target))

        rows = [
            _row("API Key", self._api_key),
            _row("Proxy", self._proxy),
            _row("Download Dir", dir_row_inner),
            _row("Quota (MB)", self._quota),
            _row("Default Mode", self._mode),
            _row("Interval (s)", self._interval),
            _row("Pool Target", self._pool_target),
        ]

        self.setView_(_make_pane(rows))

    @objc.typedSelector(b"v@:@")
    def browseDir_(self, sender):
        panel = NSOpenPanel.openPanel()
        panel.setCanChooseFiles_(False)
        panel.setCanChooseDirectories_(True)
        panel.setAllowsMultipleSelection_(False)
        if panel.runModal() == 1:
            url = panel.URLs()[0]
            self._download_dir.setStringValue_(url.path())

    def applyToConfig_(self, config):
        config.api_key = self._api_key.stringValue()
        proxy = self._proxy.stringValue().strip()
        config.proxy = proxy if proxy else None
        config.download_dir = Path(self._download_dir.stringValue().strip()).expanduser()
        try:
            config.quota_mb = int(self._quota.stringValue())
        except ValueError:
            pass
        config.default_mode = self._mode.titleOfSelectedItem()
        try:
            config.interval = int(self._interval.stringValue())
        except ValueError:
            pass
        try:
            config.pool_target = int(self._pool_target.stringValue())
        except ValueError:
            pass


# ── Wallhaven Pane ──


class WallhavenPane(NSViewController):
    def initWithConfig_(self, config: WayperConfig):
        self = objc.super(WallhavenPane, self).init()
        if self is None:
            return None
        self.config = config
        return self

    def loadView(self):
        wh = self.config.wallhaven
        cats = wh.categories.ljust(3, "0")

        self._cat_general = _checkbox("General", cats[0] == "1")
        self._cat_anime = _checkbox("Anime", cats[1] == "1")
        self._cat_people = _checkbox("People", cats[2] == "1")

        cat_stack = NSStackView.stackViewWithViews_(
            [
                self._cat_general,
                self._cat_anime,
                self._cat_people,
            ]
        )
        cat_stack.setSpacing_(12)

        sort_options = ["toplist", "random", "hot", "date_added", "relevance", "views", "favorites"]
        self._sorting = _popup(sort_options, wh.sorting)

        range_options = ["1d", "3d", "1w", "1M", "3M", "6M", "1y"]
        self._top_range = _popup(range_options, wh.top_range)

        self._ai_filter = _checkbox("Filter AI-generated art", wh.ai_art_filter == 1)

        rows = [
            _row("Categories", cat_stack),
            _row("Sorting", self._sorting),
            _row("Top Range", self._top_range),
            _row("AI Art", self._ai_filter),
        ]

        self.setView_(_make_pane(rows))

    def applyToConfig_(self, config):
        cats = (
            ("1" if self._cat_general.state() else "0")
            + ("1" if self._cat_anime.state() else "0")
            + ("1" if self._cat_people.state() else "0")
        )
        config.wallhaven.categories = cats
        config.wallhaven.sorting = self._sorting.titleOfSelectedItem()
        config.wallhaven.top_range = self._top_range.titleOfSelectedItem()
        config.wallhaven.ai_art_filter = 1 if self._ai_filter.state() else 0


# ── Monitors Pane ──


class MonitorsTableDelegate(NSObject):
    """Data source and delegate for the monitors NSTableView."""

    def initWithConfig_(self, config: WayperConfig):
        self = objc.super(MonitorsTableDelegate, self).init()
        if self is None:
            return None
        self.config = config
        return self

    def numberOfRowsInTableView_(self, tv):
        return len(self.config.monitors)

    def tableView_objectValueForTableColumn_row_(self, tv, col, row):
        m = self.config.monitors[row]
        cid = col.identifier()
        if cid == "name":
            return m.name
        if cid == "width":
            return str(m.width)
        if cid == "height":
            return str(m.height)
        if cid == "orientation":
            return m.orientation
        return ""

    def tableView_setObjectValue_forTableColumn_row_(self, tv, value, col, row):
        m = self.config.monitors[row]
        cid = col.identifier()
        if cid == "name":
            m.name = str(value)
        elif cid == "width":
            try:
                m.width = int(value)
            except ValueError:
                pass
        elif cid == "height":
            try:
                m.height = int(value)
            except ValueError:
                pass
        elif cid == "orientation":
            v = str(value).lower()
            if v in ("landscape", "portrait"):
                m.orientation = v


class MonitorsPane(NSViewController):
    def initWithConfig_(self, config: WayperConfig):
        self = objc.super(MonitorsPane, self).init()
        if self is None:
            return None
        self.config = config
        return self

    def loadView(self):
        self._delegate = MonitorsTableDelegate.alloc().initWithConfig_(self.config)

        self._tv = NSTableView.alloc().initWithFrame_(NSMakeRect(0, 0, 480, 200))
        self._tv.setDataSource_(self._delegate)
        self._tv.setDelegate_(self._delegate)
        self._tv.setBackgroundColor_(C_BASE)

        for cid, title, width in [
            ("name", "Name", 120),
            ("width", "Width", 80),
            ("height", "Height", 80),
            ("orientation", "Orientation", 120),
        ]:
            col = NSTableColumn.alloc().initWithIdentifier_(cid)
            col.headerCell().setStringValue_(title)
            col.setWidth_(width)
            col.setEditable_(True)
            self._tv.addTableColumn_(col)

        scroll = NSScrollView.alloc().initWithFrame_(NSMakeRect(0, 0, 480, 200))
        scroll.setDocumentView_(self._tv)
        scroll.setHasVerticalScroller_(True)

        add_btn = NSButton.buttonWithTitle_target_action_("+", self, "addMonitor:")
        add_btn.setBezelStyle_(NSBezelStyleRounded)
        remove_btn = NSButton.buttonWithTitle_target_action_("-", self, "removeMonitor:")
        remove_btn.setBezelStyle_(NSBezelStyleRounded)

        btn_stack = NSStackView.stackViewWithViews_([add_btn, remove_btn])
        btn_stack.setSpacing_(6)

        outer = NSStackView.stackViewWithViews_([scroll, btn_stack])
        outer.setOrientation_(NSUserInterfaceLayoutOrientationVertical)
        outer.setSpacing_(8)
        outer.setEdgeInsets_(NSEdgeInsets(_PAD, _PAD, _PAD, _PAD))

        self.setView_(outer)

    @objc.typedSelector(b"v@:@")
    def addMonitor_(self, sender):
        self.config.monitors.append(
            MonitorConfig(
                name="DP-1",
                width=1920,
                height=1080,
                orientation="landscape",
            )
        )
        self._tv.reloadData()

    @objc.typedSelector(b"v@:@")
    def removeMonitor_(self, sender):
        row = self._tv.selectedRow()
        if 0 <= row < len(self.config.monitors):
            del self.config.monitors[row]
            self._tv.reloadData()


# ── Settings Window Controller ──


_shared_controller = None


class SettingsWindowController(NSObject):
    """Manages the Preferences window (singleton, recreated on reopen)."""

    @classmethod
    def sharedWithConfig_onSave_(cls, config: WayperConfig, on_save=None):
        global _shared_controller
        if _shared_controller is not None:
            _shared_controller._on_save = on_save
            _shared_controller.window.makeKeyAndOrderFront_(None)
            return _shared_controller
        ctrl = cls.alloc().initWithConfig_onSave_(config, on_save)
        _shared_controller = ctrl
        return ctrl

    def initWithConfig_onSave_(self, config: WayperConfig, on_save=None):
        self = objc.super(SettingsWindowController, self).init()
        if self is None:
            return None
        self.config = config
        self._on_save = on_save
        self._build()
        return self

    def _build(self):
        style = (
            NSWindowStyleMaskTitled
            | NSWindowStyleMaskClosable
            | NSWindowStyleMaskMiniaturizable
            | NSWindowStyleMaskResizable
        )
        self.window = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            NSMakeRect(200, 200, 560, 400),
            style,
            NSBackingStoreBuffered,
            False,
        )
        self.window.setTitle_("Wayper Settings")
        self.window.setBackgroundColor_(C_BASE)
        self.window.setMinSize_(NSMakeSize(480, 320))
        self.window.setDelegate_(self)

        self._general = GeneralPane.alloc().initWithConfig_(self.config)
        self._wallhaven = WallhavenPane.alloc().initWithConfig_(self.config)
        self._monitors = MonitorsPane.alloc().initWithConfig_(self.config)

        tvc = NSTabViewController.alloc().init()
        tvc.setTabStyle_(2)  # NSTabViewControllerTabStyleToolbar

        for pane, label in [
            (self._general, "General"),
            (self._wallhaven, "Wallhaven"),
            (self._monitors, "Monitors"),
        ]:
            item = NSTabViewItem.alloc().initWithIdentifier_(label)
            item.setLabel_(label)
            item.setViewController_(pane)
            tvc.addTabViewItem_(item)

        self.window.setContentViewController_(tvc)
        if hasattr(self.window, "setToolbarStyle_"):
            self.window.setToolbarStyle_(3)  # NSWindowToolbarStylePreference

        # Save button pinned to bottom-right
        save_btn = NSButton.buttonWithTitle_target_action_("Save", self, "saveSettings:")
        save_btn.setBezelStyle_(NSBezelStyleRounded)
        save_btn.setKeyEquivalent_("\r")

        content = self.window.contentView()
        save_btn.setTranslatesAutoresizingMaskIntoConstraints_(False)
        content.addSubview_(save_btn)
        content.addConstraints_(
            [
                save_btn.trailingAnchor().constraintEqualToAnchor_constant_(
                    content.trailingAnchor(),
                    -_PAD,
                ),
                save_btn.bottomAnchor().constraintEqualToAnchor_constant_(
                    content.bottomAnchor(),
                    -_PAD,
                ),
            ]
        )

    @objc.typedSelector(b"v@:@")
    def saveSettings_(self, sender):
        self._general.applyToConfig_(self.config)
        self._wallhaven.applyToConfig_(self.config)
        save_config(self.config)
        if self._on_save:
            self._on_save()
        self.window.close()

    def windowWillClose_(self, notification):
        global _shared_controller
        _shared_controller = None

    def showWindow(self):
        self.window.makeKeyAndOrderFront_(None)
