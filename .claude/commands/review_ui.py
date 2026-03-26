#!/usr/bin/env python3
"""Automated UI design review for Wayper GUI code.

Scans all GUI source files and checks against macOS HIG best practices.
Run: python .claude/commands/review_ui.py
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

GUI_DIR = Path(__file__).resolve().parent.parent.parent / "wayper" / "gui"

# --- Design tokens (what we WANT) ---
VALID_SPACING = {4, 8, 12, 16, 20, 24, 32}  # 4pt grid
MIN_FONT_SIZE = 11  # macOS HIG minimum
FONT_SCALE = {11, 13, 15, 17, 20, 22}  # recommended type scale


@dataclass
class Issue:
    file: str
    line: int
    severity: str  # "error" | "warning" | "info"
    category: str
    message: str

    def __str__(self) -> str:
        icon = {"error": "x", "warning": "!", "info": "-"}[self.severity]
        return f"  [{icon}] {self.file}:{self.line} ({self.category}) {self.message}"


@dataclass
class ReviewResult:
    issues: list[Issue] = field(default_factory=list)

    def add(self, file: str, line: int, severity: str, category: str, msg: str) -> None:
        self.issues.append(Issue(file, line, severity, category, msg))

    def summary(self) -> str:
        errors = sum(1 for i in self.issues if i.severity == "error")
        warnings = sum(1 for i in self.issues if i.severity == "warning")
        infos = sum(1 for i in self.issues if i.severity == "info")
        return f"Found {errors} errors, {warnings} warnings, {infos} info"


def check_spacing(result: ReviewResult, filepath: Path, lines: list[str]) -> None:
    """Check for non-standard spacing values."""
    fname = filepath.name
    # Match patterns like: constant(12), spacing +8, padding 16, height 32
    spacing_pat = re.compile(
        r"""(?:"""
        r"""constant[_:]?\(?(-?\d+)\)?"""
        r"""|spacing[_:]\s*(\d+)"""
        r"""|inset.*?(\d+)"""
        r""")""",
        re.IGNORECASE,
    )
    for i, line in enumerate(lines, 1):
        for m in spacing_pat.finditer(line):
            val = abs(int(next(v for v in m.groups() if v is not None)))
            if val > 0 and val not in VALID_SPACING and val < 100:
                result.add(fname, i, "warning", "spacing",
                           f"Non-standard spacing value {val}px (use 4pt grid: {sorted(VALID_SPACING)})")


def check_fonts(result: ReviewResult, filepath: Path, lines: list[str]) -> None:
    """Check font sizes against type scale."""
    fname = filepath.name
    font_pat = re.compile(r"(?:FontOfSize|fontSize)[_:]?\(?(\d+\.?\d*)\)?")
    for i, line in enumerate(lines, 1):
        for m in font_pat.finditer(line):
            size = float(m.group(1))
            if size < MIN_FONT_SIZE:
                result.add(fname, i, "error", "typography",
                           f"Font size {size}pt is below macOS HIG minimum ({MIN_FONT_SIZE}pt)")
            elif size not in FONT_SCALE:
                result.add(fname, i, "info", "typography",
                           f"Font size {size}pt is outside recommended scale {sorted(FONT_SCALE)}")


def check_hardcoded_sizes(result: ReviewResult, filepath: Path, lines: list[str]) -> None:
    """Check for hardcoded pixel dimensions that should be flexible."""
    fname = filepath.name
    # Match patterns like NSMakeRect, NSMakeSize with large fixed values
    rect_pat = re.compile(r"NSMakeRect\((.+?)\)")
    size_pat = re.compile(r"NSMakeSize\((\d+),\s*(\d+)\)")
    for i, line in enumerate(lines, 1):
        for m in size_pat.finditer(line):
            w, h = int(m.group(1)), int(m.group(2))
            if w > 200 or h > 200:
                result.add(fname, i, "info", "layout",
                           f"Large hardcoded size ({w}x{h}) — consider flexible constraints")


def check_button_styles(result: ReviewResult, filepath: Path, lines: list[str]) -> None:
    """Check button bezel styles for context appropriateness."""
    fname = filepath.name
    for i, line in enumerate(lines, 1):
        if "AccessoryBarAction" in line and "toolbar" not in filepath.name.lower():
            result.add(fname, i, "warning", "controls",
                       "NSBezelStyleAccessoryBarAction used outside toolbar — "
                       "consider NSBezelStyleRounded or NSBezelStyleFlexiblePush for content areas")


def check_color_consistency(result: ReviewResult, filepath: Path, lines: list[str]) -> None:
    """Check for raw color values instead of semantic tokens."""
    fname = filepath.name
    raw_color_pat = re.compile(
        r"(?:colorWithRed|CGColorCreateGenericRGB|NSColor\.\w+Color\(\))"
    )
    for i, line in enumerate(lines, 1):
        if raw_color_pat.search(line):
            # Skip if it's in the colors.py definition file
            if filepath.name == "colors.py":
                continue
            result.add(fname, i, "warning", "color",
                       "Raw color value — use semantic color tokens from colors.py")


def check_accessibility(result: ReviewResult, filepath: Path, lines: list[str]) -> None:
    """Check for missing accessibility attributes."""
    fname = filepath.name
    has_buttons = any("NSButton" in line or "addItemWithTitle" in line for line in lines)
    has_accessibility = any("accessibility" in line.lower() or "setToolTip" in line for line in lines)

    if has_buttons and not has_accessibility:
        result.add(fname, 0, "info", "a11y",
                   "File has buttons but no accessibility labels or tooltips")


def check_dark_mode(result: ReviewResult, filepath: Path, lines: list[str]) -> None:
    """Check if appearance switching is supported."""
    fname = filepath.name
    all_text = "\n".join(lines)
    if "C_BASE" in all_text or "C_TEXT" in all_text:
        if "effectiveAppearance" not in all_text and "aqua" not in all_text.lower():
            if fname != "colors.py":
                result.add(fname, 0, "info", "theme",
                           "Uses hardcoded dark theme colors — no light mode / system appearance support")


def check_layout_flexibility(result: ReviewResult, filepath: Path, lines: list[str]) -> None:
    """Check for rigid layouts that should be flexible."""
    fname = filepath.name
    all_text = "\n".join(lines)

    # Check for fixed width constraints on panels that should be split views
    width_constraint = re.compile(r"widthAnchor.*constraint.*?(\d+)")
    for i, line in enumerate(lines, 1):
        m = width_constraint.search(line)
        if m and int(m.group(1)) > 200:
            result.add(fname, i, "warning", "layout",
                       f"Fixed width constraint ({m.group(1)}px) — "
                       "consider NSSplitView or proportional constraints for resizable panels")


def run_review() -> ReviewResult:
    result = ReviewResult()

    py_files = sorted(GUI_DIR.glob("*.py"))
    if not py_files:
        print(f"No Python files found in {GUI_DIR}", file=sys.stderr)
        sys.exit(1)

    checks = [
        check_spacing,
        check_fonts,
        check_hardcoded_sizes,
        check_button_styles,
        check_color_consistency,
        check_accessibility,
        check_dark_mode,
        check_layout_flexibility,
    ]

    for filepath in py_files:
        if filepath.name == "__init__.py":
            continue
        lines = filepath.read_text().splitlines()
        for check in checks:
            check(result, filepath, lines)

    return result


def main() -> None:
    print("Wayper GUI Design Review")
    print("=" * 60)
    print()

    result = run_review()

    # Group by category
    categories: dict[str, list[Issue]] = {}
    for issue in result.issues:
        categories.setdefault(issue.category, []).append(issue)

    for cat in sorted(categories):
        issues = categories[cat]
        print(f"## {cat.upper()} ({len(issues)} issues)")
        for issue in sorted(issues, key=lambda i: (i.severity, i.file, i.line)):
            print(issue)
        print()

    print("=" * 60)
    print(result.summary())
    severity_order = {"error": 0, "warning": 1, "info": 2}
    worst = min((i.severity for i in result.issues), key=lambda s: severity_order[s], default="info")
    sys.exit(1 if worst == "error" else 0)


if __name__ == "__main__":
    main()
