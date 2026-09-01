from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from wayper.image import generate_thumbnail


def _write_source(path: Path, *, size: tuple[int, int] = (2400, 1600)) -> None:
    Image.new("RGB", size, color=(50, 80, 120)).save(path, format="JPEG")


def test_generate_thumbnail_coalesces_concurrent_first_requests(tmp_path: Path) -> None:
    source = tmp_path / "source.jpg"
    cache = tmp_path / "cache"
    _write_source(source)

    original_open = Image.open
    opens = 0

    def counted_open(*args, **kwargs):
        nonlocal opens
        opens += 1
        return original_open(*args, **kwargs)

    with (
        patch("wayper.image.Image.open", side_effect=counted_open),
        ThreadPoolExecutor(max_workers=4) as executor,
    ):
        results = list(executor.map(lambda _: generate_thumbnail(source, cache, 400), range(4)))

    assert opens == 1
    assert len(set(results)) == 1
    thumbnail = results[0]
    assert thumbnail is not None and thumbnail.is_file()
    assert not list(cache.glob("*.tmp"))
    with Image.open(thumbnail) as image:
        assert image.width == 400


def test_generate_thumbnail_reuses_fresh_atomic_derivative(tmp_path: Path) -> None:
    source = tmp_path / "source.jpg"
    cache = tmp_path / "cache"
    _write_source(source)

    first = generate_thumbnail(source, cache, max_width=400)
    assert first is not None

    with patch("wayper.image._atomic_jpeg_save") as save:
        second = generate_thumbnail(source, cache, max_width=400)

    assert second == first
    save.assert_not_called()
