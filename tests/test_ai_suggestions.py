from __future__ import annotations

import asyncio
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from wayper.ai_suggestions import (
    _AI_SUGGESTION_SCHEMA,
    AISuggestionError,
    _build_prompt,
    _filter_ai_suggestions,
    _invoke_codex,
    _prompt_statistics,
)
from wayper.catalog import ImageCatalog
from wayper.config import WayperConfig


class _FakeProcess:
    def __init__(self, stdout: bytes, stderr: bytes = b"", returncode: int = 0) -> None:
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode
        self.input: bytes | None = None
        self.killed = False

    async def communicate(self, input: bytes | None = None) -> tuple[bytes, bytes]:
        self.input = input
        return self.stdout, self.stderr

    def kill(self) -> None:
        self.killed = True

    async def wait(self) -> int:
        return self.returncode


class CodexSuggestionTest(unittest.TestCase):
    def test_filter_drops_broad_positive_tag_and_combo(self) -> None:
        metadata = {
            **{f"ban{index}.jpg": {"tags": ["women"], "purity": "sfw"} for index in range(100)},
            **{f"keep{index}.jpg": {"tags": ["woman"], "purity": "sfw"} for index in range(20)},
        }
        result = _filter_ai_suggestions(
            {
                "analysis": "",
                "add_suggestions": [
                    {
                        "type": "tag",
                        "tags": ["women"],
                        "reason": "broad",
                        "confidence": "high",
                    },
                    {
                        "type": "combo",
                        "tags": ["women", "portrait"],
                        "reason": "broad",
                        "confidence": "high",
                    },
                ],
                "remove_suggestions": [],
            },
            metadata,
            {f"ban{index}.jpg" for index in range(100)},
            set(),
            WayperConfig(),
        )

        self.assertEqual(result["add_suggestions"], [])

    def test_invoke_codex_uses_structured_output_without_server_registration(self) -> None:
        response = {
            "analysis": "pattern",
            "add_suggestions": [],
            "remove_suggestions": [],
        }
        process = _FakeProcess(json.dumps(response).encode())
        captured: dict[str, object] = {}

        async def fake_create_subprocess_exec(*args: str, **kwargs: object) -> _FakeProcess:
            captured["args"] = args
            captured["kwargs"] = kwargs
            schema_path = Path(args[args.index("--output-schema") + 1])
            captured["schema"] = json.loads(schema_path.read_text())
            return process

        with (
            patch("wayper.ai_suggestions._find_codex_bin", return_value="/opt/bin/codex"),
            patch(
                "wayper.ai_suggestions.asyncio.create_subprocess_exec",
                new=fake_create_subprocess_exec,
            ),
        ):
            result = asyncio.run(_invoke_codex("analyze this"))

        args = captured["args"]
        self.assertIsInstance(args, tuple)
        assert isinstance(args, tuple)
        self.assertEqual(args[:2], ("/opt/bin/codex", "exec"))
        self.assertEqual(args[-1], "-")
        self.assertIn("--ephemeral", args)
        self.assertNotIn("--ignore-user-config", args)
        self.assertEqual(args[args.index("--sandbox") + 1], "read-only")
        self.assertIn("--skip-git-repo-check", args)

        self.assertNotIn("--config", args)
        self.assertEqual(captured["schema"], _AI_SUGGESTION_SCHEMA)
        self.assertEqual(process.input, b"analyze this")
        self.assertEqual(result, response)

    def test_prompt_supplies_exact_scoped_evidence_and_preserves_favorites(self) -> None:
        catalog = ImageCatalog(
            {
                "ban.jpg": {"tags": ["specific", "Shared"], "uploader": "Artist", "purity": "nsfw"},
                "keep.jpg": {"tags": ["shared"], "uploader": "artist", "purity": "nsfw"},
                "fav.jpg": {
                    "tags": ["shared", "favorite-only"],
                    "uploader": "Artist",
                    "purity": "nsfw",
                },
                "inactive.jpg": {"tags": ["inactive"], "purity": "sfw"},
            },
            {"ban.jpg", "inactive.jpg"},
            {"fav.jpg"},
            purities={"nsfw"},
        )
        prompt = _build_prompt(
            catalog, ["shared"], [["specific", "shared"]], ["artist"], active_purities={"nsfw"}
        )
        statistics = json.loads(prompt.split("## Local Statistics\n")[1].splitlines()[0])
        tags = {item["tag"]: item for item in statistics["tags"]}
        self.assertEqual(tags["shared"], {"tag": "shared", "banned": 1, "kept": 2, "favorites": 1})
        self.assertIn("favorite-only", tags)
        self.assertNotIn("inactive", tags)
        self.assertEqual(statistics["combos"][0]["banned"], 1)
        self.assertEqual(statistics["combos"][0]["kept"], 0)
        self.assertEqual(statistics["uploaders"][0]["favorites"], 1)
        self.assertIn("unknown support", prompt)
        self.assertNotIn("Available Tools", prompt)

    def test_infrequent_referenced_tags_are_not_lost_from_the_prompt(self) -> None:
        metadata = {f"{i}.jpg": {"tags": [f"tag{i}"]} for i in range(50)}
        catalog = ImageCatalog(metadata, set(metadata))
        statistics = _prompt_statistics(catalog, ["tag49"], [], [])
        tags = {item["tag"]: item for item in statistics["tags"]}
        self.assertLessEqual(len(tags), 31)
        self.assertEqual(tags["tag49"]["banned"], 1)

    def test_invoke_codex_reports_missing_cli(self) -> None:
        with patch("wayper.ai_suggestions._find_codex_bin", return_value=None):
            with self.assertRaises(AISuggestionError) as raised:
                asyncio.run(_invoke_codex("analyze this"))

        self.assertEqual(raised.exception.code, "cli_not_found")
        self.assertIn("Codex CLI", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
