"""Canonical tag handling shared by search, statistics, and ranking."""

from __future__ import annotations

from collections.abc import Iterable

NON_PREFERENCE_TAGS = frozenset({"portrait", "landscape"})
SUBJECT_TAG_WORDS = frozenset({"women", "men", "girls", "boys"})

_TAG_WORD_ALIASES = {
    # Wallhaven has both forms in older metadata.  Collapsing only these known
    # aliases avoids treating arbitrary singular/plural nouns as equivalent.
    "woman": "women",
    "man": "men",
    "girl": "girls",
    "boy": "boys",
}


def normalize_tag(value: object) -> str:
    """Return a stable, case-insensitive tag key."""
    if value is None:
        return ""
    words = str(value).strip().casefold().split()
    return " ".join(_TAG_WORD_ALIASES.get(word, word) for word in words)


def tag_items(tags: object) -> tuple[tuple[str, str], ...]:
    """Return unique ``(normalized, display)`` tag pairs in input order."""
    if not isinstance(tags, list | tuple | set | frozenset):
        return ()

    # Lists/tuples reflect metadata order; sets have no stable iteration
    # order, so sort those inputs before canonicalizing them.
    values = (
        sorted(tags, key=lambda value: str(value)) if isinstance(tags, set | frozenset) else tags
    )
    result: list[tuple[str, str]] = []
    seen: set[str] = set()
    for raw in values:
        if raw is None:
            continue
        display = str(raw).strip()
        key = normalize_tag(display)
        if not key or key in seen:
            continue
        if " ".join(display.casefold().split()) != key:
            display = key
        seen.add(key)
        result.append((key, display))
    return tuple(result)


def tag_set(tags: object) -> frozenset[str]:
    """Return the unique normalized tags in ``tags``."""
    return frozenset(key for key, _ in tag_items(tags))


def normalized_values(values: Iterable[object]) -> frozenset[str]:
    """Normalize an arbitrary iterable and discard empty values."""
    if isinstance(values, str):
        values = (values,)
    return frozenset(key for value in values if (key := normalize_tag(value)))


def is_non_preference_tag(value: object) -> bool:
    """Return whether a tag describes layout rather than visual taste."""
    return normalize_tag(value) in NON_PREFERENCE_TAGS


def is_subject_tag(value: object) -> bool:
    """Return whether a tag names a broad human-subject category."""
    return bool(set(normalize_tag(value).split()) & SUBJECT_TAG_WORDS)
