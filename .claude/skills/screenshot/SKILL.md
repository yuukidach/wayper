---
name: screenshot
description: Take a screenshot of the running wayper-gui and analyze the UI for layout/design issues. Use when debugging GUI problems or verifying visual changes.
allowed-tools: Bash, Read
---

# GUI Screenshot & Inspection

Take a screenshot of the running wayper-gui and analyze the current UI state.

If `$ARGUMENTS` is provided, read that file as a screenshot instead of capturing a new one.

## macOS

1. **Find the process** (PyObjC apps appear as "Python"):
   ```bash
   osascript -e 'tell application "System Events" to tell process "Python" to name of every window'
   ```

2. **Bring to front & capture**:
   ```bash
   osascript -e 'tell application "System Events" to tell process "Python" to set frontmost to true'
   sleep 0.5
   screencapture -x /tmp/wayper_screenshot.png
   ```

3. **Interact with UI** (click tabs, buttons):
   - Inspect hierarchy: `tell process "Python" to tell window "WindowName" to entire contents`
   - Click: `click button "Monitors" of toolbar 1 of window "Wayper Settings"`
   - After clicking, `sleep 0.5` before next screencapture

4. **View**: Use the `Read` tool on the PNG file.

## Linux

1. **Find the window**:
   ```bash
   xdotool search --name "Wayper"
   ```

2. **Capture**:
   ```bash
   # Full screen
   import -window root /tmp/wayper_screenshot.png
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
