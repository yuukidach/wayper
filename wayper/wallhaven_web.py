"""Wallhaven web scraping client for favorite sync.

Session-based login with CSRF tokens. Checks remote fav state before toggling
to avoid accidental inversions (Wallhaven's fav endpoint is a toggle).
"""

from __future__ import annotations

import logging
import re
import threading

import httpx

from .config import WayperConfig
from .pool import favorites_dir
from .wallhaven import wallhaven_id

log = logging.getLogger("wayper.wallhaven")


class WallhavenWeb:
    """Session-based client for Wallhaven web actions (favorite sync)."""

    BASE = "https://wallhaven.cc"

    def __init__(self, username: str, password: str, proxy: str | None = None):
        self._username = username
        self._password = password
        self._client = httpx.Client(
            proxy=proxy,
            timeout=httpx.Timeout(30, connect=10),
            follow_redirects=True,
        )
        self._logged_in = False

    def _csrf(self, html: str) -> str:
        m = re.search(r'csrf-token"\s+content="([^"]+)"', html)
        return m.group(1) if m else ""

    def _login(self) -> bool:
        try:
            resp = self._client.get(f"{self.BASE}/login")
            csrf = self._csrf(resp.text)
            if not csrf:
                log.warning("wallhaven web: CSRF token not found on login page")
                return False
            resp = self._client.post(
                f"{self.BASE}/auth/login",
                data={"_token": csrf, "username": self._username, "password": self._password},
            )
            self._logged_in = "auth/logout" in resp.text
            if not self._logged_in:
                log.warning("wallhaven web: login failed for %s", self._username)
            return self._logged_in
        except Exception:
            log.warning("wallhaven web: login error", exc_info=True)
            return False

    def _ensure_login(self) -> bool:
        if self._logged_in:
            return True
        return self._login()

    def _parse_fav_button(self, html: str) -> tuple[str | None, bool | None]:
        """Parse fav button from page HTML.

        Returns (fav_toggle_url, is_currently_favorited).
        is_currently_favorited is None if state can't be determined.

        Wallhaven uses #fav-button with class "add-button" when NOT favorited.
        When favorited, "add-button" class is absent.
        """
        url: str | None = None
        is_faved: bool | None = None

        # Check #fav-button element for state
        m = re.search(r'id="fav-button"([^>]*)', html)
        if m:
            attrs = m.group(1)
            cls_m = re.search(r'class="([^"]*)"', attrs)
            if cls_m:
                classes = cls_m.group(1).split()
                is_faved = "add-button" not in classes
            else:
                is_faved = True  # no class attr → already favorited (simple button)
            href_m = re.search(r'href="([^"]+)"', attrs)
            if href_m:
                url = href_m.group(1)

        # Find URL from child .add-fav elements (when add-button is present)
        if not url:
            urls = re.findall(r'href="([^"]+)"[^>]*class="[^"]*add-fav', html)
            if not urls:
                urls = re.findall(r'class="[^"]*add-fav[^"]*"[^>]*href="([^"]+)"', html)
            if urls:
                url = urls[0]
                if is_faved is None:
                    is_faved = False  # .add-fav child present → not yet favorited

        # Fallback: data-href from non-logged-in page
        if not url:
            m = re.search(r'data-href="([^"]*wallpaper/fav/[^"]*)"', html)
            if m:
                url = m.group(1)

        return url, is_faved

    def _do_toggle(self, wh_id: str, want_fav: bool) -> bool:
        """Toggle fav state, but only if current state differs from want_fav."""
        resp = self._client.get(f"{self.BASE}/w/{wh_id}")
        if resp.status_code != 200:
            log.warning("wallhaven web: wallpaper page %s returned %d", wh_id, resp.status_code)
            return False

        html = resp.text
        csrf = self._csrf(html)
        url, is_faved = self._parse_fav_button(html)

        if not url:
            log.warning("wallhaven web: no fav URL found for %s", wh_id)
            return False

        # Already in desired state — no-op
        if is_faved is not None and is_faved == want_fav:
            action = "favorited" if is_faved else "not favorited"
            log.info("wallhaven web: %s already %s, skipping", wh_id, action)
            return True

        # Can't determine state and want to unfav — skip to be safe
        if is_faved is None and not want_fav:
            log.warning("wallhaven web: can't determine fav state for %s, skipping unfav", wh_id)
            return False

        resp = self._client.post(
            url,
            headers={
                "X-CSRF-TOKEN": csrf,
                "X-Requested-With": "XMLHttpRequest",
                "Referer": f"{self.BASE}/w/{wh_id}",
            },
        )
        if resp.status_code == 200:
            try:
                ok = resp.json().get("status", False)
            except Exception:
                ok = False
            if ok:
                action = "favorited" if want_fav else "unfavorited"
                log.info("wallhaven web: %s %s", action, wh_id)
            return ok

        log.warning("wallhaven web: fav POST for %s returned %d", wh_id, resp.status_code)
        return False

    def fav(self, wh_id: str, *, want_fav: bool = True) -> bool:
        """Set wallpaper fav state on Wallhaven. Checks remote state before toggling."""
        if not self._ensure_login():
            return False
        try:
            ok = self._do_toggle(wh_id, want_fav)
            if not ok and self._logged_in:
                # Session may have expired — retry login once
                self._logged_in = False
                if self._login():
                    ok = self._do_toggle(wh_id, want_fav)
            return ok
        except Exception:
            log.warning("wallhaven web: fav error for %s", wh_id, exc_info=True)
            return False

    def close(self) -> None:
        self._client.close()


_web_session: WallhavenWeb | None = None
_web_lock = threading.Lock()


def _ensure_web_session(config: WayperConfig) -> WallhavenWeb:
    """Return the module-level WallhavenWeb singleton, creating it if needed."""
    global _web_session
    if _web_session is None:
        _web_session = WallhavenWeb(
            config.wallhaven_username, config.wallhaven_password, config.proxy
        )
    return _web_session


def _wallhaven_web_set(config: WayperConfig, filename: str, *, want_fav: bool) -> None:
    """Set fav state on Wallhaven in a background thread (fire-and-forget).

    Checks remote state before toggling to avoid accidental toggle inversion.
    No-op if wallhaven_username/password are not configured.
    """
    if not config.wallhaven_username or not config.wallhaven_password:
        return

    wh_id = wallhaven_id(filename)

    def _do():
        with _web_lock:
            _ensure_web_session(config).fav(wh_id, want_fav=want_fav)

    threading.Thread(target=_do, daemon=True).start()


def wallhaven_web_fav(config: WayperConfig, filename: str) -> None:
    """Favorite a wallpaper on Wallhaven (fire-and-forget background thread)."""
    _wallhaven_web_set(config, filename, want_fav=True)


def wallhaven_web_unfav(config: WayperConfig, filename: str) -> None:
    """Unfavorite a wallpaper on Wallhaven (fire-and-forget background thread)."""
    _wallhaven_web_set(config, filename, want_fav=False)


PUSH_BATCH_SIZE = 5  # max wallpapers to push per sync cycle


def push_local_favorites(config: WayperConfig, remote_files: set[str]) -> int:
    """Push local favorites missing from remote to Wallhaven. Returns count pushed.

    Remote state is checked before each toggle, so re-pushing an already-favorited
    wallpaper is a safe no-op (it won't accidentally unfavorite).
    """
    if not config.wallhaven_username or not config.wallhaven_password:
        return 0

    from .pool import list_images
    from .state import ALL_PURITIES

    local_favs: list[str] = []
    for purity in ALL_PURITIES:
        for orientation in ("landscape", "portrait"):
            fav_dir = favorites_dir(config, purity, orientation)
            local_favs.extend(f.name for f in list_images(fav_dir))

    missing = [f for f in local_favs if f not in remote_files]
    if not missing:
        return 0

    log.info(
        "push: %d local favorites not in remote, pushing up to %d",
        len(missing),
        PUSH_BATCH_SIZE,
    )

    with _web_lock:
        session = _ensure_web_session(config)

    pushed = 0
    for filename in missing[:PUSH_BATCH_SIZE]:
        wh_id = wallhaven_id(filename)
        with _web_lock:
            ok = session.fav(wh_id)
        if ok:
            pushed += 1

    if pushed:
        log.info("push: favorited %d wallpapers on Wallhaven", pushed)
    return pushed
