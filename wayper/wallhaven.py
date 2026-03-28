"""Wallhaven API client."""

from __future__ import annotations

import asyncio
import random
from pathlib import Path

import httpx

from .config import WayperConfig
from .image import resize_crop, validate_image
from .pool import extract_tag_names, favorites_dir, is_blacklisted, pool_dir, save_metadata

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
            return {}

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
