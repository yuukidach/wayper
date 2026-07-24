"""Tag exclusion suggestions based on ban history."""

from __future__ import annotations

from typing import TypedDict

from .catalog import FAVORITE_WEIGHT as FAV_WEIGHT
from .catalog import KEPT_WEIGHT, ImageCatalog, net_benefit
from .pool import ImageMetadata
from .tags import (
    _TAG_WORD_ALIASES,
    NON_PREFERENCE_TAGS,
    SUBJECT_TAG_WORDS,
    is_non_preference_tag,
    is_subject_tag,
    normalize_tag,
    tag_items,
)

# Cost-benefit weights for suggestion scoring.
# Losing a good image costs ~5x more than seeing a bad one.
# Each favorited image counts as 3 additional kept images on top.
# Suggestions are deliberately conservative.  A tag/combination that matches
# many images the user kept is not useful merely because the banned set is
# larger.  The old net-benefit-only check made broad tags (for example
# ``women``) rise to the top of combo suggestions when the library was large.
MIN_SUGGESTION_PRECISION = 0.90
MAX_SUGGESTION_KEPT = 5
MAX_SUGGESTION_KEPT_RATIO = 0.05
BROAD_TAG_MIN_KEPT = 20


# Keep the small helper names that older integrations imported while routing
# all normalization through :mod:`wayper.tags`.
def _tag_items(tags: object) -> list[tuple[str, str]]:
    return list(tag_items(tags))


def _tag_set(tags: object) -> set[str]:
    return {key for key, _ in tag_items(tags)}


def is_broad_positive_tag(banned: int, kept: int, favorites: int) -> bool:
    """Return whether a tag node has too much positive support for mining.

    A narrow combination can still be safe even when its individual tags are
    common, but surfacing every such combination produces noisy recommendations
    (e.g. dozens of variants containing a subject tag the user clearly keeps).
    High-degree positive nodes are therefore left for manual refinement.
    """
    if favorites > 0 or kept >= BROAD_TAG_MIN_KEPT:
        return True
    total = banned + kept
    return kept > MAX_SUGGESTION_KEPT and total > 0 and kept / total >= 0.10


def passes_positive_feedback_guard(
    banned: int,
    kept: int,
    favorites: int,
    *,
    min_precision: float = MIN_SUGGESTION_PRECISION,
) -> bool:
    """Return whether a candidate has sufficiently little positive collateral.

    Favorites are an explicit strong positive signal and therefore always veto
    an exclusion suggestion.  For ordinary kept images we require both a good
    weighted precision and a small collateral ratio.  The absolute allowance
    keeps small datasets usable while preventing broad recommendations from
    scaling with the total number of bans.
    """
    if banned <= 0 or favorites > 0:
        return False
    total = banned + kept + FAV_WEIGHT * favorites
    if banned / total < min_precision:
        return False
    if kept > MAX_SUGGESTION_KEPT and kept / banned > MAX_SUGGESTION_KEPT_RATIO:
        return False
    if is_broad_positive_tag(banned, kept, favorites):
        return False
    return True


class TagSuggestion(TypedDict, total=False):
    tag: str
    count: int
    banned: int
    kept: int
    favorites: int
    net_benefit: float
    ratio: float


class ComboSuggestion(TypedDict):
    tags: list[str]
    count: int
    banned: int
    kept: int
    favorites: int
    precision: float


class UploaderSuggestion(TypedDict):
    uploader: str
    ban_count: int
    kept_count: int
    fav_count: int
    net_benefit: float


__all__ = [
    "KEPT_WEIGHT",
    "FAV_WEIGHT",
    "MIN_SUGGESTION_PRECISION",
    "MAX_SUGGESTION_KEPT",
    "MAX_SUGGESTION_KEPT_RATIO",
    "BROAD_TAG_MIN_KEPT",
    "NON_PREFERENCE_TAGS",
    "SUBJECT_TAG_WORDS",
    "_TAG_WORD_ALIASES",
    "normalize_tag",
    "is_non_preference_tag",
    "is_subject_tag",
    "is_broad_positive_tag",
    "passes_positive_feedback_guard",
    "TagSuggestion",
    "ComboSuggestion",
    "UploaderSuggestion",
    "suggest_tags_to_exclude",
    "suggest_combo_refinements",
    "suggest_combo_patterns",
    "suggest_uploaders_to_exclude",
    "_tag_items",
    "_tag_set",
]


def _normalized_rules(
    excluded_tags: list[str],
    excluded_combos: list[list[str]] | None,
) -> tuple[set[str], tuple[frozenset[str], ...]]:
    tags = {key for value in excluded_tags if (key := normalize_tag(value))}
    combos = tuple(
        combo for values in (excluded_combos or []) if (combo := frozenset(_tag_set(values)))
    )
    return tags, combos


def _matches_exclusion(
    image_tags: frozenset[str],
    excluded_tags: set[str],
    excluded_combos: tuple[frozenset[str], ...],
) -> bool:
    return bool(image_tags & excluded_tags) or any(
        combo.issubset(image_tags) for combo in excluded_combos
    )


def _covered_banned_files(
    catalog: ImageCatalog,
    excluded_tags: set[str],
    excluded_combos: tuple[frozenset[str], ...],
) -> set[str]:
    return {
        record.filename
        for record in catalog
        if record.banned and _matches_exclusion(record.tags, excluded_tags, excluded_combos)
    }


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
    catalog = ImageCatalog(metadata, blacklisted, favorites)
    excluded_lower, combo_sets_lower = _normalized_rules(excluded_tags, excluded_combos)

    # --- 1. Group by purity, count tags in disliked vs pool -----------------
    purity_groups: dict[str, dict] = {}
    tag_dislike_images: dict[str, set[str]] = {}
    tag_display: dict[str, str] = {}
    # Global kept/fav counts (tag exclusion affects all purities)
    global_kept: dict[str, int] = {}
    global_fav: dict[str, int] = {}

    for record in catalog:
        purity = record.purity
        if purity not in purity_groups:
            purity_groups[purity] = {
                "dislike_tags": {},
                "pool_tags": {},
                "dislike_total": 0,
                "pool_total": 0,
            }
        g = purity_groups[purity]
        if record.banned:
            g["dislike_total"] += 1
            for tag in record.ordered_tags:
                tag_display.setdefault(tag, catalog.display_tag(tag))
                g["dislike_tags"][tag] = g["dislike_tags"].get(tag, 0) + 1
                tag_dislike_images.setdefault(tag, set()).add(record.filename)
        else:
            g["pool_total"] += 1
            for tag in record.ordered_tags:
                tag_display.setdefault(tag, catalog.display_tag(tag))
                g["pool_tags"][tag] = g["pool_tags"].get(tag, 0) + 1
                global_kept[tag] = global_kept.get(tag, 0) + 1
                if record.favorite:
                    global_fav[tag] = global_fav.get(tag, 0) + 1

    # --- 2. Union of disliked images covered by any exclusion rule -----------
    excluded_union = _covered_banned_files(catalog, excluded_lower, combo_sets_lower)

    # --- 3. Accumulate global ban counts, filter by purity frequency ----------
    global_ban: dict[str, int] = {}
    for g in purity_groups.values():
        if g["dislike_total"] < 3 or g["pool_total"] < 30:
            continue
        for tag, ban_count in g["dislike_tags"].items():
            if ban_count < 3 or tag in excluded_lower or is_non_preference_tag(tag):
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
        if net_benefit <= 0 or not passes_positive_feedback_guard(ban_count, kept_count, fav_count):
            continue
        tag_scores[tag] = {
            "tag": tag_display.get(tag, tag),
            "count": ban_count,
            "banned": ban_count,
            "kept": kept_count,
            "favorites": fav_count,
            "net_benefit": round(net_benefit, 1),
        }

    # --- 5. Filter by union coverage ----------------------------------------
    results: list[TagSuggestion] = []
    for s in tag_scores.values():
        if s["count"] < 3:
            continue
        imgs = tag_dislike_images.get(normalize_tag(s["tag"]), set())
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
    catalog = ImageCatalog(metadata, blacklisted, favorites)
    context_lower = {normalize_tag(t) for t in context_tags if normalize_tag(t)}
    excluded_lower, combo_sets_lower = _normalized_rules(excluded_tags, excluded_combos)
    existing_combos = {
        frozenset(normalize_tag(t) for t in c if normalize_tag(t)) for c in excluded_combos
    }
    excluded_union = _covered_banned_files(catalog, excluded_lower, combo_sets_lower)

    # --- 2. Find disliked / pool images that contain ALL context tags -----------
    dislike_files: list[str] = []
    dislike_tags_list: list[tuple[str, ...]] = []
    pool_subset: list[tuple[str, tuple[str, ...]]] = []

    for record in catalog:
        if not context_lower.issubset(record.tags):
            continue
        if record.banned:
            dislike_files.append(record.filename)
            dislike_tags_list.append(record.ordered_tags)
        else:
            pool_subset.append((record.filename, record.ordered_tags))

    if len(dislike_files) < 2:
        return []

    # --- 3. Count tags + track per-tag disliked images --------------------------
    dislike_counts: dict[str, int] = {}
    tag_dislike_images: dict[str, set[str]] = {}
    pool_counts: dict[str, int] = {}

    tag_display: dict[str, str] = {}
    for filename, tags in zip(dislike_files, dislike_tags_list):
        for tag in tags:
            tag_display.setdefault(tag, catalog.display_tag(tag))
            if tag not in context_lower:
                dislike_counts[tag] = dislike_counts.get(tag, 0) + 1
                tag_dislike_images.setdefault(tag, set()).add(filename)

    pool_favorites: dict[str, int] = {}
    for filename, tags in pool_subset:
        for tag in tags:
            tag_display.setdefault(tag, catalog.display_tag(tag))
            if tag not in context_lower:
                pool_counts[tag] = pool_counts.get(tag, 0) + 1
                if filename in favorites:
                    pool_favorites[tag] = pool_favorites.get(tag, 0) + 1

    # --- 4. Score candidates ----------------------------------------------------
    d_total = len(dislike_files)
    p_total = max(len(pool_subset), 1)
    results: list[TagSuggestion] = []

    for tag, count in dislike_counts.items():
        if count < 2 or tag in excluded_lower or is_non_preference_tag(tag):
            continue
        # Subset dedup: skip if any existing combo is a subset of the candidate
        candidate_combo = frozenset((*context_lower, tag))
        if any(ec.issubset(candidate_combo) for ec in existing_combos):
            continue
        # Overlap check: skip if most disliked images are already covered
        imgs = tag_dislike_images.get(tag, set())
        if imgs and excluded_union and len(imgs & excluded_union) / len(imgs) > 0.5:
            continue
        pool_count = pool_counts.get(tag, 0)
        fav_count = pool_favorites.get(tag, 0)
        if not passes_positive_feedback_guard(count, pool_count, fav_count):
            continue
        dislike_rate = count / d_total
        pool_rate = pool_count / p_total
        ratio = dislike_rate / max(pool_rate, 0.001)
        if ratio > 1.5:
            results.append(
                {
                    "tag": tag_display.get(tag, tag),
                    "count": count,
                    "banned": count,
                    "kept": pool_count,
                    "favorites": fav_count,
                    "ratio": round(ratio, 1),
                }
            )

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
    # Keep the mining threshold aligned with the positive-feedback guard.  A
    # high raw ban count must not compensate for a large number of kept images.
    MIN_PRECISION = MIN_SUGGESTION_PRECISION

    favorites = favorites or set()
    catalog = ImageCatalog(metadata, blacklisted, favorites)
    excluded_lower, combo_sets_lower = _normalized_rules(excluded_tags, excluded_combos)
    existing_combos_fs = {
        frozenset(normalize_tag(t) for t in c if normalize_tag(t)) for c in (excluded_combos or [])
    }
    existing_pair_combos = {combo for combo in existing_combos_fs if len(combo) <= 2}

    # This is a signed tag↔image bipartite graph represented by bitsets:
    # ``banned_tag_masks`` are negative edges, while kept/favorite masks are
    # positive edges. Pair/triple mining does hundreds of thousands of graph
    # intersections on larger libraries, and int bit ops are much cheaper than
    # allocating temporary filename sets for every candidate.
    banned_tag_masks: dict[str, int] = {}
    kept_tag_masks: dict[str, int] = {}
    fav_tag_masks: dict[str, int] = {}
    tag_display: dict[str, str] = {}
    excluded_union_mask = 0

    for image_idx, record in enumerate(catalog):
        image_bit = 1 << image_idx
        for tag in record.ordered_tags:
            tag_display.setdefault(tag, catalog.display_tag(tag))
        if record.banned:
            if _matches_exclusion(record.tags, excluded_lower, combo_sets_lower):
                excluded_union_mask |= image_bit
            for tag in record.ordered_tags:
                banned_tag_masks[tag] = banned_tag_masks.get(tag, 0) | image_bit
        else:
            for tag in record.ordered_tags:
                kept_tag_masks[tag] = kept_tag_masks.get(tag, 0) | image_bit
                if record.favorite:
                    fav_tag_masks[tag] = fav_tag_masks.get(tag, 0) | image_bit

    # --- 2. Find candidate tags (appear in >=3 banned images) ----------------
    banned_tag_counts = {tag: mask.bit_count() for tag, mask in banned_tag_masks.items()}
    broad_positive_tags = {
        tag
        for tag in banned_tag_masks.keys() | kept_tag_masks.keys()
        if is_broad_positive_tag(
            banned_tag_masks.get(tag, 0).bit_count(),
            kept_tag_masks.get(tag, 0).bit_count(),
            fav_tag_masks.get(tag, 0).bit_count(),
        )
    }
    candidate_tags = sorted(
        (
            tag
            for tag, count in banned_tag_counts.items()
            if (
                count >= MIN_SUPPORT
                and tag not in excluded_lower
                and not is_non_preference_tag(tag)
            )
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
            combo_lower = frozenset([tag_a, tag_b])
            if combo_lower in existing_combos_fs or any(
                ec.issubset(combo_lower) for ec in existing_pair_combos
            ):
                continue
            # Count kept/fav images with both tags
            kept_both = kept_tag_masks.get(tag_a, 0) & kept_tag_masks.get(tag_b, 0)
            fav_both = fav_tag_masks.get(tag_a, 0) & fav_tag_masks.get(tag_b, 0)
            kept_count = kept_both.bit_count()
            fav_count = fav_both.bit_count()
            # A broad tag may still be useful in a *specific* combo, but only
            # when that exact combo has no positive examples.  This preserves
            # safe exceptions without bringing back broad noisy suggestions.
            if (tag_a in broad_positive_tags and is_subject_tag(tag_a)) or (
                tag_b in broad_positive_tags and is_subject_tag(tag_b)
            ):
                continue
            if (tag_a in broad_positive_tags or tag_b in broad_positive_tags) and (
                kept_count > 0 or fav_count > 0
            ):
                continue
            precision = ban_count / (ban_count + kept_count + FAV_WEIGHT * fav_count)
            if precision < MIN_PRECISION or not passes_positive_feedback_guard(
                ban_count, kept_count, fav_count, min_precision=MIN_PRECISION
            ):
                continue
            # Overlap check: skip if most banned images are already covered
            if (
                excluded_union_mask
                and (ban_both & excluded_union_mask).bit_count() / ban_count > 0.5
            ):
                continue
            pair = {
                "tags": sorted(
                    [tag_display.get(tag_a, tag_a), tag_display.get(tag_b, tag_b)],
                    key=normalize_tag,
                ),
                "count": ban_count,
                "banned": ban_count,
                "kept": kept_count,
                "favorites": fav_count,
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
        tag_a, tag_b = map(normalize_tag, pair["tags"])
        for tag_c in candidate_tags:
            if tag_c in (tag_a, tag_b):
                continue
            tri_banned = pair_banned & banned_tag_masks[tag_c]
            tri_ban_count = tri_banned.bit_count()
            if tri_ban_count < MIN_SUPPORT:
                continue
            combo_lower = frozenset([tag_a, tag_b, tag_c])
            if combo_lower in existing_combos_fs or any(
                ec.issubset(combo_lower) for ec in existing_pair_combos
            ):
                continue
            tri_kept_count = (pair_kept & kept_tag_masks.get(tag_c, 0)).bit_count()
            tri_fav_count = (pair_fav & fav_tag_masks.get(tag_c, 0)).bit_count()
            if any(
                tag in broad_positive_tags and is_subject_tag(tag) for tag in (tag_a, tag_b, tag_c)
            ):
                continue
            if (
                tag_a in broad_positive_tags
                or tag_b in broad_positive_tags
                or tag_c in broad_positive_tags
            ) and (tri_kept_count > 0 or tri_fav_count > 0):
                continue
            tri_precision = tri_ban_count / (
                tri_ban_count + tri_kept_count + FAV_WEIGHT * tri_fav_count
            )
            # Only keep triple if it improves precision over the pair
            if tri_precision <= pair["precision"] or not passes_positive_feedback_guard(
                tri_ban_count,
                tri_kept_count,
                tri_fav_count,
                min_precision=MIN_PRECISION,
            ):
                continue
            if (
                excluded_union_mask
                and (tri_banned & excluded_union_mask).bit_count() / tri_ban_count > 0.5
            ):
                continue
            triple_results.append(
                {
                    "tags": sorted(
                        [
                            tag_display.get(tag_a, tag_a),
                            tag_display.get(tag_b, tag_b),
                            tag_display.get(tag_c, tag_c),
                        ],
                        key=normalize_tag,
                    ),
                    "count": tri_ban_count,
                    "banned": tri_ban_count,
                    "kept": tri_kept_count,
                    "favorites": tri_fav_count,
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
    # Prefer combinations made from tags with little standalone positive
    # support. Broad tags remain available as zero-collision exceptions, but
    # should not crowd out more specific candidates.
    all_combos.sort(
        key=lambda c: (
            any(normalize_tag(tag) in broad_positive_tags for tag in c["tags"]),
            -c["count"],
            -c["precision"],
        )
    )
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
    catalog = ImageCatalog(metadata, blacklisted, favorites)
    excluded_lower = {str(u).strip().casefold() for u in excluded_uploaders if str(u).strip()}

    results: list[UploaderSuggestion] = []
    # Preserve metadata order for equal-score ties, matching the old stable
    # sort while still doing all normalization through the catalog.
    uploaders = dict.fromkeys(record.uploader for record in catalog if record.uploader)
    for uploader in uploaders:
        if uploader in excluded_lower:
            continue
        stats = catalog.uploader_stats(uploader)
        if stats.banned < 3:
            continue
        benefit = net_benefit(stats.banned, stats.kept, stats.favorites)
        if benefit <= 0 or not passes_positive_feedback_guard(
            stats.banned, stats.kept, stats.favorites
        ):
            continue
        results.append(
            {
                "uploader": catalog.display_uploader(uploader),
                "ban_count": stats.banned,
                "kept_count": stats.kept,
                "fav_count": stats.favorites,
                "net_benefit": round(benefit, 1),
            }
        )

    results.sort(key=lambda r: (-r["ban_count"], -r["net_benefit"]))
    return results[:max_results]
