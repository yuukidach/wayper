---
name: screenshot
description: Capture the running wayper-gui renderer through Electron and analyze the UI for layout or design issues. Use when debugging Wayper GUI problems or verifying visual changes without taking a desktop screenshot.
---

# Wayper GUI Screenshot and Inspection

Capture the current Wayper renderer with Electron's `webContents.capturePage()` and inspect the
resulting PNG. This captures the app content directly; it does not photograph the desktop.

If `$ARGUMENTS` names an existing PNG file, skip capture and inspect that file instead.

## Capture

The running `wayper-gui` must already be open and its Electron dependencies must be installed.
From the repository root, run:

```bash
.claude/skills/screenshot/scripts/capture.sh
```

The command prints the absolute path of a newly created PNG. To choose the destination or adjust
the wait limit, use:

```bash
.claude/skills/screenshot/scripts/capture.sh \
  --output /tmp/wayper-review.png \
  --timeout 20
```

The destination must end in `.png` and must not already exist. The helper starts a second Electron
process only to send a capture request to the running app. The existing Wayper main process then:

1. Waits for fonts, visible images, and two animation frames.
2. Temporarily pauses animations, transitions, and the text caret.
3. Captures the current renderer with `webContents.capturePage()`.
4. Writes the PNG and restores the injected styles.

The capture does not focus, move, resize, show, or navigate the Wayper window. It contains the
renderer viewport only, so desktop pixels, native title bars, window borders, and shadows are not
included.

Do not automatically fall back to `grim`, `xdotool`, ImageMagick `import`, or another desktop
capture tool. If internal capture fails, report the error and diagnose the Electron path. Use a
desktop screenshot only when the user explicitly asks to capture the surrounding desktop or native
window chrome.

## Inspect

Open the resulting PNG with the image-capable tool available to the current agent:

- Codex: use the local image viewing tool.
- Claude Code: use the `Read` tool on the PNG.

Analyze only what is relevant to the user's request. Typical checks include:

- Layout alignment, spacing, clipping, and unintended overlap.
- Controls that do not stretch, align, or scale with the viewport.
- Visual hierarchy, typography, contrast, and consistency.
- Loading, empty, transition, and stale-view states visible in the capture.
- Differences from the requested interaction or expected design.

State the observed evidence before proposing or making changes. Remember that the PNG represents
the renderer at capture time and cannot show native window chrome or motion quality by itself.
