"""Tag exclusion suggestions based on ban history."""

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
    excluded_combos: list[list[str]] | None = None,
    *,
    max_results: int = 10,
) -> list[TagSuggestion]:
    """Suggest tags to exclude based on dislike history vs same-purity pool.

    Compares tag frequency in disliked images against the overall pool within
    each purity group.  Tags that appear disproportionately in dislikes are
    returned as exclusion candidates.

    Already-excluded tags are skipped, and candidates whose disliked images are
    mostly covered by the *union* of all exclusion rules' images are filtered out.
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

    # --- 2. Union of disliked images covered by any exclusion rule -----------
    excluded_union: set[str] = set()
    # Single-tag exclusions
    for t in excluded_tags:
        if t in tag_dislike_images:
            excluded_union |= tag_dislike_images[t]
    # Combo exclusions
    combo_sets_lower = [{t.lower() for t in c} for c in (excluded_combos or [])]
    if combo_sets_lower:
        for filename in blacklisted:
            if filename in excluded_union:
                continue
            meta = metadata.get(filename)
            if not meta:
                continue
            tags_lower = {t.lower() for t in meta.get("tags", [])}
            for cs in combo_sets_lower:
                if cs.issubset(tags_lower):
                    excluded_union.add(filename)
                    break

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


def suggest_combo_refinements(
    metadata: dict[str, ImageMetadata],
    blacklisted: set[str],
    context_tags: list[str],
    excluded_tags: list[str],
    excluded_combos: list[list[str]],
    *,
    max_results: int = 8,
) -> list[TagSuggestion]:
    """Given selected context tags, find co-occurring tags that refine the pattern.

    Narrows to disliked images containing ALL context_tags, then scores other tags
    by how much more frequently they appear in this dislike subset vs the same
    subset in the pool.

    Candidates are skipped when an existing combo is already a subset of the
    candidate (the more general combo already covers it), and when >50% of the
    candidate's disliked images are already covered by existing exclusion rules.
    """
    if not blacklisted or not context_tags:
        return []

    context_lower = {t.lower() for t in context_tags}
    excluded_lower = {t.lower() for t in excluded_tags}
    existing_combos = {frozenset(c) for c in excluded_combos}
    combo_sets_lower = [{t.lower() for t in c} for c in excluded_combos]

    # --- 1. Build excluded_union: disliked images already covered by any rule ---
    excluded_union: set[str] = set()
    for filename in blacklisted:
        meta = metadata.get(filename)
        if not meta:
            continue
        tags_lower = {t.lower() for t in meta.get("tags", [])}
        if tags_lower & excluded_lower:
            excluded_union.add(filename)
            continue
        for cs in combo_sets_lower:
            if cs.issubset(tags_lower):
                excluded_union.add(filename)
                break

    # --- 2. Find disliked / pool images that contain ALL context tags -----------
    dislike_files: list[str] = []
    dislike_tags_list: list[list[str]] = []
    pool_subset: list[list[str]] = []

    for filename, meta in metadata.items():
        tags = meta.get("tags", [])
        tags_lower = {t.lower() for t in tags}
        if not context_lower.issubset(tags_lower):
            continue
        if filename in blacklisted:
            dislike_files.append(filename)
            dislike_tags_list.append(tags)
        else:
            pool_subset.append(tags)

    if len(dislike_files) < 2:
        return []

    # --- 3. Count tags + track per-tag disliked images --------------------------
    dislike_counts: dict[str, int] = {}
    tag_dislike_images: dict[str, set[str]] = {}
    pool_counts: dict[str, int] = {}

    for filename, tags in zip(dislike_files, dislike_tags_list):
        for tag in tags:
            if tag.lower() not in context_lower:
                dislike_counts[tag] = dislike_counts.get(tag, 0) + 1
                tag_dislike_images.setdefault(tag, set()).add(filename)

    for tags in pool_subset:
        for tag in tags:
            if tag.lower() not in context_lower:
                pool_counts[tag] = pool_counts.get(tag, 0) + 1

    # --- 4. Score candidates ----------------------------------------------------
    d_total = len(dislike_files)
    p_total = max(len(pool_subset), 1)
    results: list[TagSuggestion] = []

    for tag, count in dislike_counts.items():
        if count < 2 or tag.lower() in excluded_lower:
            continue
        # Subset dedup: skip if any existing combo is a subset of the candidate
        candidate_combo = frozenset(context_tags + [tag])
        if any(ec.issubset(candidate_combo) for ec in existing_combos):
            continue
        # Overlap check: skip if most disliked images are already covered
        imgs = tag_dislike_images.get(tag, set())
        if imgs and excluded_union and len(imgs & excluded_union) / len(imgs) > 0.5:
            continue
        pool_count = pool_counts.get(tag, 0)
        dislike_rate = count / d_total
        pool_rate = pool_count / p_total
        ratio = dislike_rate / max(pool_rate, 0.001)
        if ratio > 1.5:
            results.append({"tag": tag, "count": count, "ratio": round(ratio, 1)})

    results.sort(key=lambda r: (-r["count"], -r["ratio"]))
    return results[:max_results]
