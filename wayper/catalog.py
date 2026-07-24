"""In-memory view of wallpaper metadata used by queries and recommendations."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Iterable, Iterator, Mapping
from dataclasses import dataclass

from .pool import ImageMetadata
from .tags import normalize_tag, normalized_values, tag_items

# A favorite is already counted as kept and contributes this additional cost.
FAVORITE_WEIGHT = 3
KEPT_WEIGHT = 5


def weighted_precision(banned: int, kept: int, favorites: int) -> float:
    total = banned + kept + FAVORITE_WEIGHT * favorites
    return banned / total if total else 0.0


def net_benefit(banned: int, kept: int, favorites: int) -> float:
    return banned - KEPT_WEIGHT * kept - FAVORITE_WEIGHT * favorites


@dataclass(frozen=True, slots=True)
class CatalogImage:
    filename: str
    metadata: ImageMetadata
    tags: frozenset[str]
    uploader: str
    purity: str
    banned: bool
    favorite: bool
    # Keep the source order for stable counters and suggestions while using
    # ``tags`` as the compact membership index for matching.
    tag_order: tuple[str, ...] = ()

    @property
    def ordered_tags(self) -> tuple[str, ...]:
        return self.tag_order or tuple(sorted(self.tags))


@dataclass(frozen=True, slots=True)
class MatchStats:
    banned: int = 0
    kept: int = 0
    favorites: int = 0
    banned_files: frozenset[str] = frozenset()

    @property
    def precision(self) -> float:
        return weighted_precision(self.banned, self.kept, self.favorites)

    @property
    def net_benefit(self) -> float:
        return net_benefit(self.banned, self.kept, self.favorites)

    def to_dict(self, *, include_files: bool = False) -> dict[str, object]:
        result: dict[str, object] = {
            "banned": self.banned,
            "kept": self.kept,
            "favorites": self.favorites,
            "precision": round(self.precision, 3),
            "net_benefit": round(self.net_benefit, 1),
        }
        if include_files:
            result["banned_files"] = set(self.banned_files)
        return result


@dataclass(frozen=True, slots=True)
class CatalogSearchResult:
    matches: tuple[str, ...]
    tag_suggestions: tuple[str, ...] = ()
    uploader_suggestions: tuple[str, ...] = ()


class ImageCatalog:
    """Normalize metadata once and expose the common query operations."""

    def __init__(
        self,
        metadata: Mapping[str, ImageMetadata],
        blacklisted: Iterable[str] = (),
        favorites: Iterable[str] = (),
        *,
        purities: Iterable[str] | None = None,
    ) -> None:
        banned_names = frozenset(
            (blacklisted,) if isinstance(blacklisted, str) else (blacklisted or ())
        )
        favorite_names = frozenset(
            (favorites,) if isinstance(favorites, str) else (favorites or ())
        )
        if isinstance(purities, str):
            purities = (purities,)
        purity_filter = None
        if purities is not None:
            values = frozenset(
                str(value).strip().casefold() for value in purities if str(value).strip()
            )
            # An empty filter is equivalent to no filter.  This keeps callers
            # that build an optional list incrementally from accidentally
            # hiding the complete catalog.
            purity_filter = values or None
        self._records: dict[str, CatalogImage] = {}
        self._tag_display: dict[str, str] = {}
        self._uploader_display: dict[str, str] = {}

        for filename, raw_metadata in metadata.items():
            if not isinstance(raw_metadata, Mapping):
                # A partially written metadata file should not take search or
                # status endpoints down; the loader normally supplies dicts,
                # but old files can contain a stray null value.
                continue
            purity = str(raw_metadata.get("purity", "sfw")).casefold()
            if purity_filter is not None and purity not in purity_filter:
                continue
            items = tag_items(raw_metadata.get("tags", []))
            for key, display in items:
                self._tag_display.setdefault(key, display)
            uploader_display = str(raw_metadata.get("uploader", "")).strip()
            uploader = uploader_display.casefold()
            if uploader:
                self._uploader_display.setdefault(uploader, uploader_display)
            self._records[filename] = CatalogImage(
                filename=filename,
                metadata=raw_metadata,
                tags=frozenset(key for key, _ in items),
                uploader=uploader,
                purity=purity,
                banned=filename in banned_names,
                favorite=filename in favorite_names and filename not in banned_names,
                tag_order=tuple(key for key, _ in items),
            )

    def __len__(self) -> int:
        return len(self._records)

    def __iter__(self) -> Iterator[CatalogImage]:
        return iter(self._records.values())

    def get(self, filename: str) -> CatalogImage | None:
        return self._records.get(filename)

    @property
    def metadata(self) -> dict[str, ImageMetadata]:
        return {record.filename: record.metadata for record in self}

    @property
    def summary(self) -> dict[str, int]:
        banned = sum(record.banned for record in self)
        favorites = sum(record.favorite for record in self)
        return {
            "total_banned": banned,
            "total_kept": len(self) - banned,
            "total_favorites": favorites,
        }

    def display_tag(self, value: object) -> str:
        key = normalize_tag(value)
        return self._tag_display.get(key, str(value).strip())

    def display_uploader(self, value: object) -> str:
        key = str(value).strip().casefold()
        return self._uploader_display.get(key, str(value).strip())

    def matching(self, predicate: Callable[[CatalogImage], bool]) -> Iterator[CatalogImage]:
        return (record for record in self if predicate(record))

    def matching_tags(self, tags: Iterable[object]) -> Iterator[CatalogImage]:
        required = normalized_values(tags)
        return self.matching(lambda record: required.issubset(record.tags))

    def matching_uploader(self, uploader: object) -> Iterator[CatalogImage]:
        key = str(uploader).strip().casefold()
        return self.matching(lambda record: record.uploader == key)

    @staticmethod
    def stats(records: Iterable[CatalogImage]) -> MatchStats:
        banned_files: set[str] = set()
        banned = kept = favorites = 0
        for record in records:
            if record.banned:
                banned += 1
                banned_files.add(record.filename)
            else:
                kept += 1
                favorites += record.favorite
        return MatchStats(banned, kept, favorites, frozenset(banned_files))

    def tag_stats(self, tag: object) -> MatchStats:
        key = normalize_tag(tag)
        return self.stats(self.matching(lambda record: key in record.tags))

    def combo_stats(self, tags: Iterable[object]) -> MatchStats:
        return self.stats(self.matching_tags(tags))

    def uploader_stats(self, uploader: object) -> MatchStats:
        return self.stats(self.matching_uploader(uploader))

    def tag_counts(self) -> tuple[Counter[str], Counter[str], Counter[str]]:
        banned: Counter[str] = Counter()
        kept: Counter[str] = Counter()
        favorites: Counter[str] = Counter()
        for record in self:
            target = banned if record.banned else kept
            target.update(record.ordered_tags)
            if record.favorite:
                favorites.update(record.ordered_tags)
        return banned, kept, favorites

    def uploader_keys(self) -> frozenset[str]:
        return frozenset(record.uploader for record in self if record.uploader)

    @property
    def banned_filenames(self) -> frozenset[str]:
        return frozenset(record.filename for record in self if record.banned)

    @property
    def favorite_filenames(self) -> frozenset[str]:
        return frozenset(record.filename for record in self if record.favorite)

    def search(
        self,
        *,
        query: str = "",
        tags: Iterable[object] = (),
        uploader: str = "",
    ) -> CatalogSearchResult:
        """Search filenames and metadata while preserving catalog order."""
        required_tags = normalized_values(tags)
        if required_tags:
            matches = tuple(
                record.filename for record in self if required_tags.issubset(record.tags)
            )
            return CatalogSearchResult(matches)

        uploader_key = uploader.strip().casefold()
        if uploader_key:
            return CatalogSearchResult(
                tuple(record.filename for record in self if record.uploader == uploader_key)
            )

        query_key = query.casefold()
        if not query_key:
            return CatalogSearchResult(())

        matches: list[str] = []
        tag_counts: Counter[str] = Counter()
        uploader_counts: Counter[str] = Counter()
        for record in self:
            raw_tags = [str(tag) for tag in record.metadata.get("tags", [])]
            category = str(record.metadata.get("category", "")).casefold()
            uploader_display = str(record.metadata.get("uploader", ""))
            if not (
                any(query_key in tag.casefold() for tag in raw_tags)
                or query_key in category
                or query_key in record.uploader
                or query_key in record.filename.casefold()
            ):
                continue
            matches.append(record.filename)
            tag_counts.update(tag for tag in raw_tags if tag.casefold().startswith(query_key))
            if uploader_display and query_key in record.uploader:
                uploader_counts[uploader_display] += 1

        return CatalogSearchResult(
            tuple(matches),
            tuple(tag for tag, _ in tag_counts.most_common(8)),
            tuple(name for name, _ in uploader_counts.most_common(4)),
        )
