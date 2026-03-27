"""Embeddable browse panel: thumbnail grid + preview + filter bar + metadata + empty state."""

from __future__ import annotations

import webbrowser
from pathlib import Path

import objc
from AppKit import (
    NSBezelStyleRounded,
    NSButton,
    NSCenterTextAlignment,
    NSCollectionView,
    NSCollectionViewFlowLayout,
    NSCollectionViewItem,
    NSCompositingOperationSourceOver,
    NSFont,
    NSImage,
    NSImageScaleProportionallyUpOrDown,
    NSImageView,
    NSLineBreakByTruncatingTail,
    NSLineBreakByWordWrapping,
    NSMakeRect,
    NSMakeSize,
    NSOnState,
    NSPopUpButton,
    NSScrollView,
    NSSearchField,
    NSStackView,
    NSStackViewGravityCenter,
    NSStackViewGravityLeading,
    NSStackViewGravityTrailing,
    NSTextField,
    NSTimer,
    NSUserInterfaceLayoutOrientationHorizontal,
    NSUserInterfaceLayoutOrientationVertical,
    NSView,
)
from Foundation import NSEdgeInsets, NSIndexPath, NSObject

from ...backend import find_monitor, get_focused_monitor, set_wallpaper
from ...browse._common import (
    format_size,
    get_blocklist_only,
    get_images,
    perform_context_action,
    perform_delete,
    perform_favorite,
    sort_images,
    wallhaven_id,
    wallhaven_url,
)
from ...history import push as push_history
from ...pool import extract_tag_names, load_metadata
from ...state import read_mode, write_mode
from ._style_helpers import fade_in
from .colors import (
    C_BASE,
    C_BLUE,
    C_GREEN,
    C_MANTLE_CG,
    C_OVERLAY,
    C_PEACH,
    C_RED,
    C_SUBTEXT,
    C_SURFACE_CG,
    C_TEXT,
)
from .daemon_control import _find_wayper_cli

THUMB_SIZE = 200
ITEM_IDENTIFIER = "gui_thumb"
CATEGORIES = ("pool", "favorites", "disliked")
LABELS = ("Pool", "Favorites", "Disliked")
ACTION_LABELS = {"favorites": "Remove", "pool": "Reject", "disliked": "Restore"}

EMPTY_MESSAGES = {
    "pool": ("Pool is empty", "The daemon will download wallpapers automatically"),
    "favorites": ("No favorites yet", "Press F to favorite a wallpaper"),
    "disliked": ("Nothing disliked", "Press X to reject wallpapers"),
}


class ThumbnailItem(NSCollectionViewItem):
    def loadView(self):
        container = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, THUMB_SIZE, THUMB_SIZE + 24))
        container.setWantsLayer_(True)
        container.layer().setCornerRadius_(8)

        iv = NSImageView.alloc().initWithFrame_(NSMakeRect(0, 24, THUMB_SIZE, THUMB_SIZE))
        iv.setImageScaling_(NSImageScaleProportionallyUpOrDown)
        iv.setWantsLayer_(True)
        iv.layer().setCornerRadius_(6)
        iv.layer().setMasksToBounds_(True)
        container.addSubview_(iv)

        # Metadata overlay for blocklist items (centered in image area)
        meta_stack = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 24, THUMB_SIZE, THUMB_SIZE))
        meta_stack.setOrientation_(NSUserInterfaceLayoutOrientationVertical)
        meta_stack.setSpacing_(4)
        meta_stack.setAlignment_(9)  # NSLayoutAttributeCenterX
        meta_stack.setTranslatesAutoresizingMaskIntoConstraints_(False)
        meta_stack.setHidden_(True)
        container.addSubview_(meta_stack)
        container.addConstraints_(
            [
                meta_stack.centerXAnchor().constraintEqualToAnchor_constant_(
                    container.centerXAnchor(), 0
                ),
                meta_stack.centerYAnchor().constraintEqualToAnchor_constant_(
                    container.centerYAnchor(), 12
                ),
            ]
        )

        label = NSTextField.labelWithString_("")
        label.setFrame_(NSMakeRect(0, 2, THUMB_SIZE, 18))
        label.setAlignment_(NSCenterTextAlignment)
        label.setFont_(NSFont.systemFontOfSize_(11))
        label.setTextColor_(C_TEXT)
        label.setLineBreakMode_(NSLineBreakByTruncatingTail)
        container.addSubview_(label)

        self.setView_(container)
        self._imageView = iv
        self._label = label
        self._meta_stack = meta_stack

    def setSelected_(self, selected):
        objc.super(ThumbnailItem, self).setSelected_(selected)
        layer = self.view().layer()
        if selected:
            layer.setBorderWidth_(2)
            layer.setBorderColor_(C_BLUE.CGColor())
        else:
            layer.setBorderWidth_(0)

    def configureWithImage_name_(self, image, name):
        self._imageView.setImage_(image)
        self._label.setStringValue_(name)
        self._meta_stack.setHidden_(True)

    def configureBlocklist_name_meta_(self, wh_id, name, meta):
        """Configure as a blocklist placeholder with metadata summary."""
        self._imageView.setImage_(None)
        self._imageView.layer().setBackgroundColor_(C_SURFACE_CG)
        self._label.setStringValue_(name)

        # Clear old metadata labels
        for sub in list(self._meta_stack.views()):
            self._meta_stack.removeView_(sub)

        id_lbl = NSTextField.labelWithString_(f"#{wh_id}")
        id_lbl.setTextColor_(C_BLUE)
        id_lbl.setFont_(NSFont.boldSystemFontOfSize_(12))
        id_lbl.setAlignment_(NSCenterTextAlignment)
        self._meta_stack.addView_inGravity_(id_lbl, NSStackViewGravityCenter)

        if meta:
            if cat := meta.get("category"):
                cat_lbl = NSTextField.labelWithString_(cat)
                cat_lbl.setTextColor_(C_SUBTEXT)
                cat_lbl.setFont_(NSFont.systemFontOfSize_(11))
                cat_lbl.setAlignment_(NSCenterTextAlignment)
                self._meta_stack.addView_inGravity_(cat_lbl, NSStackViewGravityCenter)

            tags = extract_tag_names(meta.get("tags", []))[:3]
            if tags:
                tag_lbl = NSTextField.labelWithString_(", ".join(tags))
                tag_lbl.setTextColor_(C_SUBTEXT)
                tag_lbl.setFont_(NSFont.systemFontOfSize_(10))
                tag_lbl.setAlignment_(NSCenterTextAlignment)
                tag_lbl.setLineBreakMode_(NSLineBreakByTruncatingTail)
                tag_lbl.setPreferredMaxLayoutWidth_(THUMB_SIZE - 16)
                self._meta_stack.addView_inGravity_(tag_lbl, NSStackViewGravityCenter)

        self._meta_stack.setHidden_(False)


class BrowsePanelController(NSObject):
    """Browse panel with filter bar, thumbnail grid, preview, metadata, and empty state."""

    def initWithConfig_category_(self, config, category):
        self = objc.super(BrowsePanelController, self).init()
        if self is None:
            return None
        self.config = config
        self.category = category
        self.mode = read_mode(config)
        self.images: list[Path] = []
        self._filtered_images: list[Path] = []
        self._blocklist_only: list[str] = []
        self.selected_index = -1
        self._thumb_cache: dict[str, NSImage] = {}
        self._metadata: dict = load_metadata(config)
        # Filter state
        self._filter_text: str = ""
        self._filter_orientation: str | None = None
        self._sort_key: str = "newest"
        self._debounce_timer: NSTimer | None = None
        self.view = self._build_ui()
        self._reload_images()
        return self

    def setCategory_(self, category: str):
        self.category = category
        self._reload_images()

    def setMode_(self, mode: str):
        self.mode = mode
        write_mode(self.config, self.mode)
        self._reload_images()

    def shutdown(self):
        if self._debounce_timer:
            self._debounce_timer.invalidate()
            self._debounce_timer = None

    def _build_ui(self) -> NSView:
        root = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, 1100, 650))
        root.setWantsLayer_(True)

        # ── Left column: filter bar + collection view ──
        left_col = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, 460, 650))

        # Filter bar
        filter_bar = self._build_filter_bar()
        filter_bar.setTranslatesAutoresizingMaskIntoConstraints_(False)
        left_col.addSubview_(filter_bar)

        # Collection view
        layout = NSCollectionViewFlowLayout.alloc().init()
        layout.setItemSize_(NSMakeSize(THUMB_SIZE, THUMB_SIZE + 24))
        layout.setMinimumInteritemSpacing_(8)
        layout.setMinimumLineSpacing_(8)
        layout.setSectionInset_((12, 12, 12, 12))

        self._cv = NSCollectionView.alloc().initWithFrame_(NSMakeRect(0, 0, 460, 560))
        self._cv.setCollectionViewLayout_(layout)
        self._cv.setDataSource_(self)
        self._cv.setDelegate_(self)
        self._cv.setBackgroundColors_([C_BASE])
        self._cv.setSelectable_(True)
        self._cv.registerClass_forItemWithIdentifier_(ThumbnailItem, ITEM_IDENTIFIER)

        self._scroll = NSScrollView.alloc().initWithFrame_(NSMakeRect(0, 0, 460, 560))
        self._scroll.setDocumentView_(self._cv)
        self._scroll.setHasVerticalScroller_(True)
        self._scroll.setDrawsBackground_(False)
        self._scroll.setTranslatesAutoresizingMaskIntoConstraints_(False)
        left_col.addSubview_(self._scroll)

        # Empty state
        self._empty_view = self._build_empty_state()
        self._empty_view.setTranslatesAutoresizingMaskIntoConstraints_(False)
        self._empty_view.setHidden_(True)
        left_col.addSubview_(self._empty_view)

        left_col.addConstraints_(
            [
                filter_bar.topAnchor().constraintEqualToAnchor_(left_col.topAnchor()),
                filter_bar.leadingAnchor().constraintEqualToAnchor_(left_col.leadingAnchor()),
                filter_bar.trailingAnchor().constraintEqualToAnchor_(left_col.trailingAnchor()),
                filter_bar.heightAnchor().constraintEqualToConstant_(32),
                self._scroll.topAnchor().constraintEqualToAnchor_constant_(
                    filter_bar.bottomAnchor(), 4
                ),
                self._scroll.leadingAnchor().constraintEqualToAnchor_(left_col.leadingAnchor()),
                self._scroll.trailingAnchor().constraintEqualToAnchor_(left_col.trailingAnchor()),
                self._scroll.bottomAnchor().constraintEqualToAnchor_(left_col.bottomAnchor()),
                self._empty_view.topAnchor().constraintEqualToAnchor_constant_(
                    filter_bar.bottomAnchor(), 4
                ),
                self._empty_view.leadingAnchor().constraintEqualToAnchor_(left_col.leadingAnchor()),
                self._empty_view.trailingAnchor().constraintEqualToAnchor_(
                    left_col.trailingAnchor()
                ),
                self._empty_view.bottomAnchor().constraintEqualToAnchor_(left_col.bottomAnchor()),
            ]
        )

        # ── Right panel (preview + metadata + actions) ──
        right = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 600, 600))
        right.setOrientation_(NSUserInterfaceLayoutOrientationVertical)
        right.setSpacing_(8)

        self._preview = NSImageView.alloc().initWithFrame_(NSMakeRect(0, 0, 500, 400))
        self._preview.setImageScaling_(NSImageScaleProportionallyUpOrDown)
        self._preview.setWantsLayer_(True)
        self._preview.layer().setCornerRadius_(12)
        self._preview.layer().setBackgroundColor_(C_MANTLE_CG)
        self._preview.setContentHuggingPriority_forOrientation_(1, 1)
        self._preview.setContentHuggingPriority_forOrientation_(1, 0)
        self._preview.setContentCompressionResistancePriority_forOrientation_(1, 1)
        self._preview.setContentCompressionResistancePriority_forOrientation_(1, 0)
        self._preview.setTranslatesAutoresizingMaskIntoConstraints_(False)

        self._placeholder = NSTextField.labelWithString_("Select an image to preview")
        self._placeholder.setTextColor_(C_OVERLAY)
        self._placeholder.setFont_(NSFont.systemFontOfSize_(13))
        self._placeholder.setAlignment_(NSCenterTextAlignment)
        self._placeholder.setTranslatesAutoresizingMaskIntoConstraints_(False)
        self._preview.addSubview_(self._placeholder)

        right.addView_inGravity_(self._preview, NSStackViewGravityLeading)

        # Metadata section
        self._meta_box = self._build_metadata_section()
        right.addView_inGravity_(self._meta_box, NSStackViewGravityLeading)

        # Monitor selector (only if multiple monitors)
        if len(self.config.monitors) > 1:
            mon_bar = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 400, 28))
            mon_bar.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
            mon_bar.setSpacing_(8)
            mon_bar.setContentHuggingPriority_forOrientation_(999, 1)

            mon_label = NSTextField.labelWithString_("Monitor:")
            mon_label.setTextColor_(C_SUBTEXT)
            mon_label.setFont_(NSFont.systemFontOfSize_(11))
            mon_bar.addView_inGravity_(mon_label, NSStackViewGravityLeading)

            self._monitor_combo = NSPopUpButton.alloc().initWithFrame_pullsDown_(
                NSMakeRect(0, 0, 150, 24), False
            )
            self._monitor_combo.addItemWithTitle_("Focused")
            for m in self.config.monitors:
                self._monitor_combo.addItemWithTitle_(m.name)
            mon_bar.addView_inGravity_(self._monitor_combo, NSStackViewGravityLeading)

            right.addView_inGravity_(mon_bar, NSStackViewGravityLeading)
        else:
            self._monitor_combo = None

        # Action buttons
        btn_bar = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 400, 32))
        btn_bar.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        btn_bar.setSpacing_(8)
        btn_bar.setContentHuggingPriority_forOrientation_(999, 1)

        self._btn_set = self._make_btn("Set [Enter]", "doSet:")
        self._btn_set.setBezelColor_(C_BLUE)
        self._btn_open = self._make_btn("Open [O]", "doOpen:")
        self._btn_open.setContentTintColor_(C_TEXT)
        self._btn_fav = self._make_btn("Fav [F]", "doFav:")
        self._btn_fav.setContentTintColor_(C_GREEN)
        self._btn_action = self._make_btn("Remove [X]", "doAction:")
        self._btn_action.setContentTintColor_(C_PEACH)
        self._btn_delete = self._make_btn("Delete [D]", "doDelete:")
        self._btn_delete.setContentTintColor_(C_RED)
        for b in (self._btn_set, self._btn_open, self._btn_fav, self._btn_action, self._btn_delete):
            btn_bar.addView_inGravity_(b, NSStackViewGravityCenter)

        right.addView_inGravity_(btn_bar, NSStackViewGravityTrailing)

        self._status = NSTextField.labelWithString_("")
        self._status.setTextColor_(C_OVERLAY)
        self._status.setFont_(NSFont.systemFontOfSize_(11))
        self._status.setContentHuggingPriority_forOrientation_(999, 1)
        right.addView_inGravity_(self._status, NSStackViewGravityTrailing)

        # ── Layout ──
        root.addSubview_(left_col)
        root.addSubview_(right)

        left_col.setTranslatesAutoresizingMaskIntoConstraints_(False)
        right.setTranslatesAutoresizingMaskIntoConstraints_(False)

        root.addConstraints_(
            [
                left_col.topAnchor().constraintEqualToAnchor_constant_(root.topAnchor(), 8),
                left_col.leadingAnchor().constraintEqualToAnchor_constant_(root.leadingAnchor(), 8),
                left_col.widthAnchor().constraintEqualToAnchor_multiplier_(root.widthAnchor(), 0.4),
                left_col.widthAnchor().constraintGreaterThanOrEqualToConstant_(300),
                left_col.bottomAnchor().constraintEqualToAnchor_constant_(root.bottomAnchor(), -8),
                right.topAnchor().constraintEqualToAnchor_constant_(root.topAnchor(), 8),
                right.leadingAnchor().constraintEqualToAnchor_constant_(
                    left_col.trailingAnchor(), 12
                ),
                right.trailingAnchor().constraintEqualToAnchor_constant_(
                    root.trailingAnchor(), -12
                ),
                right.bottomAnchor().constraintEqualToAnchor_constant_(root.bottomAnchor(), -8),
                self._preview.leadingAnchor().constraintEqualToAnchor_(right.leadingAnchor()),
                self._preview.trailingAnchor().constraintEqualToAnchor_(right.trailingAnchor()),
                self._placeholder.centerXAnchor().constraintEqualToAnchor_(
                    self._preview.centerXAnchor()
                ),
                self._placeholder.centerYAnchor().constraintEqualToAnchor_(
                    self._preview.centerYAnchor()
                ),
            ]
        )

        self._update_buttons()
        return root

    def _build_filter_bar(self) -> NSView:
        bar = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 460, 32))
        bar.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        bar.setSpacing_(6)
        bar.setWantsLayer_(True)
        bar.layer().setBackgroundColor_(C_MANTLE_CG)
        bar.layer().setCornerRadius_(8)

        # Search field
        self._search_field = NSSearchField.alloc().initWithFrame_(NSMakeRect(0, 0, 150, 24))
        self._search_field.setPlaceholderString_("Filter... [/]")
        self._search_field.setFont_(NSFont.systemFontOfSize_(12))
        self._search_field.setTarget_(self)
        self._search_field.setAction_("onSearchAction:")
        bar.addView_inGravity_(self._search_field, NSStackViewGravityLeading)

        # Orientation toggles
        self._land_btn = NSButton.buttonWithTitle_target_action_("Landscape", self, "toggleLand:")
        self._land_btn.setBezelStyle_(NSBezelStyleRounded)
        self._land_btn.setFont_(NSFont.systemFontOfSize_(10))
        self._land_btn.setButtonType_(1)  # NSButtonTypePushOnPushOff
        bar.addView_inGravity_(self._land_btn, NSStackViewGravityLeading)

        self._port_btn = NSButton.buttonWithTitle_target_action_("Portrait", self, "togglePort:")
        self._port_btn.setBezelStyle_(NSBezelStyleRounded)
        self._port_btn.setFont_(NSFont.systemFontOfSize_(10))
        self._port_btn.setButtonType_(1)  # NSButtonTypePushOnPushOff
        bar.addView_inGravity_(self._port_btn, NSStackViewGravityLeading)

        # Sort dropdown
        self._sort_popup = NSPopUpButton.alloc().initWithFrame_pullsDown_(
            NSMakeRect(0, 0, 90, 24), False
        )
        for label in ("Newest", "Oldest", "Largest", "Smallest", "Name"):
            self._sort_popup.addItemWithTitle_(label)
        self._sort_popup.setFont_(NSFont.systemFontOfSize_(11))
        self._sort_popup.setTarget_(self)
        self._sort_popup.setAction_("onSortChanged:")
        bar.addView_inGravity_(self._sort_popup, NSStackViewGravityTrailing)

        return bar

    def _build_metadata_section(self) -> NSStackView:
        meta = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 500, 80))
        meta.setOrientation_(NSUserInterfaceLayoutOrientationVertical)
        meta.setSpacing_(2)
        meta.setAlignment_(6)  # NSLayoutAttributeLeading
        meta.setContentHuggingPriority_forOrientation_(999, 1)
        meta.setWantsLayer_(True)
        meta.layer().setBackgroundColor_(C_MANTLE_CG)
        meta.layer().setCornerRadius_(8)
        meta.setEdgeInsets_(NSEdgeInsets(8, 12, 8, 12))

        # Row 1: resolution | file size | wallhaven ID + color dots
        row1 = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 500, 16))
        row1.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        row1.setSpacing_(8)

        self._meta_info = NSTextField.labelWithString_("")
        self._meta_info.setTextColor_(C_SUBTEXT)
        self._meta_info.setFont_(NSFont.systemFontOfSize_(11))
        row1.addView_inGravity_(self._meta_info, NSStackViewGravityLeading)

        self._color_dots_box = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 80, 14))
        self._color_dots_box.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        self._color_dots_box.setSpacing_(3)
        row1.addView_inGravity_(self._color_dots_box, NSStackViewGravityTrailing)

        meta.addView_inGravity_(row1, NSStackViewGravityLeading)

        # Row 2: category · views · favorites
        self._meta_stats = NSTextField.labelWithString_("")
        self._meta_stats.setTextColor_(C_SUBTEXT)
        self._meta_stats.setFont_(NSFont.systemFontOfSize_(11))
        meta.addView_inGravity_(self._meta_stats, NSStackViewGravityLeading)

        # Row 3: tags
        self._meta_tags = NSTextField.labelWithString_("")
        self._meta_tags.setTextColor_(C_SUBTEXT)
        self._meta_tags.setFont_(NSFont.systemFontOfSize_(10))
        self._meta_tags.setLineBreakMode_(NSLineBreakByWordWrapping)
        self._meta_tags.setPreferredMaxLayoutWidth_(500)
        meta.addView_inGravity_(self._meta_tags, NSStackViewGravityLeading)

        meta.setHidden_(True)
        return meta

    def _build_empty_state(self) -> NSView:
        container = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, 460, 200))
        container.setWantsLayer_(True)

        stack = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 300, 120))
        stack.setOrientation_(NSUserInterfaceLayoutOrientationVertical)
        stack.setSpacing_(8)
        stack.setAlignment_(9)  # NSLayoutAttributeCenterX
        stack.setTranslatesAutoresizingMaskIntoConstraints_(False)

        self._empty_title = NSTextField.labelWithString_("")
        self._empty_title.setTextColor_(C_TEXT)
        self._empty_title.setFont_(NSFont.boldSystemFontOfSize_(16))
        self._empty_title.setAlignment_(NSCenterTextAlignment)
        stack.addView_inGravity_(self._empty_title, NSStackViewGravityCenter)

        self._empty_desc = NSTextField.labelWithString_("")
        self._empty_desc.setTextColor_(C_SUBTEXT)
        self._empty_desc.setFont_(NSFont.systemFontOfSize_(13))
        self._empty_desc.setAlignment_(NSCenterTextAlignment)
        stack.addView_inGravity_(self._empty_desc, NSStackViewGravityCenter)

        self._empty_daemon_btn = NSButton.buttonWithTitle_target_action_(
            "Start Daemon", self, "startDaemon:"
        )
        self._empty_daemon_btn.setBezelStyle_(NSBezelStyleRounded)
        self._empty_daemon_btn.setBezelColor_(C_GREEN)
        stack.addView_inGravity_(self._empty_daemon_btn, NSStackViewGravityCenter)

        container.addSubview_(stack)
        container.addConstraints_(
            [
                stack.centerXAnchor().constraintEqualToAnchor_(container.centerXAnchor()),
                stack.centerYAnchor().constraintEqualToAnchor_(container.centerYAnchor()),
            ]
        )

        return container

    def _make_btn(self, title, action):
        btn = NSButton.buttonWithTitle_target_action_(title, self, action)
        btn.setBezelStyle_(NSBezelStyleRounded)
        return btn

    @staticmethod
    def _make_color_dot(hex_color: str) -> NSView:
        """Create a 12x12 colored circle view from a hex color string."""
        from Quartz import CGColorCreateGenericRGB

        hex_color = hex_color.lstrip("#")
        r = int(hex_color[0:2], 16) / 255
        g = int(hex_color[2:4], 16) / 255
        b = int(hex_color[4:6], 16) / 255

        dot = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, 12, 12))
        dot.setWantsLayer_(True)
        dot.layer().setBackgroundColor_(CGColorCreateGenericRGB(r, g, b, 1.0))
        dot.layer().setCornerRadius_(6)
        dot.layer().setBorderWidth_(1)
        dot.layer().setBorderColor_(CGColorCreateGenericRGB(0.8, 0.84, 0.96, 0.3))
        dot.widthAnchor().constraintEqualToConstant_(12).setActive_(True)
        dot.heightAnchor().constraintEqualToConstant_(12).setActive_(True)
        return dot

    # ── Filter bar actions ──

    @objc.typedSelector(b"v@:@")
    def onSearchAction_(self, sender):
        self._filter_text = self._search_field.stringValue().strip().lower()
        self._apply_filters()

    def controlTextDidChange_(self, notification):
        """Debounced search as user types."""
        if self._debounce_timer:
            self._debounce_timer.invalidate()
        self._debounce_timer = (
            NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
                0.15, self, "debounceFilter:", None, False
            )
        )

    @objc.typedSelector(b"v@:@")
    def debounceFilter_(self, timer):
        self._debounce_timer = None
        self._filter_text = self._search_field.stringValue().strip().lower()
        self._apply_filters()

    @objc.typedSelector(b"v@:@")
    def toggleLand_(self, sender):
        if sender.state() == NSOnState:
            self._filter_orientation = "landscape"
            self._port_btn.setState_(0)
            self._port_btn.setContentTintColor_(C_SUBTEXT)
            sender.setContentTintColor_(C_BLUE)
        else:
            self._filter_orientation = None
            sender.setContentTintColor_(C_SUBTEXT)
        self._apply_filters()

    @objc.typedSelector(b"v@:@")
    def togglePort_(self, sender):
        if sender.state() == NSOnState:
            self._filter_orientation = "portrait"
            self._land_btn.setState_(0)
            self._land_btn.setContentTintColor_(C_SUBTEXT)
            sender.setContentTintColor_(C_BLUE)
        else:
            self._filter_orientation = None
            sender.setContentTintColor_(C_SUBTEXT)
        self._apply_filters()

    @objc.typedSelector(b"v@:@")
    def onSortChanged_(self, sender):
        keys = ["newest", "oldest", "largest", "smallest", "name"]
        idx = sender.indexOfSelectedItem()
        self._sort_key = keys[idx] if 0 <= idx < len(keys) else "newest"
        self._apply_filters()

    def _apply_filters(self):
        filtered = list(self.images)

        if self._filter_text:
            filtered = [p for p in filtered if self._filter_text in p.name.lower()]

        if self._filter_orientation:
            filtered = [p for p in filtered if self._filter_orientation in str(p.parent)]

        filtered = sort_images(filtered, self._sort_key)
        self._filtered_images = filtered
        self.selected_index = -1
        self._update_preview()
        self._cv.reloadData()
        self._update_status()
        self._update_buttons()
        self._update_empty_state()

    # ── Empty state ──

    @objc.typedSelector(b"v@:@")
    def startDaemon_(self, sender):
        import subprocess

        wayper_bin = _find_wayper_cli()
        subprocess.Popen(
            [wayper_bin, "daemon"],
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def _update_empty_state(self):
        total = len(self._filtered_images) + len(self._blocklist_only)
        is_empty = total == 0

        self._scroll.setHidden_(is_empty)
        self._empty_view.setHidden_(not is_empty)

        if is_empty:
            title, desc = EMPTY_MESSAGES.get(self.category, ("Empty", ""))
            self._empty_title.setStringValue_(title)
            self._empty_desc.setStringValue_(desc)
            self._empty_daemon_btn.setHidden_(self.category != "pool")

    # ── Data loading ──

    def _reload_images(self):
        self.images = get_images(self.category, self.mode, self.config)
        self._blocklist_only = (
            get_blocklist_only(self.images, self.config) if self.category == "disliked" else []
        )
        self._thumb_cache.clear()
        self._metadata = load_metadata(self.config)
        self._apply_filters()

    def _remove_at(self, idx: int):
        """Remove item at idx without full reload — keeps thumb cache intact."""
        is_file = idx < len(self._filtered_images)
        if is_file:
            path = self._filtered_images[idx]
            self._thumb_cache.pop(str(path), None)
            self._filtered_images.remove(path)
            if path in self.images:
                self.images.remove(path)
        else:
            bl_idx = idx - len(self._filtered_images)
            if bl_idx < len(self._blocklist_only):
                del self._blocklist_only[bl_idx]

        ip_set = set()
        ip_set.add(NSIndexPath.indexPathForItem_inSection_(idx, 0))
        self._cv.deleteItemsAtIndexPaths_(ip_set)

        # Select next item
        total = len(self._filtered_images) + len(self._blocklist_only)
        if total == 0:
            self.selected_index = -1
            self._update_preview()
        else:
            self.selected_index = min(idx, total - 1)
            ip = NSIndexPath.indexPathForItem_inSection_(self.selected_index, 0)
            self._cv.selectItemsAtIndexPaths_(set([ip]), scrollPosition=0)
            self._update_preview()
        self._update_status()
        self._update_buttons()
        self._update_empty_state()

    # ── NSCollectionViewDataSource ──

    def collectionView_numberOfItemsInSection_(self, cv, section):
        return len(self._filtered_images) + len(self._blocklist_only)

    def collectionView_itemForRepresentedObjectAtIndexPath_(self, cv, indexPath):
        item = cv.makeItemWithIdentifier_forIndexPath_(ITEM_IDENTIFIER, indexPath)
        idx = indexPath.item()

        if idx < len(self._filtered_images):
            img_path = self._filtered_images[idx]
            name = img_path.stem[-12:]
            thumb = self._get_thumb(str(img_path))
            item.configureWithImage_name_(thumb, name)
        else:
            bl_idx = idx - len(self._filtered_images)
            bl_name = self._blocklist_only[bl_idx]
            wh_id = wallhaven_id(bl_name)
            meta = self._metadata.get(bl_name)
            item.configureBlocklist_name_meta_(wh_id, bl_name[-12:], meta)

        return item

    def _get_thumb(self, path_str: str) -> NSImage | None:
        cached = self._thumb_cache.get(path_str)
        if cached is not None:
            return cached
        img = NSImage.alloc().initWithContentsOfFile_(path_str)
        if img is None:
            return None
        orig_size = img.size()
        side = min(orig_size.width, orig_size.height)
        thumb = NSImage.alloc().initWithSize_(NSMakeSize(THUMB_SIZE, THUMB_SIZE))
        thumb.lockFocus()
        img.drawInRect_fromRect_operation_fraction_(
            NSMakeRect(0, 0, THUMB_SIZE, THUMB_SIZE),
            NSMakeRect(
                (orig_size.width - side) / 2,
                (orig_size.height - side) / 2,
                side,
                side,
            ),
            NSCompositingOperationSourceOver,
            1.0,
        )
        thumb.unlockFocus()
        self._thumb_cache[path_str] = thumb
        return thumb

    # ── NSCollectionViewDelegate ──

    def collectionView_didSelectItemsAtIndexPaths_(self, cv, indexPaths):
        for ip in indexPaths:
            self.selected_index = ip.item()
        self._update_preview()
        self._update_buttons()

    def collectionView_didDeselectItemsAtIndexPaths_(self, cv, indexPaths):
        if not cv.selectionIndexPaths():
            self.selected_index = -1
            self._update_preview()
            self._update_buttons()

    # ── Preview + Metadata ──

    def _update_preview(self):
        path = self._selected_path()
        if path and path.exists():
            img = NSImage.alloc().initByReferencingFile_(str(path))
            self._preview.setImage_(img)
            fade_in(self._preview, 0.25)
            self._placeholder.setHidden_(True)
            self._update_metadata(path, img)
        else:
            self._preview.setImage_(None)
            self._placeholder.setHidden_(False)
            self._meta_box.setHidden_(True)

    def _update_metadata(self, path: Path, img: NSImage):
        # Basic info
        try:
            size_bytes = path.stat().st_size
        except OSError:
            size_bytes = 0
        img_size = img.size()
        w, h = int(img_size.width), int(img_size.height)
        wh_id = wallhaven_id(path.name)

        self._meta_info.setStringValue_(f"{w}\u00d7{h}  |  {format_size(size_bytes)}  |  {wh_id}")

        # Wallhaven metadata from cache
        meta = self._metadata.get(path.name)

        # Color dots
        for sub in list(self._color_dots_box.views()):
            self._color_dots_box.removeView_(sub)
        if meta:
            for hex_color in meta.get("colors", [])[:5]:
                dot = self._make_color_dot(hex_color)
                self._color_dots_box.addView_inGravity_(dot, NSStackViewGravityLeading)

        if meta:
            cat = meta.get("category", "")
            views = meta.get("views", 0)
            favs = meta.get("favorites", 0)
            self._meta_stats.setStringValue_(
                f"{cat}  \u00b7  Views: {views:,}  \u00b7  Favs: {favs:,}"
            )
            tags = extract_tag_names(meta.get("tags", []))[:8]
            self._meta_tags.setStringValue_(", ".join(tags) if tags else "")
            self._meta_tags.setHidden_(not tags)
        else:
            self._meta_stats.setStringValue_("")
            self._meta_tags.setStringValue_("")
            self._meta_tags.setHidden_(True)

        self._meta_box.setHidden_(False)

    def _selected_path(self) -> Path | None:
        if 0 <= self.selected_index < len(self._filtered_images):
            return self._filtered_images[self.selected_index]
        return None

    def _selected_blocklist_name(self) -> str | None:
        bl_start = len(self._filtered_images)
        if self.selected_index >= bl_start:
            bl_idx = self.selected_index - bl_start
            if bl_idx < len(self._blocklist_only):
                return self._blocklist_only[bl_idx]
        return None

    # ── Monitor helper ──

    def _get_target_monitor(self) -> str | None:
        if self._monitor_combo and self._monitor_combo.indexOfSelectedItem() > 0:
            return self._monitor_combo.titleOfSelectedItem()
        return get_focused_monitor()

    # ── Actions ──

    @objc.typedSelector(b"v@:@")
    def doSet_(self, sender):
        path = self._selected_path()
        if not path or not path.exists():
            return
        monitor = self._get_target_monitor()
        if not monitor:
            return
        mon_cfg = find_monitor(self.config, monitor)
        if mon_cfg:
            set_wallpaper(monitor, path, self.config.transition)
            push_history(self.config, monitor, path)

    @objc.typedSelector(b"v@:@")
    def doOpen_(self, sender):
        path = self._selected_path()
        name = self._selected_blocklist_name()
        if path:
            webbrowser.open(wallhaven_url(path))
        elif name:
            webbrowser.open(wallhaven_url(Path(name)))

    @objc.typedSelector(b"v@:@")
    def doFav_(self, sender):
        idx = self.selected_index
        path = self._selected_path()
        if not path or not path.exists():
            return
        perform_favorite(self.config, path, self.mode)
        self._remove_at(idx)

    @objc.typedSelector(b"v@:@")
    def doAction_(self, sender):
        idx = self.selected_index
        perform_context_action(
            self.config,
            self._selected_path(),
            self.category,
            self.mode,
            self._selected_blocklist_name(),
        )
        self._remove_at(idx)

    @objc.typedSelector(b"v@:@")
    def doDelete_(self, sender):
        idx = self.selected_index
        perform_delete(self.config, self._selected_path(), self._selected_blocklist_name())
        self._remove_at(idx)

    # ── Keyboard ──

    def handleKeyDown_(self, event) -> bool:
        chars = event.charactersIgnoringModifiers()
        if not chars:
            return False
        key = chars[0]

        if key == "/":
            self._search_field.becomeFirstResponder()
            return True
        if key == "\x1b":  # Escape
            self._search_field.setStringValue_("")
            self._filter_text = ""
            self._apply_filters()
            self.view.window().makeFirstResponder_(self.view)
            return True

        actions = {
            "\r": lambda: self.doSet_(None),
            "f": lambda: self.doFav_(None),
            "x": lambda: self.doAction_(None),
            "d": lambda: self.doDelete_(None),
            "o": lambda: self.doOpen_(None),
        }
        if key in actions:
            actions[key]()
            return True
        return False

    # ── Helpers ──

    def _update_status(self):
        n = len(self._filtered_images) + len(self._blocklist_only)
        self._status.setStringValue_(f"{n} image{'s' if n != 1 else ''}")

    def _update_buttons(self):
        has_file = self._selected_path() is not None
        has_sel = has_file or self._selected_blocklist_name() is not None

        self._btn_set.setEnabled_(has_file)
        self._btn_open.setEnabled_(has_sel)
        self._btn_delete.setEnabled_(has_sel)
        self._btn_fav.setEnabled_(has_file)
        self._btn_fav.setHidden_(self.category not in ("pool", "disliked"))

        if self.category == "disliked" and self._selected_blocklist_name() and not has_file:
            label = "Unblock [X]"
        else:
            label = f"{ACTION_LABELS.get(self.category, 'Action')} [X]"
        self._btn_action.setTitle_(label)
        self._btn_action.setEnabled_(has_sel)
