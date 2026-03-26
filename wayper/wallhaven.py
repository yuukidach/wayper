"""Wallhaven API client."""

from __future__ import annotations

import random
from pathlib import Path

import httpx

from .config import WayperConfig
from .image import resize_crop, validate_image
from .pool import favorites_dir, is_blacklisted, pool_dir, save_metadata

SEARCH_URL = "https://wallhaven.cc/api/v1/search"

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
        try:
            resp = await self.client.get(SEARCH_URL, params=params)
            resp.raise_for_status()
            return resp.json().get("data", [])
        except Exception:
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
        if query:
            params["q"] = query
        params.update(overrides)
        try:
            resp = await self.client.get(SEARCH_URL, params=params)
            resp.raise_for_status()
            return resp.json().get("data", [])
        except Exception:
            return []

    async def download_image(self, url: str, dest: Path) -> bool:
        """Download a single image. Returns True on success."""
        tmp = dest.with_name(f".dl_{dest.name}")
        try:
            async with self.client.stream("GET", url) as resp:
                resp.raise_for_status()
                with open(tmp, "wb") as f:
                    async for chunk in resp.aiter_bytes(8192):
                        f.write(chunk)
            # Validate
            if not validate_image(tmp):
                tmp.unlink(missing_ok=True)
                return False
            tmp.rename(dest)
            return True
        except Exception:
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

            save_metadata(config, filename, item)

            # Resize to monitor resolution
            if mon:
                if not resize_crop(dest, mon.width, mon.height):
                    dest.unlink(missing_ok=True)
