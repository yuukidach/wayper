"""Linux greeter image installation shared by manual selection and rotation."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

from ..config import GreeterConfig


class GreeterError(Exception):
    """A greeter image could not be installed."""


def install_greeter_image(config: GreeterConfig, image: Path) -> None:
    """Copy a validated image, escalating only when the target requires it."""
    if sys.platform != "linux":
        raise GreeterError("Login backgrounds are only supported on Linux")
    if config.image is None:
        raise GreeterError("Configure [greeter].image in config.toml first")
    try:
        with Image.open(image) as source:
            source.verify()
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        raise GreeterError("The selected file is not a readable image") from error

    try:
        if image.resolve() == config.image.resolve():
            return
        if config.image.is_dir():
            raise GreeterError("The greeter target must be a file, not a directory")
        try:
            shutil.copyfile(image, config.image)
            config.image.chmod(0o644)
            return
        except PermissionError:
            pass

        password = config.sudo_password
        command = ["sudo", "-S", "-p", ""] if password else ["sudo", "-n"]
        command += ["--", "install", "-m", "644", "-T", "--", str(image), str(config.image)]
        subprocess.run(
            command,
            input=password.encode() if password else b"",
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
        )
    except subprocess.TimeoutExpired as error:
        raise GreeterError("Timed out updating the login background") from error
    except (OSError, subprocess.CalledProcessError) as error:
        raise GreeterError(
            "Could not copy the login background; check the greeter target and sudo permissions"
        ) from error
