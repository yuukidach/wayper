# UI Design Review

Review the GUI code for design issues against macOS HIG best practices.

## Steps

1. Run the static analysis script:

```bash
python .claude/commands/review_ui.py
```

2. If the user provides a screenshot path as argument (`$ARGUMENTS`), read and analyze that screenshot for visual design issues including:
   - Layout balance and alignment
   - Visual hierarchy and spacing consistency
   - Color contrast and readability
   - Control sizing and touch targets
   - Overall aesthetic coherence with macOS native apps

3. If no screenshot is provided, remind the user they can pass a screenshot path:
   ```
   /review-ui /tmp/screenshot.png
   ```

4. Combine findings from both static analysis and visual review (if applicable) into a prioritized report with:
   - P0: Violations of platform guidelines (e.g., font too small, wrong control style)
   - P1: Consistency issues (e.g., mixed spacing, raw colors)
   - P2: Missing best practices (e.g., no dark/light mode, no accessibility)
   - P3: Nice-to-have improvements

5. For each issue, suggest a concrete code fix with file path and line number.
