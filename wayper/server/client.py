"""Fast CLI hand-off to the running desktop backend."""

from __future__ import annotations

import json
from http.client import HTTPConnection, HTTPException
from pathlib import Path

from wayper.config import CONFIG_DIR, WayperConfig
from wayper.core import CoreResult


def try_control_action(
    config: WayperConfig, action: str, *, open_url: bool = False
) -> CoreResult | None:
    """Return None only before submission, when local execution is safe.

    A failed response after POST may still have changed the wallpaper. Never
    retry that operation locally (especially a ban of the *next* wallpaper).
    The service owns background cloud sync after the short-lived CLI exits.
    """
    try:
        port = int((CONFIG_DIR / "api.port").read_text().strip())
        if not 0 < port < 65536:
            return None
    except (OSError, ValueError):
        return None

    connection = HTTPConnection("127.0.0.1", port, timeout=0.3)
    try:
        try:
            connection.request("GET", "/api/control")
            response = connection.getresponse()
            payload = json.loads(response.read())
            if (
                response.status != 200
                or payload.get("protocol") != "wayper-control-v1"
                or payload.get("download_dir") != str(config.download_dir.resolve())
            ):
                return None
        except (OSError, HTTPException, ValueError, AttributeError):
            return None

        # Use a fresh socket with an action timeout; probing must stay cheap.
        connection.close()
        connection = HTTPConnection("127.0.0.1", port, timeout=30)
        try:
            connection.request(
                "POST",
                f"/api/control/{action}",
                json.dumps({"open_url": open_url}),
                {"Content-Type": "application/json"},
            )
            response = connection.getresponse()
            payload = json.loads(response.read())
            if response.status != 200:
                return CoreResult(action=action, ok=False, error=str(payload.get("detail")))
            return CoreResult(
                action=action,
                monitor=payload.get("monitor"),
                image=Path(payload["image"]) if payload.get("image") else None,
                status=None if payload.get("status") == "ok" else payload.get("status"),
                extra={"remote_sync": payload.get("remote_sync")},
            )
        except (OSError, HTTPException, ValueError, AttributeError, TypeError) as error:
            return CoreResult(
                action=action,
                ok=False,
                error=f"Could not confirm {action}: {error}. Check the current wallpaper.",
            )
    finally:
        connection.close()
