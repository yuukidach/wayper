"""HTTP request and response schemas for the desktop backend."""

from __future__ import annotations

from pydantic import BaseModel, Field


class StatusResponse(BaseModel):
    running: bool
    pid: int | None = None
    pool_count: int = 0
    favorites_count: int = 0
    blocklist_count: int = 0
    recoverable_count: int = 0
    mode: list[str] = Field(default_factory=lambda: ["sfw"])


class ImageItem(BaseModel):
    path: str
    name: str
    is_favorite: bool = False


class ImagePage(BaseModel):
    items: list[ImageItem]
    total: int
    next_offset: int | None = None


class BlocklistEntry(BaseModel):
    filename: str
    timestamp: int
    recoverable: bool


class BlocklistResponse(BaseModel):
    entries: list[BlocklistEntry]
    total: int
    recoverable_count: int
    images: list[ImageItem] = Field(default_factory=list)


class MonitorInfo(BaseModel):
    name: str
    orientation: str
    current_image: str | None = None


class SetWallpaperRequest(BaseModel):
    monitor: str
    image_path: str


class ActionRequest(BaseModel):
    image_path: str
    monitor: str | None = None
    # This is a context label; the server recomputes candidate evidence.
    preference_context: str | None = None


class PreferenceFeedbackRequest(BaseModel):
    path: str
    action: str


class WallhavenConfigModel(BaseModel):
    categories: str
    top_range: str
    sorting: str
    ai_art_filter: int
    batch_size: int = 5
    min_favorites: int = 0
    exclude_tags: list[str]
    exclude_combos: list[list[str]] = Field(default_factory=list)
    exclude_uploaders: list[str] = Field(default_factory=list)


class UpdateCheckResponse(BaseModel):
    current_version: str
    latest_version: str | None
    update_available: bool
    release_url: str
    release_name: str | None = None
    published_at: str | None = None
    checked_at: str | None = None
    error: str | None = None


class ConfigResponse(BaseModel):
    download_dir: str
    interval_min: int
    mode: list[str]
    quota_mb: int
    proxy: str
    pause_on_lock: bool
    safe_mode: bool
    has_api_key: bool
    has_wh_password: bool
    wallhaven_username: str
    blacklist_ttl_days: int
    wallhaven: WallhavenConfigModel


class SetModeRequest(BaseModel):
    mode: str | None = None
    purities: list[str] | None = None


class UnblockRequest(BaseModel):
    filename: str
