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


NO_TRANSITION = TransitionConfig(type="none", duration=0, fps=60)


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


def compact_home(path: Path | str) -> str:
    """Replace home dir prefix with ~ for display/serialization."""
    s = str(path)
    home = str(Path.home())
    return "~" + s[len(home):] if s.startswith(home) else s


def _esc(s: str) -> str:
    """Escape a string for TOML double-quoted values."""
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def save_config(config: WayperConfig, path: Path | None = None) -> None:
    """Serialize config back to TOML and write to disk."""
    path = path or CONFIG_FILE
    path.parent.mkdir(parents=True, exist_ok=True)

    dl = compact_home(config.download_dir)
    lines: list[str] = []

    lines.append(f'api_key = "{_esc(config.api_key)}"')
    if config.proxy:
        lines.append(f'proxy = "{_esc(config.proxy)}"')
    lines.append(f'download_dir = "{_esc(dl)}"')
    lines.append(f'default_mode = "{config.default_mode}"')
    lines.append(f"interval = {config.interval}")
    lines.append(f"pool_target = {config.pool_target}")
    lines.append(f"quota_mb = {config.quota_mb}")
    lines.append(f"blacklist_ttl_days = {config.blacklist_ttl_days}")

    for m in config.monitors:
        lines.append("")
        lines.append("[[monitors]]")
        lines.append(f'name = "{_esc(m.name)}"')
        lines.append(f"width = {m.width}")
        lines.append(f"height = {m.height}")
        lines.append(f'orientation = "{m.orientation}"')

    wh = config.wallhaven
    lines.append("")
    lines.append("[wallhaven]")
    lines.append(f'categories = "{wh.categories}"')
    lines.append(f'top_range = "{wh.top_range}"')
    lines.append(f'sorting = "{wh.sorting}"')
    lines.append(f"ai_art_filter = {wh.ai_art_filter}")
    lines.append(f"max_page = {wh.max_page}")
    lines.append(f"batch_size = {wh.batch_size}")

    tr = config.transition
    lines.append("")
    lines.append("[transition]")
    lines.append(f'type = "{tr.type}"')
    lines.append(f"duration = {tr.duration}")
    lines.append(f"fps = {tr.fps}")

    gr = config.greeter
    if gr.image:
        lines.append("")
        lines.append("[greeter]")
        lines.append(f'image = "{_esc(str(gr.image))}"')
        lines.append(f"interval = {gr.interval}")
        if gr.sudo_password:
            lines.append(f'sudo_password = "{_esc(gr.sudo_password)}"')

    lines.append("")
    path.write_text("\n".join(lines))


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
