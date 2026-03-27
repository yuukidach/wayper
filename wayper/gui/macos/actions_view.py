"""Quick actions panel: current wallpaper preview + next/prev/fav/dislike."""

from __future__ import annotations

from pathlib import Path

import objc
from AppKit import (
    NSBezelStyleRounded,
    NSButton,
    NSFont,
    NSImage,
    NSImageScaleProportionallyUpOrDown,
    NSImageView,
    NSMakeRect,
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
from Foundation import NSObject

from ...backend import get_focused_monitor, query_current
from ..actions import (
    do_dislike,
    do_favorite,
    do_next,
    do_open_wallhaven,
    do_prev,
    do_undislike,
    do_unfavorite,
)
from ._style_helpers import apply_card_shadow, fade_in
from .colors import C_BLUE, C_GREEN, C_MANTLE_CG, C_PEACH, C_RED, C_TEXT


class ActionsPanelController(NSObject):
    """Quick actions: preview current wallpaper + action buttons."""

    def initWithConfig_(self, config):
        self = objc.super(ActionsPanelController, self).init()
        if self is None:
            return None
        self.config = config
        self._current_path: Path | None = None
        self._current_monitor: str | None = None
        self._timer: NSTimer | None = None
        self.view = self._build_ui()
        self._refresh()
        return self

    def _build_ui(self) -> NSView:
        root = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, 800, 600))
        root.setWantsLayer_(True)

        stack = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 700, 550))
        stack.setOrientation_(NSUserInterfaceLayoutOrientationVertical)
        stack.setSpacing_(16)
        stack.setDistribution_(2)  # NSStackViewDistributionFill
        stack.setTranslatesAutoresizingMaskIntoConstraints_(False)

        self._preview = NSImageView.alloc().initWithFrame_(NSMakeRect(0, 0, 700, 400))
        self._preview.setImageScaling_(NSImageScaleProportionallyUpOrDown)
        self._preview.setWantsLayer_(True)
        self._preview.layer().setCornerRadius_(12)
        self._preview.layer().setMasksToBounds_(True)
        self._preview.layer().setBackgroundColor_(C_MANTLE_CG)
        self._preview.setTranslatesAutoresizingMaskIntoConstraints_(False)

        # Shadow wrapper — shadow on outer view, clipping on inner preview
        self._shadow_wrap = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, 700, 400))
        self._shadow_wrap.setWantsLayer_(True)
        self._shadow_wrap.layer().setCornerRadius_(12)
        apply_card_shadow(self._shadow_wrap)
        self._shadow_wrap.setContentHuggingPriority_forOrientation_(1, 1)
        self._shadow_wrap.setContentHuggingPriority_forOrientation_(1, 0)
        self._shadow_wrap.setContentCompressionResistancePriority_forOrientation_(1, 1)
        self._shadow_wrap.setContentCompressionResistancePriority_forOrientation_(1, 0)
        self._shadow_wrap.setTranslatesAutoresizingMaskIntoConstraints_(False)
        self._shadow_wrap.addSubview_(self._preview)
        self._shadow_wrap.addConstraints_(
            [
                self._preview.topAnchor().constraintEqualToAnchor_(self._shadow_wrap.topAnchor()),
                self._preview.leadingAnchor().constraintEqualToAnchor_(
                    self._shadow_wrap.leadingAnchor()
                ),
                self._preview.trailingAnchor().constraintEqualToAnchor_(
                    self._shadow_wrap.trailingAnchor()
                ),
                self._preview.bottomAnchor().constraintEqualToAnchor_(
                    self._shadow_wrap.bottomAnchor()
                ),
            ]
        )
        stack.addView_inGravity_(self._shadow_wrap, NSStackViewGravityLeading)

        # Info labels
        info_bar = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 600, 24))
        info_bar.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        info_bar.setSpacing_(12)

        self._monitor_label = NSTextField.labelWithString_("")
        self._monitor_label.setTextColor_(C_BLUE)
        self._monitor_label.setFont_(NSFont.boldSystemFontOfSize_(13))
        info_bar.addView_inGravity_(self._monitor_label, NSStackViewGravityLeading)

        self._filename_label = NSTextField.labelWithString_("")
        self._filename_label.setTextColor_(C_TEXT)
        self._filename_label.setFont_(NSFont.systemFontOfSize_(12))
        info_bar.addView_inGravity_(self._filename_label, NSStackViewGravityLeading)

        self._fav_label = NSTextField.labelWithString_("")
        self._fav_label.setTextColor_(C_GREEN)
        self._fav_label.setFont_(NSFont.systemFontOfSize_(12))
        info_bar.addView_inGravity_(self._fav_label, NSStackViewGravityTrailing)

        info_bar.setContentHuggingPriority_forOrientation_(999, 1)
        stack.addView_inGravity_(info_bar, NSStackViewGravityLeading)

        # Action buttons — grouped by function, SF Symbols + semantic colors
        self._btn_prev = self._make_btn("Prev", "doPrev:", symbol="chevron.left", tint=C_TEXT)
        self._btn_next = self._make_btn("Next", "doNext:", symbol="chevron.right", tint=C_BLUE)
        self._btn_next.setKeyEquivalent_("\r")
        self._btn_fav = self._make_btn("Fav", "doFav:", symbol="heart", tint=C_GREEN)
        self._btn_unfav = self._make_btn("Unfav", "doUnfav:", symbol="heart.slash", tint=C_PEACH)
        self._btn_dislike = self._make_btn(
            "Dislike", "doDislike:", symbol="hand.thumbsdown", tint=C_RED
        )
        self._btn_undo = self._make_btn(
            "Undo Dislike", "doUndislike:", symbol="arrow.uturn.left", tint=C_PEACH
        )
        self._btn_open = self._make_btn("Open", "doOpen:", symbol="safari", tint=C_BLUE)

        # Navigation group
        nav_group = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 150, 36))
        nav_group.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        nav_group.setSpacing_(8)
        nav_group.addView_inGravity_(self._btn_prev, NSStackViewGravityCenter)
        nav_group.addView_inGravity_(self._btn_next, NSStackViewGravityCenter)

        # Rating group
        rate_group = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 250, 36))
        rate_group.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        rate_group.setSpacing_(8)
        rate_group.addView_inGravity_(self._btn_fav, NSStackViewGravityCenter)
        rate_group.addView_inGravity_(self._btn_unfav, NSStackViewGravityCenter)
        rate_group.addView_inGravity_(self._btn_dislike, NSStackViewGravityCenter)
        rate_group.addView_inGravity_(self._btn_undo, NSStackViewGravityCenter)

        # Utility group
        util_group = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 80, 36))
        util_group.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        util_group.setSpacing_(8)
        util_group.addView_inGravity_(self._btn_open, NSStackViewGravityCenter)

        btn_bar = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 600, 36))
        btn_bar.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        btn_bar.setSpacing_(20)
        btn_bar.addView_inGravity_(nav_group, NSStackViewGravityCenter)
        btn_bar.addView_inGravity_(rate_group, NSStackViewGravityCenter)
        btn_bar.addView_inGravity_(util_group, NSStackViewGravityCenter)
        btn_bar.setContentHuggingPriority_forOrientation_(999, 1)

        stack.addView_inGravity_(btn_bar, NSStackViewGravityCenter)

        root.addSubview_(stack)
        root.addConstraints_(
            [
                stack.topAnchor().constraintEqualToAnchor_constant_(root.topAnchor(), 20),
                stack.leadingAnchor().constraintEqualToAnchor_constant_(root.leadingAnchor(), 20),
                stack.trailingAnchor().constraintEqualToAnchor_constant_(
                    root.trailingAnchor(), -20
                ),
                stack.bottomAnchor().constraintEqualToAnchor_constant_(root.bottomAnchor(), -20),
                self._shadow_wrap.leadingAnchor().constraintEqualToAnchor_(stack.leadingAnchor()),
                self._shadow_wrap.trailingAnchor().constraintEqualToAnchor_(stack.trailingAnchor()),
                self._shadow_wrap.heightAnchor().constraintGreaterThanOrEqualToConstant_(200),
            ]
        )

        return root

    def _make_btn(
        self,
        title: str,
        action: str,
        *,
        symbol: str | None = None,
        tint: NSImage | None = None,
    ) -> NSButton:
        if symbol:
            img = NSImage.imageWithSystemSymbolName_accessibilityDescription_(symbol, title)
            btn = NSButton.buttonWithImage_target_action_(img, self, action)
            btn.setToolTip_(title)
        else:
            btn = NSButton.buttonWithTitle_target_action_(title, self, action)
        btn.setBezelStyle_(NSBezelStyleRounded)
        if tint:
            btn.setContentTintColor_(tint)
        return btn

    # ── Refresh with change detection ──

    def _refresh(self):
        current = query_current()
        monitor = get_focused_monitor()
        if not monitor or monitor not in current:
            for name, path in current.items():
                if path:
                    monitor = name
                    break

        img = current.get(monitor) if monitor else None

        # Skip UI update if nothing changed
        if img == self._current_path and monitor == self._current_monitor:
            return

        self._current_monitor = monitor
        self._current_path = img

        if img and img.exists():
            ns_img = NSImage.alloc().initByReferencingFile_(str(img))
            self._preview.setImage_(ns_img)
            fade_in(self._preview, 0.3)
        else:
            self._preview.setImage_(None)

        self._monitor_label.setStringValue_(monitor or "\u2014")
        self._filename_label.setStringValue_(img.name if img else "No wallpaper")
        is_fav = img and "favorites" in str(img)
        self._fav_label.setStringValue_("Favorite" if is_fav else "")

        self._btn_fav.setHidden_(bool(is_fav))
        self._btn_unfav.setHidden_(not is_fav)

    def startPolling(self):
        if self._timer:
            return
        self._timer = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            3.0,
            self,
            "pollRefresh:",
            None,
            True,
        )

    def stopPolling(self):
        if self._timer:
            self._timer.invalidate()
            self._timer = None

    @objc.typedSelector(b"v@:@")
    def pollRefresh_(self, timer):
        self._refresh()

    # ── Actions ──

    @objc.typedSelector(b"v@:@")
    def doNext_(self, sender):
        do_next(self.config)
        self._current_path = None
        self._refresh()

    @objc.typedSelector(b"v@:@")
    def doPrev_(self, sender):
        do_prev(self.config)
        self._current_path = None
        self._refresh()

    @objc.typedSelector(b"v@:@")
    def doFav_(self, sender):
        do_favorite(self.config)
        self._current_path = None
        self._refresh()

    @objc.typedSelector(b"v@:@")
    def doUnfav_(self, sender):
        do_unfavorite(self.config)
        self._current_path = None
        self._refresh()

    @objc.typedSelector(b"v@:@")
    def doDislike_(self, sender):
        do_dislike(self.config)
        self._current_path = None
        self._refresh()

    @objc.typedSelector(b"v@:@")
    def doUndislike_(self, sender):
        do_undislike(self.config)
        self._current_path = None
        self._refresh()

    @objc.typedSelector(b"v@:@")
    def doOpen_(self, sender):
        do_open_wallhaven(self._current_path)

    def forceRefresh(self):
        """Force a full UI refresh (e.g. after settings change)."""
        self._current_path = None
        self._refresh()

    # ── Keyboard ──

    def handleKeyDown_(self, event) -> bool:
        chars = event.charactersIgnoringModifiers()
        if not chars:
            return False
        key = chars[0]
        actions = {
            "n": lambda: self.doNext_(None),
            "p": lambda: self.doPrev_(None),
            "f": lambda: self.doFav_(None),
            "u": lambda: self.doUnfav_(None),
            "x": lambda: self.doDislike_(None),
            "z": lambda: self.doUndislike_(None),
            "o": lambda: self.doOpen_(None),
        }
        if key in actions:
            actions[key]()
            return True
        return False
