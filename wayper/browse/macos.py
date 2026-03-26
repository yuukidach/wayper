"""macOS native wallpaper browser using AppKit."""

from __future__ import annotations

import webbrowser
from pathlib import Path

import objc
from AppKit import (
    NSApplication,
    NSBackingStoreBuffered,
    NSBezelStyleAccessoryBarAction,
    NSButton,
    NSCenterTextAlignment,
    NSCollectionView,
    NSCollectionViewFlowLayout,
    NSCollectionViewItem,
    NSColor,
    NSCompositingOperationSourceOver,
    NSEventTypeKeyDown,
    NSFont,
    NSImage,
    NSImageScaleProportionallyUpOrDown,
    NSImageView,
    NSLineBreakByTruncatingTail,
    NSMakeRect,
    NSMakeSize,
    NSScrollView,
    NSSegmentedControl,
    NSStackView,
    NSStackViewGravityCenter,
    NSStackViewGravityLeading,
    NSStackViewGravityTrailing,
    NSTextField,
    NSUserInterfaceLayoutOrientationHorizontal,
    NSUserInterfaceLayoutOrientationVertical,
    NSView,
    NSWindow,
    NSWindowStyleMaskClosable,
    NSWindowStyleMaskMiniaturizable,
    NSWindowStyleMaskResizable,
    NSWindowStyleMaskTitled,
)
from Foundation import NSObject

from ..backend import find_monitor, get_focused_monitor, set_wallpaper
from ..config import WayperConfig
from ..history import push as push_history
from ..pool import add_to_blacklist, favorites_dir, pool_dir, remove_from_blacklist
from ..state import push_undo, read_mode, write_mode
from ._common import get_blocklist_only, get_images, get_orient, wallhaven_url

THUMB_SIZE = 140
ITEM_IDENTIFIER = "thumb"
CATEGORIES = ("favorites", "pool", "disliked")
LABELS = ("Favorites", "Pool", "Disliked")
ACTION_LABELS = {"favorites": "Remove", "pool": "Reject", "disliked": "Restore"}


# ── Catppuccin Mocha ──────────────────────────────────────

def _rgb(r, g, b):
    return NSColor.colorWithSRGBRed_green_blue_alpha_(r / 255, g / 255, b / 255, 1.0)

C_BASE = _rgb(0x1E, 0x1E, 0x2E)
C_TEXT = _rgb(0xCD, 0xD6, 0xF4)
C_BLUE = _rgb(0x89, 0xB4, 0xFA)
C_OVERLAY = _rgb(0x6C, 0x70, 0x86)



# ── Thumbnail NSCollectionViewItem ────────────────────────

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

        label = NSTextField.labelWithString_("")
        label.setFrame_(NSMakeRect(0, 2, THUMB_SIZE, 18))
        label.setAlignment_(NSCenterTextAlignment)
        label.setFont_(NSFont.systemFontOfSize_(10))
        label.setTextColor_(C_TEXT)
        label.setLineBreakMode_(NSLineBreakByTruncatingTail)
        container.addSubview_(label)

        self.setView_(container)
        self._imageView = iv
        self._label = label

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


# ── Main window controller ────────────────────────────────

class BrowseController(NSObject):

    def initWithConfig_category_(self, config, category):
        self = objc.super(BrowseController, self).init()
        if self is None:
            return None
        self.config = config
        self.category = category
        self.mode = read_mode(config)
        self.images: list[Path] = []
        self._blocklist_only: list[str] = []
        self.selected_index = -1
        self._thumb_cache: dict[str, NSImage] = {}
        self._build_window()
        self._reload_images()
        return self

    # ── Window setup ──

    def _build_window(self):
        style = (NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                 NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable)
        self.window = BrowseWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            NSMakeRect(200, 200, 1200, 750), style, NSBackingStoreBuffered, False,
        )
        self.window._controller = self
        self.window.setTitle_("wayper")
        self.window.setBackgroundColor_(C_BASE)
        self.window.setMinSize_(NSMakeSize(800, 500))

        content = self.window.contentView()
        content.setWantsLayer_(True)

        # ── Top bar ──
        topbar = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 100, 36))
        topbar.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        topbar.setSpacing_(8)
        topbar.setTranslatesAutoresizingMaskIntoConstraints_(False)

        # Category segment
        self._seg = NSSegmentedControl.segmentedControlWithLabels_trackingMode_target_action_(
            LABELS, 0, self, "categoryChanged:",
        )
        idx = CATEGORIES.index(self.category)
        self._seg.setSelectedSegment_(idx)
        topbar.addView_inGravity_(self._seg, NSStackViewGravityLeading)

        # Mode toggle
        mode_label = "NSFW" if self.mode == "nsfw" else "SFW"
        self._mode_btn = NSButton.buttonWithTitle_target_action_(mode_label, self, "modeToggled:")
        self._mode_btn.setBezelStyle_(NSBezelStyleAccessoryBarAction)
        topbar.addView_inGravity_(self._mode_btn, NSStackViewGravityTrailing)

        content.addSubview_(topbar)

        # ── Collection view (left) ──
        layout = NSCollectionViewFlowLayout.alloc().init()
        layout.setItemSize_(NSMakeSize(THUMB_SIZE, THUMB_SIZE + 24))
        layout.setMinimumInteritemSpacing_(8)
        layout.setMinimumLineSpacing_(8)
        layout.setSectionInset_((12, 12, 12, 12))

        self._cv = NSCollectionView.alloc().initWithFrame_(NSMakeRect(0, 0, 460, 600))
        self._cv.setCollectionViewLayout_(layout)
        self._cv.setDataSource_(self)
        self._cv.setDelegate_(self)
        self._cv.setBackgroundColors_([C_BASE])
        self._cv.setSelectable_(True)
        self._cv.registerClass_forItemWithIdentifier_(ThumbnailItem, ITEM_IDENTIFIER)

        scroll = NSScrollView.alloc().initWithFrame_(NSMakeRect(0, 0, 460, 600))
        scroll.setDocumentView_(self._cv)
        scroll.setHasVerticalScroller_(True)
        scroll.setDrawsBackground_(False)

        # ── Right panel (preview + actions) ──
        right = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 600, 600))
        right.setOrientation_(NSUserInterfaceLayoutOrientationVertical)
        right.setSpacing_(12)

        self._preview = NSImageView.alloc().initWithFrame_(NSMakeRect(0, 0, 500, 400))
        self._preview.setImageScaling_(NSImageScaleProportionallyUpOrDown)
        self._preview.setWantsLayer_(True)
        self._preview.layer().setCornerRadius_(12)
        self._preview.layer().setBackgroundColor_(NSColor.blackColor().CGColor())
        self._preview.setContentHuggingPriority_forOrientation_(1, 1)  # low priority, vertical
        self._preview.setContentHuggingPriority_forOrientation_(1, 0)  # low priority, horizontal
        self._preview.setContentCompressionResistancePriority_forOrientation_(1, 1)  # allow shrink vertically
        self._preview.setContentCompressionResistancePriority_forOrientation_(1, 0)  # allow shrink horizontally
        self._preview.setTranslatesAutoresizingMaskIntoConstraints_(False)
        right.addView_inGravity_(self._preview, NSStackViewGravityLeading)

        # Action buttons
        btn_bar = NSStackView.alloc().initWithFrame_(NSMakeRect(0, 0, 400, 32))
        btn_bar.setOrientation_(NSUserInterfaceLayoutOrientationHorizontal)
        btn_bar.setSpacing_(8)
        btn_bar.setContentHuggingPriority_forOrientation_(999, 1)  # stay compact vertically

        self._btn_set = self._make_btn("Set [Enter]", "doSet:")
        self._btn_open = self._make_btn("Open [O]", "doOpen:")
        self._btn_fav = self._make_btn("Fav [F]", "doFav:")
        self._btn_action = self._make_btn("Remove [X]", "doAction:")
        self._btn_delete = self._make_btn("Delete [D]", "doDelete:")
        for b in (self._btn_set, self._btn_open, self._btn_fav, self._btn_action, self._btn_delete):
            btn_bar.addView_inGravity_(b, NSStackViewGravityCenter)

        right.addView_inGravity_(btn_bar, NSStackViewGravityTrailing)

        # Status
        self._status = NSTextField.labelWithString_("")
        self._status.setTextColor_(C_OVERLAY)
        self._status.setFont_(NSFont.systemFontOfSize_(11))
        self._status.setContentHuggingPriority_forOrientation_(999, 1)
        right.addView_inGravity_(self._status, NSStackViewGravityTrailing)

        # ── Layout with constraints ──
        content.addSubview_(scroll)
        content.addSubview_(right)

        topbar.setTranslatesAutoresizingMaskIntoConstraints_(False)
        scroll.setTranslatesAutoresizingMaskIntoConstraints_(False)
        right.setTranslatesAutoresizingMaskIntoConstraints_(False)

        content.addConstraints_([
            topbar.topAnchor().constraintEqualToAnchor_constant_(content.topAnchor(), 8),
            topbar.leadingAnchor().constraintEqualToAnchor_constant_(content.leadingAnchor(), 12),
            topbar.trailingAnchor().constraintEqualToAnchor_constant_(content.trailingAnchor(), -12),

            scroll.topAnchor().constraintEqualToAnchor_constant_(topbar.bottomAnchor(), 8),
            scroll.leadingAnchor().constraintEqualToAnchor_constant_(content.leadingAnchor(), 8),
            scroll.widthAnchor().constraintEqualToConstant_(480),
            scroll.bottomAnchor().constraintEqualToAnchor_constant_(content.bottomAnchor(), -8),

            right.topAnchor().constraintEqualToAnchor_constant_(topbar.bottomAnchor(), 8),
            right.leadingAnchor().constraintEqualToAnchor_constant_(scroll.trailingAnchor(), 12),
            right.trailingAnchor().constraintEqualToAnchor_constant_(content.trailingAnchor(), -12),
            right.bottomAnchor().constraintEqualToAnchor_constant_(content.bottomAnchor(), -8),

            # Preview fills the right panel width
            self._preview.leadingAnchor().constraintEqualToAnchor_(right.leadingAnchor()),
            self._preview.trailingAnchor().constraintEqualToAnchor_(right.trailingAnchor()),
        ])

        self._update_buttons()

    def _make_btn(self, title, action):
        btn = NSButton.buttonWithTitle_target_action_(title, self, action)
        btn.setBezelStyle_(NSBezelStyleAccessoryBarAction)
        return btn

    # ── Data loading ──

    def _reload_images(self):
        self.images = get_images(self.category, self.mode, self.config)
        self._blocklist_only = (
            get_blocklist_only(self.images, self.config)
            if self.category == "disliked" else []
        )
        self._thumb_cache.clear()
        self.selected_index = -1
        self._preview.setImage_(None)
        self._cv.reloadData()
        self._update_status()
        self._update_buttons()

    # ── NSCollectionViewDataSource ──

    def collectionView_numberOfItemsInSection_(self, cv, section):
        return len(self.images) + len(self._blocklist_only)

    def collectionView_itemForRepresentedObjectAtIndexPath_(self, cv, indexPath):
        item = cv.makeItemWithIdentifier_forIndexPath_(ITEM_IDENTIFIER, indexPath)
        idx = indexPath.item()

        if idx < len(self.images):
            img_path = self.images[idx]
            name = img_path.stem[-12:]
            thumb = self._get_thumb(str(img_path))
            item.configureWithImage_name_(thumb, name)
        else:
            bl_idx = idx - len(self.images)
            name = Path(self._blocklist_only[bl_idx]).stem[-12:]
            item.configureWithImage_name_(None, name)

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
                side, side,
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
            self._preview.setImage_(None)
            self._update_buttons()

    # ── Preview ──

    def _update_preview(self):
        path = self._selected_path()
        if path and path.exists():
            img = NSImage.alloc().initByReferencingFile_(str(path))
            self._preview.setImage_(img)
        else:
            self._preview.setImage_(None)

    def _selected_path(self) -> Path | None:
        if 0 <= self.selected_index < len(self.images):
            return self.images[self.selected_index]
        return None

    def _selected_blocklist_name(self) -> str | None:
        bl_start = len(self.images)
        if self.selected_index >= bl_start:
            bl_idx = self.selected_index - bl_start
            if bl_idx < len(self._blocklist_only):
                return self._blocklist_only[bl_idx]
        return None

    # ── Actions ──

    @objc.typedSelector(b"v@:@")
    def categoryChanged_(self, sender):
        idx = sender.selectedSegment()
        self.category = CATEGORIES[idx]
        self._reload_images()

    @objc.typedSelector(b"v@:@")
    def modeToggled_(self, sender):
        self.mode = "sfw" if self.mode == "nsfw" else "nsfw"
        sender.setTitle_("NSFW" if self.mode == "nsfw" else "SFW")
        write_mode(self.config, self.mode)
        self._reload_images()

    @objc.typedSelector(b"v@:@")
    def doSet_(self, sender):
        path = self._selected_path()
        if not path or not path.exists():
            return
        monitor = get_focused_monitor()
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
        path = self._selected_path()
        if not path or not path.exists():
            return
        orient = get_orient(path)
        dest = favorites_dir(self.config, self.mode, orient) / path.name
        dest.parent.mkdir(parents=True, exist_ok=True)
        path.rename(dest)
        self._reload_images()

    @objc.typedSelector(b"v@:@")
    def doAction_(self, sender):
        name = self._selected_blocklist_name()
        path = self._selected_path()

        if self.category == "disliked" and name and not path:
            remove_from_blacklist(self.config, name)
            self._reload_images()
            return

        if not path or not path.exists():
            return
        orient = get_orient(path)

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

    @objc.typedSelector(b"v@:@")
    def doDelete_(self, sender):
        name = self._selected_blocklist_name()
        path = self._selected_path()
        if name and not path:
            remove_from_blacklist(self.config, name)
        elif path and path.exists():
            path.unlink()
        self._reload_images()

    # ── Keyboard shortcuts ──

    def handleKeyDown_(self, event):
        chars = event.charactersIgnoringModifiers()
        if not chars:
            return False
        key = chars[0]
        actions = {
            "1": lambda: self._seg.setSelectedSegment_(0) or self.categoryChanged_(self._seg),
            "2": lambda: self._seg.setSelectedSegment_(1) or self.categoryChanged_(self._seg),
            "3": lambda: self._seg.setSelectedSegment_(2) or self.categoryChanged_(self._seg),
            "\r": lambda: self.doSet_(None),
            "f": lambda: self.doFav_(None),
            "x": lambda: self.doAction_(None),
            "d": lambda: self.doDelete_(None),
            "o": lambda: self.doOpen_(None),
            "m": lambda: self.modeToggled_(self._mode_btn),
            "q": lambda: self.window.close(),
        }
        if key in actions:
            actions[key]()
            return True
        return False

    # ── Helpers ──

    def _update_status(self):
        n = len(self.images) + len(self._blocklist_only)
        self._status.setStringValue_(
            f"{n} image{'s' if n != 1 else ''} \u00b7 {self.mode.upper()}"
        )

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


# ── Keyboard event subclass ───────────────────────────────

class BrowseWindow(NSWindow):
    _controller = None

    def sendEvent_(self, event):
        # Intercept key-down events before they reach the responder chain
        if event.type() == NSEventTypeKeyDown and self._controller:
            if self._controller.handleKeyDown_(event):
                return
        objc.super(BrowseWindow, self).sendEvent_(event)


# ── Entry point ───────────────────────────────────────────

def run(config: WayperConfig, category: str = "favorites") -> None:
    app = NSApplication.sharedApplication()
    controller = BrowseController.alloc().initWithConfig_category_(config, category)
    controller.window.makeKeyAndOrderFront_(None)
    app.run()
