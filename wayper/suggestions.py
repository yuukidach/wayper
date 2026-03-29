"""Tag exclusion suggestions based on dislike history."""

from __future__ import annotations

from typing import TypedDict

from .pool import ImageMetadata


class TagSuggestion(TypedDict):
    tag: str
    count: int
    ratio: float


def suggest_tags_to_exclude(
    metadata: dict[str, ImageMetadata],
    blacklisted: set[str],
    excluded_tags: list[str],
    *,
    max_results: int = 10,
) -> list[TagSuggestion]:
    """Suggest tags to exclude based on dislike history vs same-purity pool.

    Compares tag frequency in disliked images against the overall pool within
    each purity group.  Tags that appear disproportionately in dislikes are
    returned as exclusion candidates.

    Already-excluded tags are skipped, and candidates whose disliked images are
    mostly covered by the *union* of all excluded tags' images are filtered out.
    """
    if not blacklisted:
        return []

    excluded_lower = {t.lower() for t in excluded_tags}

    # --- 1. Group by purity, count tags in disliked vs pool -----------------
    purity_groups: dict[str, dict] = {}
    tag_dislike_images: dict[str, set[str]] = {}

    for filename, meta in metadata.items():
        purity = meta.get("purity", "sfw")
        if purity not in purity_groups:
            purity_groups[purity] = {
                "dislike_tags": {},
                "pool_tags": {},
                "dislike_total": 0,
                "pool_total": 0,
            }
        g = purity_groups[purity]
        tags = meta.get("tags", [])
        if filename in blacklisted:
            g["dislike_total"] += 1
            for tag in tags:
                g["dislike_tags"][tag] = g["dislike_tags"].get(tag, 0) + 1
                tag_dislike_images.setdefault(tag, set()).add(filename)
        else:
            g["pool_total"] += 1
            for tag in tags:
                g["pool_tags"][tag] = g["pool_tags"].get(tag, 0) + 1

    # --- 2. Union of disliked images covered by already-excluded tags -------
    excluded_image_sets = [tag_dislike_images[t] for t in excluded_tags if t in tag_dislike_images]
    excluded_union = set().union(*excluded_image_sets) if excluded_image_sets else set()

    # --- 3. Score candidates across purity groups ---------------------------
    tag_scores: dict[str, TagSuggestion] = {}
    for g in purity_groups.values():
        if g["dislike_total"] < 3 or g["pool_total"] < 30:
            continue
        for tag, count in g["dislike_tags"].items():
            if count < 3 or tag.lower() in excluded_lower:
                continue
            pool_count = g["pool_tags"].get(tag, 0)
            if pool_count / g["pool_total"] > 0.25:
                continue
            dislike_rate = count / g["dislike_total"]
            pool_rate = pool_count / max(g["pool_total"], 1)
            ratio = dislike_rate / max(pool_rate, 0.001)
            if ratio > 2.0:
                if tag not in tag_scores:
                    tag_scores[tag] = {"tag": tag, "count": 0, "ratio": 0.0}
                tag_scores[tag]["count"] += count
                tag_scores[tag]["ratio"] = max(tag_scores[tag]["ratio"], round(ratio, 1))

    # --- 4. Filter by union coverage ----------------------------------------
    results: list[TagSuggestion] = []
    for s in tag_scores.values():
        if s["count"] < 3:
            continue
        imgs = tag_dislike_images.get(s["tag"], set())
        if imgs and excluded_union and len(imgs & excluded_union) / len(imgs) > 0.5:
            continue
        results.append(s)

    results.sort(key=lambda r: (-r["count"], -r["ratio"]))
    return results[:max_results]
