"""Configuration loading and defaults."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "wayper"
CONFIG_FILE = CONFIG_DIR / "config.toml"


@dataclass
class MonitorConfig:
    name: str
    width: int
    height: int
    orientation: str  # "landscape" or "portrait"


@dataclass
class WallhavenConfig:
    categories: str = "111"
    top_range: str = "1M"
    sorting: str = "toplist"
    ai_art_filter: int = 0
    max_page: int = 15
    batch_size: int = 5


@dataclass
class TransitionConfig:
    type: str = "grow"
    duration: float = 0.5
    fps: int = 60


@dataclass
class GreeterConfig:
    image: Path | None = Path("/usr/share/backgrounds/greeter.jpg")
    interval: int = 12
    sudo_password: str | None = None


@dataclass
class WayperConfig:
    api_key: str = ""
    proxy: str | None = None
    download_dir: Path = field(default_factory=lambda: Path.home() / "Pictures" / "wallpaper")
    default_mode: str = "nsfw"
    interval: int = 300
    pool_target: int = 30
    quota_mb: int = 4000
    blacklist_ttl_days: int = 30
    monitors: list[MonitorConfig] = field(default_factory=list)
    wallhaven: WallhavenConfig = field(default_factory=WallhavenConfig)
    transition: TransitionConfig = field(default_factory=TransitionConfig)
    greeter: GreeterConfig = field(default_factory=GreeterConfig)

    @property
    def state_file(self) -> Path:
        return self.download_dir / ".mode"

    @property
    def blacklist_file(self) -> Path:
        return self.download_dir / ".blacklist"

    @property
    def undo_file(self) -> Path:
        return self.download_dir / ".undo"

    @property
    def trash_dir(self) -> Path:
        return self.download_dir / ".trash"

    @property
    def history_file(self) -> Path:
        return self.download_dir / ".history"

    @property
    def pid_file(self) -> Path:
        return CONFIG_DIR / "wayper.pid"


def load_config(path: Path | None = None) -> WayperConfig:
    """Load config from TOML file, falling back to defaults."""
    path = path or CONFIG_FILE
    raw: dict = {}
    if path.exists():
        raw = tomllib.loads(path.read_text())

    monitors = [
        MonitorConfig(**m) for m in raw.get("monitors", [])
    ]

    wallhaven_raw = raw.get("wallhaven", {})
    wallhaven = WallhavenConfig(
        categories=wallhaven_raw.get("categories", "111"),
        top_range=wallhaven_raw.get("top_range", "1M"),
        sorting=wallhaven_raw.get("sorting", "toplist"),
        ai_art_filter=wallhaven_raw.get("ai_art_filter", 0),
        max_page=wallhaven_raw.get("max_page", 15),
        batch_size=wallhaven_raw.get("batch_size", 5),
    )

    transition_raw = raw.get("transition", {})
    transition = TransitionConfig(
        type=transition_raw.get("type", "grow"),
        duration=transition_raw.get("duration", 0.5),
        fps=transition_raw.get("fps", 60),
    )

    greeter_raw = raw.get("greeter", {})
    greeter = GreeterConfig(
        image=Path(greeter_raw["image"]) if "image" in greeter_raw else None,
        interval=greeter_raw.get("interval", 12),
        sudo_password=greeter_raw.get("sudo_password"),
    )

    download_dir = Path(raw["download_dir"]).expanduser() if "download_dir" in raw else (
        Path.home() / "Pictures" / "wallpaper"
    )

    return WayperConfig(
        api_key=raw.get("api_key", ""),
        proxy=raw.get("proxy"),
        download_dir=download_dir,
        default_mode=raw.get("default_mode", "nsfw"),
        interval=raw.get("interval", 300),
        pool_target=raw.get("pool_target", 30),
        quota_mb=raw.get("quota_mb", 4000),
        blacklist_ttl_days=raw.get("blacklist_ttl_days", 30),
        monitors=monitors,
        wallhaven=wallhaven,
        transition=transition,
        greeter=greeter,
    )
