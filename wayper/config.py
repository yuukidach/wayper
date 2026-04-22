"""Configuration loading and defaults."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from .util import atomic_write

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
    batch_size: int = 5
    exclude_tags: list[str] = field(default_factory=list)
    exclude_combos: list[list[str]] = field(default_factory=list)
    exclude_uploaders: list[str] = field(default_factory=list)


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
    wallhaven_username: str = ""
    wallhaven_password: str = ""
    proxy: str | None = None
    download_dir: Path = field(default_factory=lambda: Path.home() / "Pictures" / "wallpaper")
    interval: int = 300
    quota_mb: int = 4000
    blacklist_ttl_days: int = 30
    pause_on_lock: bool = True
    safe_mode: bool = False
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
    def history_file(self) -> Path:
        return self.download_dir / ".history"

    @property
    def trash_map_file(self) -> Path:
        return self.download_dir / ".trash_paths"

    @property
    def metadata_file(self) -> Path:
        return self.download_dir / ".metadata.json"

    @property
    def ai_history_file(self) -> Path:
        return self.download_dir / ".ai_history.json"

    @property
    def pid_file(self) -> Path:
        return CONFIG_DIR / "wayper.pid"


def compact_home(path: Path | str) -> str:
    """Replace home dir prefix with ~ for display/serialization."""
    s = str(path)
    home = str(Path.home())
    return "~" + s[len(home) :] if s.startswith(home) else s


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
    if config.wallhaven_username:
        lines.append(f'wallhaven_username = "{_esc(config.wallhaven_username)}"')
    if config.wallhaven_password:
        lines.append(f'wallhaven_password = "{_esc(config.wallhaven_password)}"')
    if config.proxy:
        lines.append(f'proxy = "{_esc(config.proxy)}"')
    lines.append(f'download_dir = "{_esc(dl)}"')
    lines.append(f"interval = {config.interval}")
    lines.append(f"quota_mb = {config.quota_mb}")
    lines.append(f"blacklist_ttl_days = {config.blacklist_ttl_days}")
    lines.append(f"pause_on_lock = {str(config.pause_on_lock).lower()}")
    lines.append(f"safe_mode = {str(config.safe_mode).lower()}")

    wh = config.wallhaven
    lines.append("")
    lines.append("[wallhaven]")
    lines.append(f'categories = "{wh.categories}"')
    lines.append(f'top_range = "{wh.top_range}"')
    lines.append(f'sorting = "{wh.sorting}"')
    lines.append(f"ai_art_filter = {wh.ai_art_filter}")
    lines.append(f"batch_size = {wh.batch_size}")
    if wh.exclude_tags:
        tags_str = ", ".join(f'"{_esc(t)}"' for t in wh.exclude_tags)
        lines.append(f"exclude_tags = [{tags_str}]")
    if wh.exclude_combos:
        combo_strs = []
        for combo in wh.exclude_combos:
            inner = ", ".join(f'"{_esc(t)}"' for t in combo)
            combo_strs.append(f"[{inner}]")
        lines.append(f"exclude_combos = [{', '.join(combo_strs)}]")
    if wh.exclude_uploaders:
        uploaders_str = ", ".join(f'"{_esc(u)}"' for u in wh.exclude_uploaders)
        lines.append(f"exclude_uploaders = [{uploaders_str}]")

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
    atomic_write(path, "\n".join(lines))


def load_config(path: Path | None = None) -> WayperConfig:
    """Load config from TOML file, falling back to defaults."""
    path = path or CONFIG_FILE
    raw: dict = {}
    if path.exists():
        raw = tomllib.loads(path.read_text())

    # Always auto-detect monitors; fall back to config if detection fails
    try:
        from .backend import detect_monitors

        monitors = detect_monitors()
    except Exception:
        monitors = [MonitorConfig(**m) for m in raw.get("monitors", [])]

    wallhaven_raw = raw.get("wallhaven", {})
    wallhaven = WallhavenConfig(
        categories=wallhaven_raw.get("categories", "111"),
        top_range=wallhaven_raw.get("top_range", "1M"),
        sorting=wallhaven_raw.get("sorting", "toplist"),
        ai_art_filter=wallhaven_raw.get("ai_art_filter", 0),
        batch_size=wallhaven_raw.get("batch_size", 5),
        exclude_tags=wallhaven_raw.get("exclude_tags", []),
        exclude_combos=wallhaven_raw.get("exclude_combos", []),
        exclude_uploaders=wallhaven_raw.get("exclude_uploaders", []),
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

    download_dir = (
        Path(raw["download_dir"]).expanduser()
        if "download_dir" in raw
        else (Path.home() / "Pictures" / "wallpaper")
    )

    return WayperConfig(
        api_key=raw.get("api_key", ""),
        wallhaven_username=raw.get("wallhaven_username", ""),
        wallhaven_password=raw.get("wallhaven_password", ""),
        proxy=raw.get("proxy"),
        download_dir=download_dir,
        interval=raw.get("interval", 300),
        quota_mb=raw.get("quota_mb", 4000),
        blacklist_ttl_days=raw.get("blacklist_ttl_days", 30),
        pause_on_lock=raw.get("pause_on_lock", True),
        safe_mode=raw.get("safe_mode", False),
        monitors=monitors,
        wallhaven=wallhaven,
        transition=transition,
        greeter=greeter,
    )
