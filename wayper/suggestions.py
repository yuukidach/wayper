"""Tag exclusion suggestions based on ban history."""

from __future__ import annotations

from typing import TypedDict

from .pool import ImageMetadata

# Cost-benefit weights for suggestion scoring.
# Losing a good image costs ~5x more than seeing a bad one.
# Each favorited image counts as 3 additional kept images on top.
KEPT_WEIGHT = 5
FAV_WEIGHT = 3


class TagSuggestion(TypedDict):
    tag: str
    count: int
    net_benefit: float


class ComboSuggestion(TypedDict):
    tags: list[str]
    count: int
    precision: float


class UploaderSuggestion(TypedDict):
    uploader: str
    ban_count: int
    kept_count: int
    fav_count: int
    net_benefit: float


def suggest_tags_to_exclude(
    metadata: dict[str, ImageMetadata],
    blacklisted: set[str],
    excluded_tags: list[str],
    excluded_combos: list[list[str]] | None = None,
    favorites: set[str] | None = None,
    *,
    max_results: int = 10,
) -> list[TagSuggestion]:
    """Suggest tags to exclude using cost-benefit scoring.

    Uses net benefit = ban_count - KEPT_WEIGHT * kept_count - FAV_WEIGHT * fav_count.
    Only tags with positive net benefit are returned, sorted by ban count (impact).

    Already-excluded tags are skipped, and candidates whose disliked images are
    mostly covered by the *union* of all exclusion rules' images are filtered out.
    """
    if not blacklisted:
        return []

    favorites = favorites or set()
    excluded_lower = {t.lower() for t in excluded_tags}

    # --- 1. Group by purity, count tags in disliked vs pool -----------------
    purity_groups: dict[str, dict] = {}
    tag_dislike_images: dict[str, set[str]] = {}
    # Global kept/fav counts (tag exclusion affects all purities)
    global_kept: dict[str, int] = {}
    global_fav: dict[str, int] = {}

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
        is_fav = filename in favorites
        if filename in blacklisted:
            g["dislike_total"] += 1
            for tag in tags:
                g["dislike_tags"][tag] = g["dislike_tags"].get(tag, 0) + 1
                tag_dislike_images.setdefault(tag, set()).add(filename)
        else:
            g["pool_total"] += 1
            for tag in tags:
                g["pool_tags"][tag] = g["pool_tags"].get(tag, 0) + 1
                global_kept[tag] = global_kept.get(tag, 0) + 1
                if is_fav:
                    global_fav[tag] = global_fav.get(tag, 0) + 1

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

    # --- 3. Accumulate global ban counts, filter by purity frequency ----------
    global_ban: dict[str, int] = {}
    for g in purity_groups.values():
        if g["dislike_total"] < 3 or g["pool_total"] < 30:
            continue
        for tag, ban_count in g["dislike_tags"].items():
            if ban_count < 3 or tag.lower() in excluded_lower:
                continue
            pool_count = g["pool_tags"].get(tag, 0)
            total_with_tag = ban_count + pool_count
            total_images = g["dislike_total"] + g["pool_total"]
            if total_with_tag / total_images > 0.25:
                continue
            global_ban[tag] = global_ban.get(tag, 0) + ban_count

    # --- 4. Cost-benefit filter using global counts --------------------------
    tag_scores: dict[str, TagSuggestion] = {}
    for tag, ban_count in global_ban.items():
        if ban_count < 3:
            continue
        kept_count = global_kept.get(tag, 0)
        fav_count = global_fav.get(tag, 0)
        net_benefit = ban_count - KEPT_WEIGHT * kept_count - FAV_WEIGHT * fav_count
        if net_benefit <= 0:
            continue
        tag_scores[tag] = {"tag": tag, "count": ban_count, "net_benefit": round(net_benefit, 1)}

    # --- 5. Filter by union coverage ----------------------------------------
    results: list[TagSuggestion] = []
    for s in tag_scores.values():
        if s["count"] < 3:
            continue
        imgs = tag_dislike_images.get(s["tag"], set())
        if imgs and excluded_union and len(imgs & excluded_union) / len(imgs) > 0.5:
            continue
        results.append(s)

    results.sort(key=lambda r: (-r["count"], -r["net_benefit"]))
    return results[:max_results]


def suggest_combo_refinements(
    metadata: dict[str, ImageMetadata],
    blacklisted: set[str],
    context_tags: list[str],
    excluded_tags: list[str],
    excluded_combos: list[list[str]],
    favorites: set[str] | None = None,
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

    favorites = favorites or set()
    context_lower = {t.lower() for t in context_tags}
    excluded_lower = {t.lower() for t in excluded_tags}
    existing_combos = {frozenset(t.lower() for t in c) for c in excluded_combos}
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
        candidate_combo = frozenset(t.lower() for t in context_tags + [tag])
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


def suggest_combo_patterns(
    metadata: dict[str, ImageMetadata],
    blacklisted: set[str],
    excluded_tags: list[str],
    excluded_combos: list[list[str]] | None = None,
    favorites: set[str] | None = None,
    *,
    max_results: int = 8,
) -> list[ComboSuggestion]:
    """Discover tag combinations to exclude via contrast pattern mining.

    Finds tag pairs (and triples) that appear frequently in banned images but
    rarely in kept/favorited images.  Each result is a combo with high precision
    (most images matching the combo are banned) and meaningful impact (enough
    banned images to matter).
    """
    if not blacklisted:
        return []

    MIN_SUPPORT = 3
    MIN_PRECISION = 0.85

    favorites = favorites or set()
    excluded_lower = {t.lower() for t in excluded_tags}
    existing_combos_fs = {frozenset(t.lower() for t in c) for c in (excluded_combos or [])}
    combo_sets_lower = [{t.lower() for t in c} for c in (excluded_combos or [])]
    existing_pair_combos = {combo for combo in existing_combos_fs if len(combo) <= 2}

    # Use integer bitsets for tag membership. Pair/triple mining does hundreds
    # of thousands of intersections on larger libraries, and int bit ops are
    # much cheaper than allocating temporary filename sets for every candidate.
    banned_tag_masks: dict[str, int] = {}
    kept_tag_masks: dict[str, int] = {}
    fav_tag_masks: dict[str, int] = {}
    excluded_union_mask = 0

    for image_idx, (filename, meta) in enumerate(metadata.items()):
        image_bit = 1 << image_idx
        tags = meta.get("tags", [])
        if filename in blacklisted:
            tags_lower = {t.lower() for t in tags}
            # Check if already covered by existing exclusions.
            if tags_lower & excluded_lower:
                excluded_union_mask |= image_bit
            else:
                for cs in combo_sets_lower:
                    if cs.issubset(tags_lower):
                        excluded_union_mask |= image_bit
                        break
            for tag in tags:
                banned_tag_masks[tag] = banned_tag_masks.get(tag, 0) | image_bit
        else:
            is_fav = filename in favorites
            for tag in tags:
                kept_tag_masks[tag] = kept_tag_masks.get(tag, 0) | image_bit
                if is_fav:
                    fav_tag_masks[tag] = fav_tag_masks.get(tag, 0) | image_bit

    # --- 2. Find candidate tags (appear in >=3 banned images) ----------------
    banned_tag_counts = {tag: mask.bit_count() for tag, mask in banned_tag_masks.items()}
    candidate_tags = sorted(
        (
            tag
            for tag, count in banned_tag_counts.items()
            if count >= MIN_SUPPORT and tag.lower() not in excluded_lower
        ),
        key=lambda t: -banned_tag_counts[t],
    )[:150]  # Cap to limit O(n²) pair enumeration

    # --- 3. Enumerate pairs and score by precision ---------------------------
    pair_records: list[tuple[ComboSuggestion, int, int, int]] = []

    for i, tag_a in enumerate(candidate_tags):
        imgs_a = banned_tag_masks[tag_a]
        for tag_b in candidate_tags[i + 1 :]:
            imgs_b = banned_tag_masks[tag_b]
            ban_both = imgs_a & imgs_b
            ban_count = ban_both.bit_count()
            if ban_count < MIN_SUPPORT:
                continue
            # Check if existing combo already covers this
            combo_lower = frozenset([tag_a.lower(), tag_b.lower()])
            if combo_lower in existing_combos_fs or any(
                ec.issubset(combo_lower) for ec in existing_pair_combos
            ):
                continue
            # Count kept/fav images with both tags
            kept_both = kept_tag_masks.get(tag_a, 0) & kept_tag_masks.get(tag_b, 0)
            fav_both = fav_tag_masks.get(tag_a, 0) & fav_tag_masks.get(tag_b, 0)
            kept_count = kept_both.bit_count()
            fav_count = fav_both.bit_count()
            precision = ban_count / (ban_count + kept_count + FAV_WEIGHT * fav_count)
            if precision < MIN_PRECISION:
                continue
            # Overlap check: skip if most banned images are already covered
            if (
                excluded_union_mask
                and (ban_both & excluded_union_mask).bit_count() / ban_count > 0.5
            ):
                continue
            pair = {
                "tags": sorted([tag_a, tag_b]),
                "count": ban_count,
                "precision": round(precision, 2),
            }
            pair_records.append(
                (
                    pair,
                    ban_both,
                    kept_both,
                    fav_both,
                )
            )

    # --- 4. Greedy triple expansion ------------------------------------------
    triple_results: list[ComboSuggestion] = []
    for pair, pair_banned, pair_kept, pair_fav in pair_records:
        tag_a, tag_b = pair["tags"]
        for tag_c in candidate_tags:
            if tag_c in (tag_a, tag_b):
                continue
            tri_banned = pair_banned & banned_tag_masks[tag_c]
            tri_ban_count = tri_banned.bit_count()
            if tri_ban_count < MIN_SUPPORT:
                continue
            combo_lower = frozenset([tag_a.lower(), tag_b.lower(), tag_c.lower()])
            if combo_lower in existing_combos_fs or any(
                ec.issubset(combo_lower) for ec in existing_pair_combos
            ):
                continue
            tri_kept_count = (pair_kept & kept_tag_masks.get(tag_c, 0)).bit_count()
            tri_fav_count = (pair_fav & fav_tag_masks.get(tag_c, 0)).bit_count()
            tri_precision = tri_ban_count / (
                tri_ban_count + tri_kept_count + FAV_WEIGHT * tri_fav_count
            )
            # Only keep triple if it improves precision over the pair
            if tri_precision <= pair["precision"]:
                continue
            if (
                excluded_union_mask
                and (tri_banned & excluded_union_mask).bit_count() / tri_ban_count > 0.5
            ):
                continue
            triple_results.append(
                {
                    "tags": sorted([tag_a, tag_b, tag_c]),
                    "count": tri_ban_count,
                    "precision": round(tri_precision, 2),
                }
            )

    # --- 5. Merge, deduplicate, minimize -------------------------------------
    pair_results = [pair for pair, _, _, _ in pair_records]
    all_combos = pair_results + triple_results
    # Remove triples where the pair already qualifies (prefer simpler rules)
    pair_sets = {frozenset(c["tags"]) for c in pair_results}

    def has_pair_subset(combo: ComboSuggestion) -> bool:
        tags = combo["tags"]
        return (
            frozenset((tags[0], tags[1])) in pair_sets
            or frozenset((tags[0], tags[2])) in pair_sets
            or frozenset((tags[1], tags[2])) in pair_sets
        )

    all_combos = [c for c in all_combos if len(c["tags"]) == 2 or not has_pair_subset(c)]
    all_combos.sort(key=lambda c: (-c["count"], -c["precision"]))
    return all_combos[:max_results]


def suggest_uploaders_to_exclude(
    metadata: dict[str, ImageMetadata],
    blacklisted: set[str],
    excluded_uploaders: list[str],
    favorites: set[str] | None = None,
    *,
    max_results: int = 10,
) -> list[UploaderSuggestion]:
    """Suggest uploaders to exclude using cost-benefit scoring.

    Same logic as tag suggestions: net_benefit = ban - KEPT_WEIGHT * kept - FAV_WEIGHT * fav.
    Only uploaders with positive net benefit and >=3 bans are returned.
    """
    if not blacklisted:
        return []

    favorites = favorites or set()
    excluded_lower = {u.lower() for u in excluded_uploaders}

    uploader_ban: dict[str, int] = {}
    uploader_kept: dict[str, int] = {}
    uploader_fav: dict[str, int] = {}

    for filename, meta in metadata.items():
        uploader = meta.get("uploader", "")
        if not uploader or uploader.lower() in excluded_lower:
            continue
        if filename in blacklisted:
            uploader_ban[uploader] = uploader_ban.get(uploader, 0) + 1
        else:
            uploader_kept[uploader] = uploader_kept.get(uploader, 0) + 1
            if filename in favorites:
                uploader_fav[uploader] = uploader_fav.get(uploader, 0) + 1

    results: list[UploaderSuggestion] = []
    for uploader, ban_count in uploader_ban.items():
        if ban_count < 3:
            continue
        kept_count = uploader_kept.get(uploader, 0)
        fav_count = uploader_fav.get(uploader, 0)
        net_benefit = ban_count - KEPT_WEIGHT * kept_count - FAV_WEIGHT * fav_count
        if net_benefit <= 0:
            continue
        results.append(
            {
                "uploader": uploader,
                "ban_count": ban_count,
                "kept_count": kept_count,
                "fav_count": fav_count,
                "net_benefit": round(net_benefit, 1),
            }
        )

    results.sort(key=lambda r: (-r["ban_count"], -r["net_benefit"]))
    return results[:max_results]
