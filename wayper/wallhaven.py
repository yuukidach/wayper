"""Wallhaven API client."""

from __future__ import annotations

import asyncio
import logging
import random
import re
import threading
from pathlib import Path

import httpx

from .config import WayperConfig
from .image import resize_crop, validate_image
from .pool import extract_tag_names, favorites_dir, is_blacklisted, pool_dir, save_metadata

log = logging.getLogger("wayper.wallhaven")

SEARCH_URL = "https://wallhaven.cc/api/v1/search"


def wallhaven_id(name: str) -> str:
    """Extract Wallhaven ID from a filename (with or without extension)."""
    stem = name.rsplit(".", 1)[0] if "." in name else name
    return stem.split("-", 1)[-1] if "-" in stem else stem


def wallhaven_url(img_path: Path) -> str:
    """Build Wallhaven URL from image path."""
    return f"https://wallhaven.cc/w/{wallhaven_id(img_path.name)}"


_PURITY_CODES = {"sfw": "100", "sketchy": "010", "nsfw": "001"}


class WallhavenClient:
    def __init__(self, config: WayperConfig):
        self.config = config
        self.client = httpx.AsyncClient(
            proxy=config.proxy,
            timeout=httpx.Timeout(30, connect=10),
        )

    async def close(self) -> None:
        await self.client.aclose()

    def _exclude_query(self) -> str:
        """Build exclusion query fragment from exclude_tags config."""
        tags = self.config.wallhaven.exclude_tags
        if not tags:
            return ""
        return " ".join(f'-"{t}"' if " " in t else f"-{t}" for t in tags)

    def _matches_exclude_combo(self, tag_names: list[str]) -> bool:
        """Return True if tag_names matches any exclude combo rule."""
        tag_set = set(tag_names)
        return any(
            all(t in tag_set for t in combo) for combo in self.config.wallhaven.exclude_combos
        )

    async def search(self, orientation: str, purity: str) -> list[dict]:
        """Return list of wallpaper data dicts from wallhaven search."""
        page = random.randint(1, self.config.wallhaven.max_page)
        purity_code = _PURITY_CODES.get(purity, "001")
        params = {
            "categories": self.config.wallhaven.categories,
            "purity": purity_code,
            "topRange": self.config.wallhaven.top_range,
            "sorting": self.config.wallhaven.sorting,
            "order": "desc",
            "ai_art_filter": self.config.wallhaven.ai_art_filter,
            "ratios": orientation,
            "page": page,
            "apikey": self.config.api_key,
        }
        exclude_q = self._exclude_query()
        if exclude_q:
            params["q"] = exclude_q
        try:
            resp = await self.client.get(SEARCH_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
            results = data.get("data", [])
            # If random page exceeded actual last page, retry with page 1
            if not results and page > 1:
                params["page"] = 1
                resp = await self.client.get(SEARCH_URL, params=params)
                resp.raise_for_status()
                results = resp.json().get("data", [])
            return results
        except Exception:
            log.warning(
                "Wallhaven search failed (orientation=%s, purity=%s)",
                orientation,
                purity,
                exc_info=True,
            )
            return []

    async def search_with_meta(
        self,
        query: str = "",
        page: int = 1,
        purity: str = "sfw",
        **overrides: str,
    ) -> list[dict]:
        """Search Wallhaven and return full metadata for each result."""
        purity_code = _PURITY_CODES.get(purity, "001")
        params = {
            "categories": self.config.wallhaven.categories,
            "purity": purity_code,
            "topRange": self.config.wallhaven.top_range,
            "sorting": self.config.wallhaven.sorting,
            "order": "desc",
            "ai_art_filter": self.config.wallhaven.ai_art_filter,
            "page": page,
            "apikey": self.config.api_key,
        }
        exclude_q = self._exclude_query()
        q_parts = [p for p in (query, exclude_q) if p]
        if q_parts:
            params["q"] = " ".join(q_parts)
        params.update(overrides)
        try:
            resp = await self.client.get(SEARCH_URL, params=params)
            resp.raise_for_status()
            return resp.json().get("data", [])
        except Exception:
            log.warning("Wallhaven search_with_meta failed", exc_info=True)
            return []

    async def wallpaper_info(self, wallpaper_id: str) -> dict:
        """Fetch full details for a single wallpaper (includes tags)."""
        try:
            params = {"apikey": self.config.api_key} if self.config.api_key else {}
            resp = await self.client.get(
                f"https://wallhaven.cc/api/v1/w/{wallpaper_id}", params=params
            )
            resp.raise_for_status()
            return resp.json().get("data", {})
        except Exception:
            log.warning("Failed to fetch wallpaper info for %s", wallpaper_id, exc_info=True)
            return {}

    async def download_image(self, url: str, dest: Path) -> bool:
        """Download a single image. Returns True on success."""
        tmp = dest.with_name(f".dl_{dest.name}")
        try:
            async with self.client.stream("GET", url) as resp:
                resp.raise_for_status()
                chunks = []
                async for chunk in resp.aiter_bytes(8192):
                    chunks.append(chunk)
                await asyncio.to_thread(tmp.write_bytes, b"".join(chunks))
            # Validate
            if not validate_image(tmp):
                tmp.unlink(missing_ok=True)
                return False
            tmp.rename(dest)
            return True
        except Exception:
            log.warning("Download failed: %s", url, exc_info=True)
            tmp.unlink(missing_ok=True)
            return False

    async def download_for(self, orientation: str, mode: str) -> None:
        """Download a batch of wallpapers for given orientation and mode."""
        config = self.config
        target_dir = pool_dir(config, mode, orientation)
        fav_dir = favorites_dir(config, mode, orientation)

        items = await self.search(orientation, mode)
        if not items:
            return

        # Find monitor config for resize dimensions
        mon = None
        for m in config.monitors:
            if m.orientation == orientation:
                mon = m
                break

        sample = random.sample(items, min(config.wallhaven.batch_size, len(items)))
        downloaded: list[tuple[str, dict, Path]] = []  # (filename, item, dest)
        for item in sample:
            url = item.get("path", "")
            if not url:
                continue
            filename = url.rsplit("/", 1)[-1]
            dest = target_dir / filename

            if dest.exists():
                continue
            if (fav_dir / filename).exists():
                continue
            if is_blacklisted(config, filename):
                continue

            if not await self.download_image(url, dest):
                continue

            downloaded.append((filename, item, dest))

        # Fetch full details (includes tags) in parallel for all downloaded images
        if downloaded:
            details = await asyncio.gather(
                *(self.wallpaper_info(item.get("id", "")) for _, item, _ in downloaded)
            )
            for (filename, item, dest), detail in zip(downloaded, details):
                if detail:
                    item = {**item, **detail}

                if self._matches_exclude_combo(extract_tag_names(item.get("tags", []))):
                    dest.unlink(missing_ok=True)
                    continue

                save_metadata(config, filename, item)

                if mon and not resize_crop(dest, mon.width, mon.height):
                    dest.unlink(missing_ok=True)

    async def sync_remote_favorites(self) -> tuple[int, set[str]]:
        """Incrementally sync wallpapers from user's Wallhaven collections.

        Collections are scanned newest-first; pagination stops as soon as a
        page contains only wallpapers that already exist locally.
        Returns (newly_synced_count, set_of_remote_filenames_seen).
        """
        config = self.config
        remote_files: set[str] = set()
        if not config.api_key or not config.wallhaven_username:
            return 0, remote_files

        try:
            resp = await self.client.get(
                "https://wallhaven.cc/api/v1/collections",
                params={"apikey": config.api_key},
            )
            resp.raise_for_status()
            collections = resp.json().get("data", [])
        except Exception:
            log.warning("Failed to list Wallhaven collections", exc_info=True)
            return 0, remote_files

        if not collections:
            return 0, remote_files

        username = config.wallhaven_username
        synced = 0

        for col in collections:
            col_id = col.get("id")
            if not col_id:
                continue

            page = 1
            while True:
                try:
                    resp = await self.client.get(
                        f"https://wallhaven.cc/api/v1/collections/{username}/{col_id}",
                        params={"apikey": config.api_key, "page": page},
                    )
                    resp.raise_for_status()
                    body = resp.json()
                except Exception:
                    log.warning(
                        "Failed to fetch collection %s page %d", col_id, page, exc_info=True
                    )
                    break

                items = body.get("data", [])
                if not items:
                    break

                page_new = 0
                for item in items:
                    url = item.get("path", "")
                    if not url:
                        continue
                    filename = url.rsplit("/", 1)[-1]
                    remote_files.add(filename)
                    purity = item.get("purity", "sfw")
                    resolution = item.get("resolution", "1920x1080")
                    try:
                        w, h = (int(x) for x in resolution.split("x"))
                    except (ValueError, TypeError):
                        w, h = 1920, 1080
                    orientation = "portrait" if h > w else "landscape"

                    fav_dest = favorites_dir(config, purity, orientation) / filename
                    pool_path = pool_dir(config, purity, orientation) / filename

                    if fav_dest.exists():
                        continue

                    # Already in pool → move to favorites
                    if pool_path.exists():
                        fav_dest.parent.mkdir(parents=True, exist_ok=True)
                        pool_path.rename(fav_dest)
                        page_new += 1
                        log.info("sync: moved %s from pool to favorites", filename)
                        continue

                    # Download into favorites
                    fav_dest.parent.mkdir(parents=True, exist_ok=True)
                    if not await self.download_image(url, fav_dest):
                        continue

                    mon = next((m for m in config.monitors if m.orientation == orientation), None)
                    if mon and not resize_crop(fav_dest, mon.width, mon.height):
                        fav_dest.unlink(missing_ok=True)
                        continue

                    save_metadata(config, filename, item)
                    page_new += 1

                synced += page_new

                # All items on this page already existed → no need to check older pages
                if page_new == 0:
                    break

                last_page = body.get("meta", {}).get("last_page", 1)
                if page >= last_page:
                    break
                page += 1

        if synced:
            log.info("Synced %d wallpapers from Wallhaven collections", synced)
        return synced, remote_files


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
