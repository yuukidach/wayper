"""Wallhaven API client."""

from __future__ import annotations

import asyncio
import logging
import random
from pathlib import Path

import httpx

from .config import WayperConfig, normalize_filter_strategy
from .image import validate_image
from .pool import extract_tag_names, favorites_dir, is_blacklisted, pool_dir, save_metadata
from .tags import normalize_tag

log = logging.getLogger("wayper.wallhaven")

SEARCH_URL = "https://wallhaven.cc/api/v1/search"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def wallhaven_id(name: str) -> str:
    """Extract Wallhaven ID from a filename (with or without extension)."""
    stem = name.rsplit(".", 1)[0] if "." in name else name
    return stem.split("-", 1)[-1] if "-" in stem else stem


def wallhaven_url(img_path: Path) -> str:
    """Build Wallhaven URL from image path."""
    return f"https://wallhaven.cc/w/{wallhaven_id(img_path.name)}"


def _item_favorites(item: dict) -> int:
    """Return Wallhaven favorite count from an API item."""
    try:
        return max(0, int(item.get("favorites", 0) or 0))
    except (TypeError, ValueError):
        return 0


_ModelFilterContext = tuple[object | None, bool, dict[str, object]]


class WallhavenClient:
    def __init__(self, config: WayperConfig):
        self.config = config
        self._local_exclude_tags: list[str] = []
        self._cloud_tags: set[str] = set()
        self._model_score_lock = asyncio.Lock()
        request_headers = {"User-Agent": USER_AGENT}
        if config.api_key:
            request_headers["X-API-Key"] = config.api_key
        self.client = httpx.AsyncClient(
            proxy=config.proxy,
            timeout=httpx.Timeout(30, connect=10),
            headers=request_headers,
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
        if not self._rules_enabled:
            self._local_exclude_tags = []
            return [], []
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

    @property
    def _filter_strategy(self) -> str:
        return normalize_filter_strategy(self.config.wallhaven.filter_strategy)

    @property
    def _rules_enabled(self) -> bool:
        return self._filter_strategy in {"rules", "rules+model"}

    @property
    def _model_enabled(self) -> bool:
        return self._filter_strategy in {"model", "rules+model"}

    def _model_filter_context(self) -> _ModelFilterContext:
        """Load one model context that concurrent download lanes can share."""
        if not self._model_enabled:
            return None, False, {}
        try:
            from .preference_model import auto_filter_status, load_preference_model

            model = load_preference_model(self.config.preference_model_file)
            status = auto_filter_status(self.config, model)
            return model, bool(status.get("ready")), status
        except Exception:
            log.warning("Could not load the model filter; failing open", exc_info=True)
            return None, False, {}

    def _download_sorting(self) -> str:
        """Return sorting used for automatic downloads.

        Wallhaven has no minimum-favorites search parameter. Sorting by favorites
        when the threshold is enabled keeps the API URL aligned with the filter
        and avoids random pages that are mostly below the configured cutoff.
        """
        if self.config.wallhaven.min_favorites > 0:
            return "favorites"
        return self.config.wallhaven.sorting

    def _matches_local_exclude(self, tag_names: list[str]) -> bool:
        """Return True if any tag matches overflow exclude_tags filtered locally."""
        if not self._local_exclude_tags:
            return False
        normalized = {normalize_tag(t) for t in tag_names if normalize_tag(t)}
        return any(normalize_tag(t) in normalized for t in self._local_exclude_tags)

    def _matches_exclude_combo(self, tag_names: list[str]) -> bool:
        """Return True if tag_names matches any exclude combo rule (case-insensitive)."""
        tag_set = {normalize_tag(t) for t in tag_names if normalize_tag(t)}
        return any(
            all(normalize_tag(t) in tag_set for t in combo)
            for combo in self.config.wallhaven.exclude_combos
        )

    async def search(self, orientations: set[str], purities: set[str]) -> list[dict]:
        """Return one search result spanning the requested orientations and purities."""
        orientation_query = ",".join(sorted(orientations))
        purity_query = "".join(
            "1" if value in purities else "0" for value in ("sfw", "sketchy", "nsfw")
        )
        params = {
            "categories": self.config.wallhaven.categories,
            "purity": purity_query,
            "topRange": self.config.wallhaven.top_range,
            "sorting": self._download_sorting(),
            "order": "desc",
            "ai_art_filter": self.config.wallhaven.ai_art_filter,
            "ratios": orientation_query,
            "page": 1,
        }
        exclude_q = self._exclude_query()
        if exclude_q:
            params["q"] = exclude_q
        try:
            # Probe page 1 to learn last_page from meta
            resp = await self.client.get(SEARCH_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
            last_page = data.get("meta", {}).get("last_page", 1)
            if last_page <= 1:
                return data.get("data", [])

            if self.config.wallhaven.min_favorites > 0:
                max_page = await self._max_favorites_page(params, last_page, data.get("data", []))
                if max_page < 1:
                    return []
                last_page = max_page

            page_one = data.get("data", [])
            pages_tried: set[int] = set()
            attempts = min(5, last_page)
            for _ in range(attempts):
                page = random.randint(1, last_page)
                if page in pages_tried:
                    continue
                pages_tried.add(page)
                if page == 1:
                    return page_one
                items = await self._search_page(params, page)
                if items is not None:
                    return items

            log.info(
                "Wallhaven search falling back to page 1 after page fetch failures "
                "(orientation=%s, purity=%s)",
                orientation_query,
                ",".join(sorted(purities)),
            )
            return page_one
        except Exception:
            log.warning(
                "Wallhaven search failed (orientation=%s, purity=%s)",
                orientation_query,
                ",".join(sorted(purities)),
                exc_info=True,
            )
            return []

    async def _search_page(self, params: dict, page: int) -> list[dict] | None:
        """Fetch a search page, returning None when Wallhaven rejects the page."""
        page_params = dict(params)
        page_params["page"] = page
        try:
            resp = await self.client.get(SEARCH_URL, params=page_params)
            resp.raise_for_status()
            return resp.json().get("data", [])
        except Exception:
            log.debug("Wallhaven search page %d failed", page, exc_info=True)
            return None

    async def _max_favorites_page(self, params: dict, last_page: int, page_one: list[dict]) -> int:
        """Find the last sorted-by-favorites page that may contain eligible items."""
        min_favorites = self.config.wallhaven.min_favorites
        if any(_item_favorites(item) >= min_favorites for item in page_one):
            low = 1
        else:
            return 0

        high = last_page
        page_cache: dict[int, list[dict] | None] = {1: page_one}

        async def page_items(page: int) -> list[dict] | None:
            if page not in page_cache:
                page_cache[page] = await self._search_page(params, page)
            return page_cache[page]

        while low < high:
            mid = (low + high + 1) // 2
            items = await page_items(mid)
            if items is not None and any(_item_favorites(item) >= min_favorites for item in items):
                low = mid
            else:
                high = mid - 1
        return low

    async def wallpaper_info(self, wallpaper_id: str, *, retries: int = 2) -> dict:
        """Fetch complete wallpaper details, retrying transient metadata failures."""
        if not wallpaper_id:
            return {}
        for attempt in range(max(0, retries) + 1):
            try:
                resp = await self.client.get(f"https://wallhaven.cc/api/v1/w/{wallpaper_id}")
                resp.raise_for_status()
                data = resp.json().get("data", {})
                return data if isinstance(data, dict) else {}
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                if status != 429 and 400 <= status < 500:
                    log.info(
                        "Wallpaper metadata unavailable for %s (HTTP %d)",
                        wallpaper_id,
                        status,
                    )
                    return {}
                error_name = f"HTTP {status}"
            except Exception as exc:
                error_name = type(exc).__name__
            if attempt >= max(0, retries):
                log.warning(
                    "Failed to fetch wallpaper info for %s after %d attempts (%s)",
                    wallpaper_id,
                    attempt + 1,
                    error_name,
                )
                return {}
            await asyncio.sleep(0.5 * (2**attempt))
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

    async def download_for(
        self,
        orientations: set[str],
        modes: set[str],
        *,
        model_filter_context: _ModelFilterContext | None = None,
    ) -> None:
        """Download one global batch for the requested screen and purity scope."""
        config = self.config

        # Loading the model once per batch keeps the normal rules-only path
        # cheap. Model hits go to a recoverable review queue, so a current model
        # can participate without passing the unattended-deletion safety gate.
        model, model_filter_ready, model_filter_status = (
            model_filter_context
            if model_filter_context is not None
            else await asyncio.to_thread(self._model_filter_context)
        )
        if self._model_enabled and not model_filter_ready:
            log.info(
                "Model filter selected for %s/%s but no compatible model is ready; "
                "downloads remain eligible until the model is trained",
                ",".join(sorted(modes)),
                ",".join(sorted(orientations)),
            )

        items = await self.search(orientations, modes)
        skipped = {
            "dup": 0,
            "fav": 0,
            "blacklist": 0,
            "uploader": 0,
            "combo": 0,
            "local_tag": 0,
            "model": 0,
            "metadata": 0,
            "min_favorites": 0,
            "fail": 0,
        }
        sampled = 0
        downloaded = 0

        if items:
            sample = random.sample(items, min(config.wallhaven.batch_size, len(items)))
            sampled = len(sample)
            candidates: list[tuple[str, str, dict, Path]] = []
            for item in sample:
                url = item.get("path", "")
                if not url:
                    continue
                filename = url.rsplit("/", 1)[-1]
                mode = item.get("purity")
                orientation = (
                    "portrait"
                    if item.get("dimension_y", 0) > item.get("dimension_x", 0)
                    else "landscape"
                )
                if mode not in modes or orientation not in orientations:
                    continue
                dest = pool_dir(config, mode, orientation) / filename
                fav_dest = favorites_dir(config, mode, orientation) / filename

                if dest.exists():
                    skipped["dup"] += 1
                    continue
                if fav_dest.exists():
                    skipped["fav"] += 1
                    continue
                if is_blacklisted(config, filename):
                    skipped["blacklist"] += 1
                    continue
                if _item_favorites(item) < config.wallhaven.min_favorites:
                    skipped["min_favorites"] += 1
                    continue

                candidates.append((filename, url, item, dest))

            if candidates:
                # Fetch full details (includes tags) before downloading images
                details = await asyncio.gather(
                    *(self.wallpaper_info(item.get("id", "")) for _, _, item, _ in candidates)
                )

                excluded_uploaders_lower = {
                    u.lower() for u in self.config.wallhaven.exclude_uploaders
                }
                for (filename, url, item, dest), detail in zip(candidates, details):
                    if not detail:
                        # Search listings omit tags and uploader details. An
                        # incomplete record cannot be filtered or learned from
                        # safely, so leave it for a later download cycle.
                        skipped["metadata"] += 1
                        continue
                    item = {**item, **detail}
                    mode = dest.parent.parent.name
                    orientation = dest.parent.name

                    tag_names = extract_tag_names(item.get("tags", []))
                    if self._rules_enabled:
                        # Skip excluded uploaders (local-only — Wallhaven API
                        # has no uploader filter).
                        uploader = item.get("uploader", "")
                        if isinstance(uploader, dict):
                            uploader = uploader.get("username", "")
                        if uploader and uploader.lower() in excluded_uploaders_lower:
                            skipped["uploader"] += 1
                            continue

                        if self._matches_exclude_combo(tag_names):
                            skipped["combo"] += 1
                            continue
                        if self._matches_local_exclude(tag_names):
                            skipped["local_tag"] += 1
                            continue

                    if model_filter_ready and model is not None:
                        try:
                            from .model_review import queue_model_review_item
                            from .preference_model import (
                                auto_filter_prediction,
                                preference_decision_score,
                            )

                            async with self._model_score_lock:
                                model_hit, prediction = await asyncio.to_thread(
                                    auto_filter_prediction,
                                    model,
                                    item,
                                )
                        except Exception:
                            log.warning(
                                "Model filter scoring failed for %s; keeping download eligible",
                                filename,
                                exc_info=True,
                            )
                            model_hit = False
                            prediction = None
                        if model_hit and prediction is not None:
                            review_dir = config.model_review_dir / mode / orientation
                            review_dir.mkdir(parents=True, exist_ok=True)
                            review_dest = review_dir / filename
                            if review_dest.exists():
                                skipped["dup"] += 1
                                continue
                            if not await self.download_image(url, review_dest):
                                skipped["fail"] += 1
                                continue
                            save_metadata(config, filename, item, complete=True)
                            try:
                                prediction_payload = prediction.to_dict()
                                decision_score = preference_decision_score(
                                    model,
                                    prediction,
                                )
                                prediction_payload.update(
                                    {
                                        "decision_score": decision_score,
                                        "threshold": model_filter_status.get("threshold"),
                                        "threshold_kind": model_filter_status.get("threshold_kind"),
                                        "schema_version": model.schema_version,
                                        "trained_at": model.trained_at,
                                    }
                                )
                                queue_model_review_item(
                                    config,
                                    review_dest,
                                    purity=mode,
                                    orientation=orientation,
                                    prediction=prediction_payload,
                                    strategy=self._filter_strategy,
                                )
                            except Exception:
                                review_dest.unlink(missing_ok=True)
                                skipped["fail"] += 1
                                log.warning(
                                    "Could not register model review item %s",
                                    filename,
                                    exc_info=True,
                                )
                                continue
                            skipped["model"] += 1
                            continue

                    if not await self.download_image(url, dest):
                        skipped["fail"] += 1
                        continue

                    save_metadata(config, filename, item, complete=True)
                    downloaded += 1

        log.info(
            "Download[%(mode)s/%(orient)s] results=%(results)d sampled=%(sampled)d "
            "skipped(dup=%(dup)d,fav=%(fav)d,blacklist=%(blacklist)d,"
            "uploader=%(uploader)d,combo=%(combo)d,local_tag=%(local_tag)d,"
            "model=%(model)d,metadata=%(metadata)d,min_favorites=%(min_favorites)d,"
            "fail=%(fail)d) "
            "downloaded=%(downloaded)d",
            {
                "mode": ",".join(sorted(modes)),
                "orient": ",".join(sorted(orientations)),
                "results": len(items),
                "sampled": sampled,
                "downloaded": downloaded,
                **skipped,
            },
        )

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
                        params={"page": page},
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
                    detail = await self.wallpaper_info(str(item.get("id", "")))
                    if not detail:
                        log.warning("Skipping favorite %s without complete metadata", filename)
                        continue
                    item = {**item, **detail}
                    url = str(item.get("path", url))
                    fav_dest.parent.mkdir(parents=True, exist_ok=True)
                    if not await self.download_image(url, fav_dest):
                        continue

                    save_metadata(config, filename, item, complete=True)
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
