from __future__ import annotations

import asyncio
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from wayper.ai_suggestions import (
    _AI_SUGGESTION_SCHEMA,
    _CODEX_MCP_TOOLS,
    AISuggestionError,
    _invoke_codex,
)


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
    def test_invoke_codex_uses_structured_output_and_scoped_mcp_tools(self) -> None:
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
            patch("wayper.ai_suggestions._find_mcp_bin", return_value="/opt/bin/wayper-mcp"),
            patch(
                "wayper.ai_suggestions.asyncio.create_subprocess_exec",
                new=fake_create_subprocess_exec,
            ),
        ):
            result, tools_used = asyncio.run(_invoke_codex("analyze this", use_tools=True))

        args = captured["args"]
        self.assertIsInstance(args, tuple)
        assert isinstance(args, tuple)
        self.assertEqual(args[:2], ("/opt/bin/codex", "exec"))
        self.assertEqual(args[-1], "-")
        self.assertIn("--ephemeral", args)
        self.assertIn("--ignore-user-config", args)
        self.assertEqual(args[args.index("--sandbox") + 1], "read-only")
        self.assertIn("--skip-git-repo-check", args)

        configs = [args[i + 1] for i, arg in enumerate(args) if arg == "--config"]
        self.assertIn('mcp_servers.wayper.command="/opt/bin/wayper-mcp"', configs)
        self.assertIn("mcp_servers.wayper.required=true", configs)
        self.assertIn(
            f"mcp_servers.wayper.enabled_tools={json.dumps(_CODEX_MCP_TOOLS)}",
            configs,
        )
        self.assertEqual(captured["schema"], _AI_SUGGESTION_SCHEMA)
        self.assertEqual(process.input, b"analyze this")
        self.assertEqual(result, response)
        self.assertTrue(tools_used)

    def test_invoke_codex_reports_missing_cli(self) -> None:
        with patch("wayper.ai_suggestions._find_codex_bin", return_value=None):
            with self.assertRaises(AISuggestionError) as raised:
                asyncio.run(_invoke_codex("analyze this"))

        self.assertEqual(raised.exception.code, "cli_not_found")
        self.assertIn("Codex CLI", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
