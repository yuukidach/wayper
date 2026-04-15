"""Wallhaven web scraping client for favorite sync.

Session-based login with CSRF tokens. Checks remote fav state before toggling
to avoid accidental inversions (Wallhaven's fav endpoint is a toggle).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import sys
import threading
import time
from pathlib import Path

import httpx

from .config import CONFIG_DIR, WayperConfig
from .pool import favorites_dir
from .wallhaven import USER_AGENT, wallhaven_id

log = logging.getLogger("wayper.wallhaven")

_COOKIE_FILE = CONFIG_DIR / ".wh_session.json"
_COOKIE_MAX_AGE = 86400  # 24 hours


def _find_chrome() -> str | None:
    """Find Chrome/Chromium executable path (cross-platform)."""
    if sys.platform == "darwin":
        candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
    else:
        candidates = [
            "google-chrome-stable",
            "google-chrome",
            "chromium",
            "chromium-browser",
        ]
    for c in candidates:
        if Path(c).exists():
            return c
        resolved = shutil.which(c)
        if resolved:
            return resolved
    return None


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
            headers={"User-Agent": USER_AGENT},
        )
        self._logged_in = False

    def _csrf(self, html: str) -> str:
        m = re.search(r'csrf-token"\s+content="([^"]+)"', html)
        return m.group(1) if m else ""

    def _login(self) -> bool:
        if self._load_cookies():
            if self._verify_session():
                self._logged_in = True
                log.info("wallhaven web: restored session from cached cookies")
                return True
            log.info("wallhaven web: cached cookies expired on server, need fresh login")
            self._clear_cookies()

        if self._load_browser_cookies():
            self._logged_in = True
            self._save_cookies()
            log.info("wallhaven web: logged in via browser cookies")
            return True

        try:
            resp = self._client.get(f"{self.BASE}/login")

            if self._is_cf_challenge(resp):
                log.info("wallhaven web: Cloudflare challenge detected, trying nodriver")
                if self._nodriver_login():
                    return True
                log.warning(
                    "wallhaven web: all login methods failed. "
                    "Please log into wallhaven.cc in your browser to enable remote fav sync"
                )
                return False

            csrf = self._csrf(resp.text)
            if not csrf:
                log.warning("wallhaven web: CSRF token not found on login page")
                return False
            resp = self._client.post(
                f"{self.BASE}/auth/login",
                data={"_token": csrf, "username": self._username, "password": self._password},
                follow_redirects=False,
            )
            # 302 redirect (to profile page) means login succeeded
            self._logged_in = resp.status_code == 302
            if self._logged_in:
                self._save_cookies()
            else:
                log.warning("wallhaven web: login failed for %s", self._username)
            return self._logged_in
        except Exception:
            log.warning("wallhaven web: login error", exc_info=True)
            return False

    def _ensure_login(self) -> bool:
        if self._logged_in:
            return True
        return self._login()

    def _load_cookies(self) -> bool:
        """Load cached cookies from file into httpx client. Returns True if loaded."""
        if not _COOKIE_FILE.exists():
            return False
        try:
            data = json.loads(_COOKIE_FILE.read_text())
            if time.time() - data.get("timestamp", 0) > _COOKIE_MAX_AGE:
                log.info("wallhaven web: cached cookies expired, need fresh login")
                return False
            if data.get("username") != self._username:
                return False
            for c in data.get("cookies", []):
                self._client.cookies.set(
                    c["name"],
                    c["value"],
                    domain=c.get("domain", ""),
                    path=c.get("path", "/"),
                )
            return True
        except Exception:
            log.warning("wallhaven web: failed to load cached cookies", exc_info=True)
            return False

    def _save_cookies(self) -> None:
        """Save current httpx client cookies to file."""
        from .util import atomic_write

        cookies = []
        for cookie in self._client.cookies.jar:
            cookies.append(
                {
                    "name": cookie.name,
                    "value": cookie.value,
                    "domain": cookie.domain,
                    "path": cookie.path,
                }
            )
        if not cookies:
            return
        data = {
            "cookies": cookies,
            "timestamp": time.time(),
            "username": self._username,
        }
        _COOKIE_FILE.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(_COOKIE_FILE, json.dumps(data, indent=2))

    def _clear_cookies(self) -> None:
        """Delete cookie cache file and clear client cookies."""
        _COOKIE_FILE.unlink(missing_ok=True)
        self._client.cookies.clear()

    def _verify_session(self) -> bool:
        """Verify that current cookies represent a valid logged-in Wallhaven session.

        Uses a temporary client to avoid polluting the main client's cookie jar
        with server-issued replacement cookies from a failed verification.
        """
        tmp = httpx.Client(
            timeout=httpx.Timeout(15, connect=10),
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT},
        )
        try:
            for cookie in self._client.cookies.jar:
                tmp.cookies.set(cookie.name, cookie.value, domain=cookie.domain, path=cookie.path)
            resp = tmp.get(f"{self.BASE}/")
            ok = resp.status_code == 200 and "Logout" in resp.text
            if ok:
                self._client.cookies.clear()
                for cookie in tmp.cookies.jar:
                    self._client.cookies.set(
                        cookie.name, cookie.value, domain=cookie.domain, path=cookie.path
                    )
            return ok
        except Exception:
            return False
        finally:
            tmp.close()

    def _load_browser_cookies(self) -> bool:
        """Extract wallhaven.cc cookies from user's browser via browser_cookie3.

        Tries all Chrome/Chromium profiles and Firefox. For each source that
        has cookies, verifies the session is valid before accepting.
        Returns True only if a valid logged-in session was found.
        """
        try:
            import browser_cookie3
        except ImportError:
            log.info(
                "wallhaven web: browser_cookie3 not installed, "
                "cannot extract browser cookies. Install with: pip install browser-cookie3"
            )
            return False

        # Discover all Chrome/Chromium profile cookie files
        cookie_files: list[tuple[str, Path]] = []
        if sys.platform == "darwin":
            browser_dirs = (
                Path.home() / "Library/Application Support/Google Chrome",
                Path.home() / "Library/Application Support/Chromium",
            )
        else:
            browser_dirs = (
                Path.home() / ".config/google-chrome",
                Path.home() / ".config/chromium",
            )
        for browser_dir in browser_dirs:
            if not browser_dir.is_dir():
                continue
            for profile in sorted(browser_dir.iterdir()):
                cf = profile / "Cookies"
                if cf.is_file():
                    cookie_files.append((f"Chrome/{profile.name}", cf))

        for label, cf in cookie_files:
            try:
                cj = browser_cookie3.chrome(cookie_file=str(cf), domain_name="wallhaven.cc")
                loaded = 0
                self._client.cookies.clear()
                for c in cj:
                    self._client.cookies.set(c.name, c.value, domain=c.domain, path=c.path)
                    loaded += 1
                if loaded and self._verify_session():
                    log.info("wallhaven web: extracted %d cookies from %s", loaded, label)
                    return True
            except Exception:
                continue

        # Firefox fallback
        try:
            cj = browser_cookie3.firefox(domain_name="wallhaven.cc")
            loaded = 0
            self._client.cookies.clear()
            for c in cj:
                self._client.cookies.set(c.name, c.value, domain=c.domain, path=c.path)
                loaded += 1
            if loaded and self._verify_session():
                log.info("wallhaven web: extracted %d cookies from Firefox", loaded)
                return True
        except Exception:
            pass

        self._client.cookies.clear()
        log.info("wallhaven web: no valid wallhaven session found in any browser")
        return False

    @staticmethod
    def _is_cf_challenge(resp: httpx.Response) -> bool:
        """Check if response is a Cloudflare managed challenge."""
        return resp.status_code == 403 and "challenge" in resp.headers.get("cf-mitigated", "")

    def _nodriver_login(self) -> bool:
        """Solve Cloudflare challenge and login via nodriver (sync wrapper)."""
        try:
            return asyncio.run(self._nodriver_login_async())
        except RuntimeError:
            log.warning("wallhaven web: cannot run nodriver (event loop conflict)")
            return False

    async def _nodriver_login_async(self) -> bool:
        """Use nodriver to solve Cloudflare challenge and log into Wallhaven."""
        try:
            import nodriver
        except ImportError:
            log.warning(
                "wallhaven web: nodriver not installed; cannot bypass Cloudflare challenge. "
                "Install with: pip install nodriver"
            )
            return False

        chrome_path = _find_chrome()
        if not chrome_path:
            log.warning("wallhaven web: Chrome/Chromium not found; cannot use nodriver")
            return False

        browser = None
        try:
            browser = await nodriver.start(
                headless=False,
                browser_executable_path=chrome_path,
            )
            tab = await browser.get(f"{self.BASE}/login")

            # Wait for Cloudflare challenge to resolve and login form to appear
            username_input = await tab.select("input[name='username']", timeout=30)
            if not username_input:
                log.warning("wallhaven web: login form not found after Cloudflare challenge")
                return False

            await username_input.send_keys(self._username)

            password_input = await tab.select("input[name='password']")
            if not password_input:
                log.warning("wallhaven web: password input not found")
                return False
            await password_input.send_keys(self._password)

            login_btn = await tab.select("button[type='submit']")
            if login_btn:
                await login_btn.click()
            else:
                login_link = await tab.find("Login", best_match=True)
                if login_link:
                    await login_link.click()
                else:
                    log.warning("wallhaven web: login button not found")
                    return False

            # Wait for redirect after successful login
            await tab.sleep(3)

            if "/login" in (tab.target.url or ""):
                log.warning(
                    "wallhaven web: nodriver login did not redirect, likely wrong credentials"
                )
                return False

            # Extract wallhaven cookies from browser via CDP
            all_cookies = await browser.cookies.get_all()
            for cookie in all_cookies:
                domain = cookie.domain or ""
                if "wallhaven.cc" in domain:
                    self._client.cookies.set(
                        cookie.name,
                        cookie.value,
                        domain=domain,
                        path=cookie.path or "/",
                    )

            self._save_cookies()
            self._logged_in = True
            log.info("wallhaven web: logged in via nodriver (Cloudflare bypass)")
            return True
        except Exception:
            log.warning("wallhaven web: nodriver login failed", exc_info=True)
            return False
        finally:
            if browser:
                try:
                    browser.stop()
                except Exception:
                    pass

    def _authenticated_get(self, url: str) -> httpx.Response | None:
        """GET with Cloudflare challenge awareness.

        If the response is a CF challenge, returns None without destroying
        the current session — CF-protected routes can't be bypassed by
        re-authenticating, so clearing cookies would only hurt other operations.
        """
        resp = self._client.get(url)
        if self._is_cf_challenge(resp):
            log.warning("wallhaven web: Cloudflare challenge on %s, skipping", url)
            return None
        return resp

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
        resp = self._authenticated_get(f"{self.BASE}/w/{wh_id}")
        if resp is None or resp.status_code != 200:
            log.warning(
                "wallhaven web: wallpaper page %s returned %s",
                wh_id,
                resp.status_code if resp else "None",
            )
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
                # Session may have expired — retry login without destroying cache
                self._logged_in = False
                if self._login():
                    ok = self._do_toggle(wh_id, want_fav)
            return ok
        except Exception:
            log.warning("wallhaven web: fav error for %s", wh_id, exc_info=True)
            return False

    def _parse_form_fields(self, html: str) -> dict[str, str]:
        """Parse all form field values from the browsing settings page."""
        fields: dict[str, str] = {}
        csrf = self._csrf(html)
        if csrf:
            fields["_token"] = csrf

        # Hidden and text inputs
        for m in re.finditer(r'<input[^>]*type="(hidden|text|number)"[^>]*>', html):
            tag = m.group(0)
            name = re.search(r'name="([^"]*)"', tag)
            value = re.search(r'value="([^"]*)"', tag)
            if name:
                fields[name.group(1)] = value.group(1) if value else ""

        # Checked checkboxes/radios (attribute order varies)
        for m in re.finditer(r"<input[^>]*>", html):
            tag = m.group(0)
            if not re.search(r'type="(?:checkbox|radio)"', tag):
                continue
            if "checked" not in tag:
                continue
            name = re.search(r'name="([^"]*)"', tag)
            value = re.search(r'value="([^"]*)"', tag)
            if name:
                fields[name.group(1)] = value.group(1) if value else "on"

        # Selected options in selects
        for m in re.finditer(r'<select[^>]*name="([^"]*)"[^>]*>(.*?)</select>', html, re.DOTALL):
            name, opts = m.groups()
            sel = re.search(r'<option[^>]*selected[^>]*value="([^"]*)"', opts)
            if sel:
                fields[name] = sel.group(1)

        # Textareas
        for m in re.finditer(
            r'<textarea[^>]*name="([^"]*)"[^>]*>(.*?)</textarea>', html, re.DOTALL
        ):
            fields[m.group(1)] = m.group(2).strip()

        return fields

    def _sync_blacklist_field(self, field_name: str, items: list[str], label: str) -> bool:
        """Merge items into a blacklist field on Wallhaven's browsing settings page."""
        if not self._ensure_login():
            return False
        try:
            resp = self._authenticated_get(f"{self.BASE}/settings/browsing")
            if resp is None or resp.status_code != 200:
                log.warning(
                    "wallhaven web: settings page returned %s",
                    resp.status_code if resp else "None",
                )
                return False

            fields = self._parse_form_fields(resp.text)
            if "_token" not in fields:
                log.warning("wallhaven web: no CSRF token on settings page")
                return False

            existing = {v.strip() for v in fields.get(field_name, "").split("\n") if v.strip()}
            merged = sorted(existing | set(items))
            fields[field_name] = "\n".join(merged)

            resp = self._client.post(
                f"{self.BASE}/settings/browsing",
                data=fields,
                headers={"Referer": f"{self.BASE}/settings/browsing"},
            )
            ok = resp.status_code in (200, 302)
            if ok:
                log.info("wallhaven web: synced %d %s to cloud blacklist", len(items), label)
            else:
                log.warning("wallhaven web: %s sync POST returned %d", label, resp.status_code)
            return ok
        except Exception:
            log.warning("wallhaven web: %s sync error", label, exc_info=True)
            return False

    def sync_tag_blacklist(self, tags: list[str]) -> bool:
        """Sync tag blacklist to Wallhaven account settings."""
        return self._sync_blacklist_field("blacklist", tags, "tags")

    def sync_user_blacklist(self, usernames: list[str]) -> bool:
        """Sync user blacklist to Wallhaven account settings."""
        return self._sync_blacklist_field("blacklist_users", usernames, "users")

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


def _fetch_cloud_settings(config: WayperConfig) -> dict:
    """Fetch Wallhaven API settings (needs API key, no login). Returns data dict."""
    if not config.api_key:
        return {}
    try:
        with httpx.Client(
            proxy=config.proxy,
            timeout=httpx.Timeout(15, connect=10),
            headers={"User-Agent": USER_AGENT},
        ) as client:
            resp = client.get(
                "https://wallhaven.cc/api/v1/settings",
                params={"apikey": config.api_key},
            )
            resp.raise_for_status()
            return resp.json().get("data", {})
    except Exception:
        log.warning("wallhaven web: failed to fetch cloud settings", exc_info=True)
        return {}


def fetch_cloud_tags(config: WayperConfig) -> list[str]:
    """Fetch tag_blacklist from Wallhaven API settings (needs API key, no login)."""
    tags = _fetch_cloud_settings(config).get("tag_blacklist", [])
    return [t for t in tags if t]


def fetch_cloud_users(config: WayperConfig) -> list[str]:
    """Fetch user_blacklist from Wallhaven API settings (needs API key, no login)."""
    users = _fetch_cloud_settings(config).get("user_blacklist", [])
    return [u for u in users if u]


def merge_cloud_tags_into_config(config: WayperConfig) -> bool:
    """Merge cloud tag_blacklist into local exclude_tags. Returns True if config was modified."""
    from .config import save_config

    cloud = fetch_cloud_tags(config)
    if not cloud:
        return False
    local_lower = {t.lower() for t in config.wallhaven.exclude_tags}
    new_tags = [t for t in cloud if t.lower() not in local_lower]
    if not new_tags:
        return False
    config.wallhaven.exclude_tags.extend(new_tags)
    save_config(config)
    log.info("Merged %d cloud tags into local exclude_tags", len(new_tags))
    return True


def merge_cloud_users_into_config(config: WayperConfig) -> bool:
    """Merge cloud user_blacklist into local exclude_uploaders.

    Returns True if config was modified.
    """
    from .config import save_config

    cloud = fetch_cloud_users(config)
    if not cloud:
        return False
    local_lower = {u.lower() for u in config.wallhaven.exclude_uploaders}
    new_users = [u for u in cloud if u.lower() not in local_lower]
    if not new_users:
        return False
    config.wallhaven.exclude_uploaders.extend(new_users)
    save_config(config)
    log.info("Merged %d cloud users into local exclude_uploaders", len(new_users))
    return True


def merge_cloud_blacklists_into_config(config: WayperConfig) -> bool:
    """Merge both cloud tag_blacklist and user_blacklist into local config (single API call).

    Returns True if config was modified.
    """
    from .config import save_config

    data = _fetch_cloud_settings(config)
    if not data:
        return False

    modified = False
    cloud_tags = [t for t in data.get("tag_blacklist", []) if t]
    if cloud_tags:
        local_lower = {t.lower() for t in config.wallhaven.exclude_tags}
        new_tags = [t for t in cloud_tags if t.lower() not in local_lower]
        if new_tags:
            config.wallhaven.exclude_tags.extend(new_tags)
            log.info("Merged %d cloud tags into local exclude_tags", len(new_tags))
            modified = True

    cloud_users = [u for u in data.get("user_blacklist", []) if u]
    if cloud_users:
        local_lower = {u.lower() for u in config.wallhaven.exclude_uploaders}
        new_users = [u for u in cloud_users if u.lower() not in local_lower]
        if new_users:
            config.wallhaven.exclude_uploaders.extend(new_users)
            log.info("Merged %d cloud users into local exclude_uploaders", len(new_users))
            modified = True

    if modified:
        save_config(config)
    return modified


def sync_cloud_tag_blacklist(config: WayperConfig, tags: list[str]) -> None:
    """Sync exclude_tags to Wallhaven cloud tag_blacklist (fire-and-forget thread).

    No-op if wallhaven_username/password are not configured.
    """
    if not config.wallhaven_username or not config.wallhaven_password:
        return

    def _do():
        with _web_lock:
            _ensure_web_session(config).sync_tag_blacklist(tags)

    threading.Thread(target=_do, daemon=True).start()


def sync_cloud_user_blacklist(config: WayperConfig, usernames: list[str]) -> None:
    """Sync exclude_uploaders to Wallhaven cloud user blacklist (fire-and-forget thread).

    No-op if wallhaven_username/password are not configured.
    """
    if not config.wallhaven_username or not config.wallhaven_password:
        return

    def _do():
        with _web_lock:
            _ensure_web_session(config).sync_user_blacklist(usernames)

    threading.Thread(target=_do, daemon=True).start()


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
