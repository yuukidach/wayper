---
name: screenshot
description: Take a screenshot of the running wayper-gui and analyze the UI for layout/design issues. Use when debugging GUI problems or verifying visual changes.
allowed-tools: Bash, Read
---

# GUI Screenshot & Inspection

Take a screenshot of the running wayper-gui and analyze the current UI state.

If `$ARGUMENTS` is provided, read that file as a screenshot instead of capturing a new one.

## Linux

1. **Find the window**:
   ```bash
   xdotool search --name "Wayper"
   ```

2. **Capture**:
   ```bash
   # Specific window
   import -window "$(xdotool search --name 'Wayper' | head -1)" /tmp/wayper_screenshot.png
   ```
   Or with `gnome-screenshot`:
   ```bash
   gnome-screenshot -w -f /tmp/wayper_screenshot.png
   ```

3. **Interact with UI** (click, type):
   ```bash
   xdotool windowactivate $(xdotool search --name "Wayper" | head -1)
   xdotool key Escape
   ```

4. **View**: Use the `Read` tool on the PNG file.

## After capturing

Analyze the screenshot for:
- Layout alignment and spacing issues
- Controls that don't stretch or are misaligned
- Visual hierarchy problems
- Comparison with expected design
