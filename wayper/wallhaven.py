"""Wallhaven API client."""

from __future__ import annotations

import asyncio
import logging
import random
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
        self._local_exclude_tags: list[str] = []
        self._cloud_tags: set[str] = set()
        self.client = httpx.AsyncClient(
            proxy=config.proxy,
            timeout=httpx.Timeout(30, connect=10),
        )

    async def close(self) -> None:
        await self.client.aclose()

    def refresh_cloud_tags(self) -> None:
        """Fetch cloud tag_blacklist and cache it."""
        from .wallhaven_web import fetch_cloud_tags

        self._cloud_tags = {t.lower() for t in fetch_cloud_tags(self.config)}
        if self._cloud_tags:
            log.info("Loaded %d cloud tags from Wallhaven account", len(self._cloud_tags))

    def _split_exclude_tags(self) -> tuple[list[str], list[str]]:
        """Split exclude_tags into (api_tags, local_tags) based on URL length budget.

        Tags already on Wallhaven's cloud tag_blacklist are skipped entirely
        (they're filtered server-side).
        """
        tags = [t for t in self.config.wallhaven.exclude_tags if t.lower() not in self._cloud_tags]
        if not tags:
            return [], []
        max_len = 1500
        api_tags: list[str] = []
        current_len = 0
        for i, tag in enumerate(tags):
            fragment = f'-"{tag}"' if " " in tag else f"-{tag}"
            added = len(fragment) + (1 if api_tags else 0)
            if current_len + added > max_len:
                local = tags[i:]
                log.warning(
                    "exclude_tags query too long (%d chars); %d/%d tags will be filtered locally",
                    current_len,
                    len(local),
                    len(tags),
                )
                return api_tags, local
            api_tags.append(tag)
            current_len += added
        return api_tags, []

    def _exclude_query(self) -> str:
        """Build exclusion query fragment from exclude_tags config."""
        api_tags, self._local_exclude_tags = self._split_exclude_tags()
        if not api_tags:
            return ""
        return " ".join(f'-"{t}"' if " " in t else f"-{t}" for t in api_tags)

    def _matches_local_exclude(self, tag_names: list[str]) -> bool:
        """Return True if any tag matches overflow exclude_tags filtered locally."""
        if not self._local_exclude_tags:
            return False
        lower = {t.lower() for t in tag_names}
        return any(t.lower() in lower for t in self._local_exclude_tags)

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
        candidates: list[tuple[str, str, dict, Path]] = []  # (filename, url, item, dest)
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

            candidates.append((filename, url, item, dest))

        if not candidates:
            return

        # Fetch full details (includes tags) before downloading images
        details = await asyncio.gather(
            *(self.wallpaper_info(item.get("id", "")) for _, _, item, _ in candidates)
        )

        excluded_uploaders_lower = {u.lower() for u in self.config.wallhaven.exclude_uploaders}
        for (filename, url, item, dest), detail in zip(candidates, details):
            if detail:
                item = {**item, **detail}

            # Skip excluded uploaders (local-only — Wallhaven API has no uploader filter)
            uploader = item.get("uploader", "")
            if isinstance(uploader, dict):
                uploader = uploader.get("username", "")
            if uploader and uploader.lower() in excluded_uploaders_lower:
                continue

            tag_names = extract_tag_names(item.get("tags", []))
            if self._matches_exclude_combo(tag_names) or self._matches_local_exclude(tag_names):
                continue

            if not await self.download_image(url, dest):
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
