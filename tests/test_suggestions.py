from __future__ import annotations

import unittest

from wayper.suggestions import (
    normalize_tag,
    suggest_combo_patterns,
    suggest_tags_to_exclude,
)


def _metadata_group(
    prefix: str,
    count: int,
    tags: list[str],
    *,
    purity: str = "sfw",
) -> dict[str, dict]:
    return {f"{prefix}{index}.jpg": {"tags": tags, "purity": purity} for index in range(count)}


class SuggestionQualityTest(unittest.TestCase):
    def test_tag_matching_is_case_insensitive_for_positive_feedback(self) -> None:
        metadata = {}
        metadata.update(_metadata_group("ban", 6, ["woman"]))
        metadata.update(_metadata_group("keep", 6, ["Woman"]))
        metadata.update(_metadata_group("filler", 100, ["landscape"]))

        results = suggest_tags_to_exclude(
            metadata,
            {f"ban{index}.jpg" for index in range(6)},
            [],
        )

        self.assertNotIn("women", {normalize_tag(item["tag"]) for item in results})

    def test_tag_suggestions_include_banned_kept_favorite_counts(self) -> None:
        metadata = {}
        metadata.update(_metadata_group("ban", 20, ["specific"]))
        metadata.update(_metadata_group("keep", 1, ["specific"]))
        metadata.update(_metadata_group("filler", 100, ["landscape"]))

        results = suggest_tags_to_exclude(
            metadata,
            {f"ban{index}.jpg" for index in range(20)},
            [],
        )

        specific = next(item for item in results if item["tag"] == "specific")
        self.assertEqual(
            (specific["banned"], specific["kept"], specific["favorites"]),
            (20, 1, 0),
        )

    def test_broad_tag_with_many_kept_images_is_not_suggested(self) -> None:
        metadata = {}
        metadata.update(_metadata_group("ban", 200, ["woman"]))
        metadata.update(_metadata_group("keep", 20, ["woman"]))
        metadata.update(_metadata_group("filler", 1000, ["landscape"]))

        results = suggest_tags_to_exclude(
            metadata,
            {f"ban{index}.jpg" for index in range(200)},
            [],
        )

        self.assertNotIn("women", {normalize_tag(item["tag"]) for item in results})

    def test_layout_tags_are_not_preference_suggestions(self) -> None:
        metadata = {}
        metadata.update(_metadata_group("ban", 20, ["portrait"]))
        metadata.update(_metadata_group("filler", 100, ["landscape"]))

        results = suggest_tags_to_exclude(
            metadata,
            {f"ban{index}.jpg" for index in range(20)},
            [],
        )

        self.assertNotIn("portrait", {normalize_tag(item["tag"]) for item in results})

    def test_combo_requires_low_kept_collateral(self) -> None:
        metadata = {}
        metadata.update(_metadata_group("broad-ban", 30, ["woman", "brunette"]))
        metadata.update(_metadata_group("broad-keep", 10, ["Woman", "brunette"]))
        metadata.update(_metadata_group("narrow-ban", 8, ["studio-x", "specific-style"]))
        metadata.update(_metadata_group("narrow-woman-ban", 7, ["woman", "studio-x"]))
        metadata.update(_metadata_group("filler", 100, ["landscape"]))
        blacklisted = {
            *{f"broad-ban{index}.jpg" for index in range(30)},
            *{f"narrow-ban{index}.jpg" for index in range(8)},
            *{f"narrow-woman-ban{index}.jpg" for index in range(7)},
        }

        results = suggest_combo_patterns(metadata, blacklisted, [])
        combos = {frozenset(normalize_tag(tag) for tag in item["tags"]) for item in results}

        self.assertNotIn(frozenset({"women", "brunette"}), combos)
        self.assertIn(frozenset({"studio-x", "specific-style"}), combos)
        narrow = next(
            item
            for item in results
            if frozenset(normalize_tag(tag) for tag in item["tags"])
            == frozenset({"studio-x", "specific-style"})
        )
        self.assertEqual(
            (narrow["banned"], narrow["kept"], narrow["favorites"]),
            (8, 0, 0),
        )
        self.assertNotIn(frozenset({"women", "studio-x"}), combos)

    def test_favorites_always_veto_a_combo(self) -> None:
        metadata = {}
        metadata.update(_metadata_group("ban", 10, ["woman", "studio-x"]))
        metadata.update(_metadata_group("keep", 40, ["landscape"]))
        favorites = {"keep0.jpg"}
        metadata["keep0.jpg"] = {"tags": ["woman", "studio-x"], "purity": "sfw"}

        results = suggest_combo_patterns(
            metadata,
            {f"ban{index}.jpg" for index in range(10)},
            [],
            favorites=favorites,
        )

        self.assertNotIn(
            frozenset({"women", "studio-x"}),
            {frozenset(normalize_tag(tag) for tag in item["tags"]) for item in results},
        )

    def test_normalize_tag_collapses_case_and_whitespace(self) -> None:
        self.assertEqual(normalize_tag("  WoMen\t"), "women")
        self.assertEqual(normalize_tag("woman outdoors"), "women outdoors")


if __name__ == "__main__":
    unittest.main()
