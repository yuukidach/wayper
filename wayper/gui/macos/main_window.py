"""Main window: unified compact toolbar + content switching + daemon footer."""

from __future__ import annotations

import objc
from AppKit import (
    NSBackingStoreBuffered,
    NSBezelStyleAccessoryBarAction,
    NSButton,
    NSEventTypeKeyDown,
    NSMakeRect,
    NSMakeSize,
    NSSegmentedControl,
    NSToolbar,
    NSToolbarItem,
    NSView,
    NSWindow,
    NSWindowStyleMaskClosable,
    NSWindowStyleMaskFullSizeContentView,
    NSWindowStyleMaskMiniaturizable,
    NSWindowStyleMaskResizable,
    NSWindowStyleMaskTitled,
    NSWindowTitleHidden,
)
from Foundation import NSObject

from ...config import WayperConfig
from ...state import read_mode
from .actions_view import ActionsPanelController
from .browse_view import CATEGORIES, LABELS, BrowsePanelController
from .colors import C_BASE
from .daemon_control import DaemonControlBar

CATEGORY_ID = "category"
VIEW_SELECTOR_ID = "viewSelector"
MODE_TOGGLE_ID = "modeToggle"
FLEXIBLE_SPACE_ID = "NSToolbarFlexibleSpaceItem"
TOOLBAR_ITEMS = [CATEGORY_ID, FLEXIBLE_SPACE_ID, VIEW_SELECTOR_ID, FLEXIBLE_SPACE_ID, MODE_TOGGLE_ID]


class MainWindow(NSWindow):
    """Custom window that intercepts keyboard events."""

    _controller = None

    def sendEvent_(self, event):
        if event.type() == NSEventTypeKeyDown and self._controller:
            if self._controller.handleKeyDown_(event):
                return
        objc.super(MainWindow, self).sendEvent_(event)


class MainWindowController(NSObject):
    """Manages the main GUI window with unified toolbar, content switching, and footer."""

    def initWithConfig_(self, config):
        self = objc.super(MainWindowController, self).init()
        if self is None:
            return None
        self.config = config
        self._active_tab = 0  # 0=Browse, 1=Quick Actions
        self._mode = read_mode(config)

        self._browse = BrowsePanelController.alloc().initWithConfig_category_(config, "pool")
        self._actions = ActionsPanelController.alloc().initWithConfig_(config)
        self._daemon = DaemonControlBar.alloc().initWithConfig_(config)

        self._build_window()
        self._show_tab(0)
        self._daemon.startPolling()
        return self

    def _build_window(self):
        style = (NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                 NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable |
                 NSWindowStyleMaskFullSizeContentView)
        self.window = MainWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            NSMakeRect(150, 150, 1200, 750), style, NSBackingStoreBuffered, False,
        )
        self.window._controller = self
        self.window.setTitle_("Wayper")
        self.window.setBackgroundColor_(C_BASE)
        self.window.setMinSize_(NSMakeSize(900, 550))
        self.window.setTitlebarAppearsTransparent_(True)
        self.window.setTitleVisibility_(NSWindowTitleHidden)

        # Toolbar
        toolbar = NSToolbar.alloc().initWithIdentifier_("WayperToolbar")
        toolbar.setDelegate_(self)
        toolbar.setDisplayMode_(2)  # NSToolbarDisplayModeIconOnly
        self.window.setToolbar_(toolbar)
        if hasattr(self.window, "setToolbarStyle_"):
            self.window.setToolbarStyle_(4)  # NSWindowToolbarStyleUnifiedCompact

        # Content area
        content = self.window.contentView()
        content.setWantsLayer_(True)

        self._content_container = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, 1200, 700))
        self._content_container.setTranslatesAutoresizingMaskIntoConstraints_(False)
        content.addSubview_(self._content_container)

        # Footer
        footer = self._daemon.view
        footer.setTranslatesAutoresizingMaskIntoConstraints_(False)
        content.addSubview_(footer)

        content.addConstraints_([
            self._content_container.topAnchor().constraintEqualToAnchor_(content.topAnchor()),
            self._content_container.leadingAnchor().constraintEqualToAnchor_(content.leadingAnchor()),
            self._content_container.trailingAnchor().constraintEqualToAnchor_(content.trailingAnchor()),
            self._content_container.bottomAnchor().constraintEqualToAnchor_constant_(
                footer.topAnchor(), -4
            ),

            footer.leadingAnchor().constraintEqualToAnchor_constant_(content.leadingAnchor(), 12),
            footer.trailingAnchor().constraintEqualToAnchor_constant_(content.trailingAnchor(), -12),
            footer.bottomAnchor().constraintEqualToAnchor_constant_(content.bottomAnchor(), -6),
            footer.heightAnchor().constraintEqualToConstant_(32),
        ])

    # ── Tab switching ──

    def _show_tab(self, idx: int):
        self._active_tab = idx

        if idx == 1:
            self._actions.startPolling()
        else:
            self._actions.stopPolling()

        if hasattr(self, "_cat_seg"):
            self._cat_seg.setHidden_(idx != 0)

        for sub in self._content_container.subviews():
            sub.removeFromSuperview()

        view = self._browse.view if idx == 0 else self._actions.view
        view.setTranslatesAutoresizingMaskIntoConstraints_(False)
        self._content_container.addSubview_(view)
        self._content_container.addConstraints_([
            view.topAnchor().constraintEqualToAnchor_(self._content_container.topAnchor()),
            view.leadingAnchor().constraintEqualToAnchor_(self._content_container.leadingAnchor()),
            view.trailingAnchor().constraintEqualToAnchor_(self._content_container.trailingAnchor()),
            view.bottomAnchor().constraintEqualToAnchor_(self._content_container.bottomAnchor()),
        ])

    # ── Keyboard ──

    def handleKeyDown_(self, event) -> bool:
        chars = event.charactersIgnoringModifiers()
        if chars:
            key = chars[0]
            if key in ("1", "2", "3") and self._active_tab == 0:
                idx = int(key) - 1
                if hasattr(self, "_cat_seg"):
                    self._cat_seg.setSelectedSegment_(idx)
                self._browse.setCategory_(CATEGORIES[idx])
                return True
            if key == "m":
                self._toggle_mode()
                return True

        if self._active_tab == 0:
            return self._browse.handleKeyDown_(event)
        return self._actions.handleKeyDown_(event)

    # ── Mode toggle ──

    def _toggle_mode(self):
        self._mode = "sfw" if self._mode == "nsfw" else "nsfw"
        if hasattr(self, "_mode_btn"):
            self._mode_btn.setTitle_("NSFW" if self._mode == "nsfw" else "SFW")
        self._browse.setMode_(self._mode)
        self._daemon.forceRefresh()

    # ── Menu actions ──

    @objc.typedSelector(b"v@:@")
    def showBrowse_(self, sender):
        self._show_tab(0)
        if hasattr(self, "_tab_seg"):
            self._tab_seg.setSelectedSegment_(0)

    @objc.typedSelector(b"v@:@")
    def showActions_(self, sender):
        self._show_tab(1)
        if hasattr(self, "_tab_seg"):
            self._tab_seg.setSelectedSegment_(1)

    @objc.typedSelector(b"v@:@")
    def menuNext_(self, sender):
        self._actions.doNext_(None)

    @objc.typedSelector(b"v@:@")
    def menuPrev_(self, sender):
        self._actions.doPrev_(None)

    @objc.typedSelector(b"v@:@")
    def menuFav_(self, sender):
        self._actions.doFav_(None)

    # ── NSToolbarDelegate ──

    def toolbarAllowedItemIdentifiers_(self, toolbar):
        return TOOLBAR_ITEMS

    def toolbarDefaultItemIdentifiers_(self, toolbar):
        return TOOLBAR_ITEMS

    def toolbar_itemForItemIdentifier_willBeInsertedIntoToolbar_(self, toolbar, identifier, flag):
        item = NSToolbarItem.alloc().initWithItemIdentifier_(identifier)

        if identifier == CATEGORY_ID:
            seg = NSSegmentedControl.segmentedControlWithLabels_trackingMode_target_action_(
                list(LABELS), 0, self, "categoryChanged:",
            )
            seg.setSelectedSegment_(0)
            item.setView_(seg)
            item.setLabel_("Category")
            self._cat_seg = seg

        elif identifier == VIEW_SELECTOR_ID:
            seg = NSSegmentedControl.segmentedControlWithLabels_trackingMode_target_action_(
                ["Browse", "Quick Actions"], 0, self, "tabChanged:",
            )
            seg.setSelectedSegment_(self._active_tab)
            item.setView_(seg)
            item.setLabel_("View")
            self._tab_seg = seg

        elif identifier == MODE_TOGGLE_ID:
            btn = NSButton.buttonWithTitle_target_action_(
                "NSFW" if self._mode == "nsfw" else "SFW",
                self, "modeToggled:",
            )
            btn.setBezelStyle_(NSBezelStyleAccessoryBarAction)
            item.setView_(btn)
            item.setLabel_("Mode")
            self._mode_btn = btn

        return item

    @objc.typedSelector(b"v@:@")
    def categoryChanged_(self, sender):
        idx = sender.selectedSegment()
        self._browse.setCategory_(CATEGORIES[idx])

    @objc.typedSelector(b"v@:@")
    def tabChanged_(self, sender):
        self._show_tab(sender.selectedSegment())

    @objc.typedSelector(b"v@:@")
    def modeToggled_(self, sender):
        self._toggle_mode()

    # ── Settings ──

    def _on_settings_saved(self):
        """Reload views after settings change."""
        self._mode = read_mode(self.config)
        if hasattr(self, "_mode_btn"):
            self._mode_btn.setTitle_("NSFW" if self._mode == "nsfw" else "SFW")
        self._browse.setMode_(self._mode)
        self._browse.setCategory_(self._browse.category)
        self._actions._current_path = None
        self._actions._refresh()
        self._daemon.forceRefresh()

    # ── Cleanup ──

    def cleanup(self):
        self._actions.stopPolling()
        self._daemon.stopPolling()
