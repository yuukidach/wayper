"""Regression tests for application-owned automatic rotation."""

from __future__ import annotations

import asyncio

from wayper.config import WayperConfig
from wayper.rotation import AutoRotationService


class _IdleRotationService(AutoRotationService):
    async def _run(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._wake = asyncio.Queue(maxsize=1)
        while not self._stopping:
            await self._sleep_or_wake(60)


def test_rotation_service_follows_application_lifecycle() -> None:
    async def exercise() -> None:
        service = _IdleRotationService()
        config = WayperConfig(interval=300)

        await service.start()
        await asyncio.sleep(0)
        assert service.snapshot(config) == {
            "auto_rotation": True,
            "rotation_paused": False,
        }

        service.pause()
        assert service.snapshot(config) == {
            "auto_rotation": False,
            "rotation_paused": True,
        }

        service.resume()
        assert service.snapshot(config) == {
            "auto_rotation": True,
            "rotation_paused": False,
        }

        await service.stop()
        assert not service.running

    asyncio.run(exercise())


def test_zero_interval_keeps_rotation_off() -> None:
    async def exercise() -> None:
        service = _IdleRotationService()
        config = WayperConfig(interval=0)
        await service.start()
        await asyncio.sleep(0)

        assert service.snapshot(config) == {
            "auto_rotation": False,
            "rotation_paused": False,
        }
        await service.stop()

    asyncio.run(exercise())
