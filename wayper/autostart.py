"""Manage launching the Wayper GUI when the graphical session starts."""

from __future__ import annotations

import os
import plistlib
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .config import WayperConfig, save_config


class AutostartError(RuntimeError):
    """Raised when the host cannot apply the requested autostart state."""


@dataclass(frozen=True, slots=True)
class AutostartResult:
    enabled: bool
    unit: Path


def _systemd_user_dir() -> Path:
    return Path.home() / ".config" / "systemd" / "user"


def _service_path() -> Path:
    return _systemd_user_dir() / "wayper.service"


def _launch_agent_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / "io.github.yuukidach.wayper.plist"


def _windows_startup_path() -> Path:
    appdata = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    return appdata / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup" / "Wayper.cmd"


def _registration_path() -> Path:
    if sys.platform.startswith("linux"):
        return _service_path()
    if sys.platform == "darwin":
        return _launch_agent_path()
    if sys.platform == "win32":
        return _windows_startup_path()
    raise AutostartError(f"Autostart is not supported on {sys.platform}")


def _gui_executable() -> Path:
    executable = shutil.which("wayper-gui")
    if executable:
        return Path(executable).resolve()
    executable_dir = Path(sys.executable).resolve().parent
    invoked_entry = Path(sys.argv[0]).expanduser()
    candidates = [executable_dir / "wayper-gui"]
    if invoked_entry.name.lower() in {"wayper-gui", "wayper-gui.exe"}:
        candidates.insert(0, invoked_entry.resolve())
    if sys.platform == "win32":
        candidates.insert(0, executable_dir / "wayper-gui.exe")
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise AutostartError("Cannot find wayper-gui; install Wayper before enabling autostart")


def _systemd_quote(value: str) -> str:
    """Quote one systemd command-line argument."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _service_contents(executable: Path) -> str:
    return (
        "[Unit]\n"
        "Description=Wayper wallpaper manager\n"
        "PartOf=graphical-session.target\n"
        "After=graphical-session.target\n\n"
        "[Service]\n"
        "Type=simple\n"
        f"ExecStart={_systemd_quote(str(executable))} --hidden\n"
        "Restart=on-failure\n"
        "RestartSec=3\n\n"
        "[Install]\n"
        "WantedBy=graphical-session.target\n"
    )


def _launch_agent_contents(executable: Path) -> bytes:
    return plistlib.dumps(
        {
            "Label": "io.github.yuukidach.wayper",
            "ProgramArguments": [str(executable), "--hidden"],
            "RunAtLoad": True,
        },
        sort_keys=False,
    )


def _windows_startup_contents(executable: Path) -> str:
    escaped = str(executable).replace("%", "%%")
    return f'@start "" "{escaped}" --hidden\n'


def _systemctl(*arguments: str) -> None:
    if not shutil.which("systemctl"):
        raise AutostartError("systemctl is required to manage Wayper autostart")
    result = subprocess.run(
        ["systemctl", "--user", *arguments],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or "systemctl failed"
        raise AutostartError(detail)


def set_autostart(
    config: WayperConfig,
    enabled: bool,
    *,
    config_path: Path | None = None,
) -> AutostartResult:
    """Apply and persist autostart using the platform's login mechanism."""
    unit = _registration_path()
    if enabled:
        previous = unit.read_bytes() if unit.is_file() else None
        unit.parent.mkdir(parents=True, exist_ok=True)
        try:
            executable = _gui_executable()
            if sys.platform.startswith("linux"):
                unit.write_text(_service_contents(executable), encoding="utf-8")
                _systemctl("daemon-reload")
                _systemctl("enable", unit.name)
            elif sys.platform == "darwin":
                unit.write_bytes(_launch_agent_contents(executable))
            else:
                unit.write_text(
                    _windows_startup_contents(executable),
                    encoding="utf-8",
                    newline="\r\n",
                )
        except Exception as error:
            if previous is None:
                unit.unlink(missing_ok=True)
            else:
                unit.write_bytes(previous)
            if isinstance(error, AutostartError):
                raise
            raise AutostartError(str(error)) from error
    else:
        try:
            if sys.platform.startswith("linux") and unit.exists():
                _systemctl("disable", unit.name)
            unit.unlink(missing_ok=True)
            if sys.platform.startswith("linux"):
                _systemctl("daemon-reload")
        except Exception as error:
            if isinstance(error, AutostartError):
                raise
            raise AutostartError(str(error)) from error

    config.autostart = enabled
    save_config(config, config_path)
    return AutostartResult(enabled=enabled, unit=unit)


def ensure_default_autostart(config: WayperConfig) -> None:
    """Install the default-on service on the first manual GUI launch."""
    if config.autostart and not _registration_path().is_file():
        set_autostart(config, True)
