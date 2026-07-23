---
name: screenshot
description: Take a screenshot of the running wayper-gui and analyze the UI for layout/design issues. Use when debugging GUI problems or verifying visual changes.
allowed-tools: Bash, Read
---

# GUI Screenshot & Inspection

Take a screenshot of the running wayper-gui and analyze the current UI state.

If `$ARGUMENTS` is provided, read that file as a screenshot instead of capturing a new one.

This skill is shared by Codex and Claude Code. In Codex, use the available image viewing tool
for the captured PNG. In Claude Code, use the `Read` tool on the PNG file.

## Capture Strategy

Detect the display server and use the appropriate tool chain:

```bash
if [ "$XDG_SESSION_TYPE" = "wayland" ]; then
    # Wayland — use grim + hyprctl/swaymsg for window geometry
    # (xdotool/import/gnome-screenshot do NOT work on Wayland)
fi
```

`grim` captures pixels from the currently rendered outputs; it cannot capture an arbitrary
client buffer. A window returned by `hyprctl clients` or `swaymsg -t get_tree` may be on an
inactive workspace or outside the visible output while still reporting plausible geometry.
Always make the window visible **before** reading its final geometry. If it must be moved or
centered, query its geometry again after the move and use only the updated coordinates.

### Wayland + Hyprland

1. **Find the window address** with `hyprctl`:
   ```bash
   address="$(hyprctl clients -j | python3 -c "
   import json, sys
   for c in json.load(sys.stdin):
       if 'wayper' in c.get('title','').lower() or 'wayper' in c.get('class','').lower():
           print(c['address'])
           break
   ")"
   test -n "$address"
   ```

2. **Make it visible, then read its geometry**. Focusing switches to the window's workspace.
   If a floating window is still outside the output, run `hyprctl dispatch centerwindow 1`
   after focusing it. Do not center an already visible window unnecessarily.
   ```bash
   hyprctl dispatch focuswindow "address:$address"
   sleep 0.2

   # Only when the focused floating window is still outside the visible output:
   # hyprctl dispatch centerwindow 1
   # sleep 0.2

   geometry="$(hyprctl clients -j | ADDRESS="$address" python3 -c "
   import json, os, sys
   client = next(c for c in json.load(sys.stdin) if c['address'] == os.environ['ADDRESS'])
   print(f'{client[\"at\"][0]},{client[\"at\"][1]} '
         f'{client[\"size\"][0]}x{client[\"size\"][1]}')
   ")"
   ```

3. **Capture and interact** with the now-visible window:
   ```bash
   grim -g "$geometry" /tmp/wayper_screenshot.png
   # Send keys via wtype (Wayland equivalent of xdotool key)
   wtype -k Escape
   ```

### Wayland + Sway

1. **Find the window container id**:
   ```bash
   con_id="$(swaymsg -t get_tree | python3 -c "
   import json, sys
   def find(node):
       if 'wayper' in node.get('name','').lower():
           print(node['id'])
           return True
       for c in node.get('nodes', []) + node.get('floating_nodes', []):
           if find(c):
               return True
       return False
   find(json.load(sys.stdin))
   ")"
   test -n "$con_id"
   ```

2. **Make it visible, then re-read its geometry**. Focusing switches to the container's
   workspace. If a floating container remains outside the output, center it with
   `swaymsg "[con_id=$con_id] move position center"`, wait, and query the geometry again.
   ```bash
   swaymsg "[con_id=$con_id] focus"
   sleep 0.2

   geometry="$(swaymsg -t get_tree | CON_ID="$con_id" python3 -c "
   import json, os, sys
   wanted = int(os.environ['CON_ID'])
   def find(node):
       if node.get('id') == wanted:
           return node
       for child in node.get('nodes', []) + node.get('floating_nodes', []):
           match = find(child)
           if match:
               return match
   rect = find(json.load(sys.stdin))['rect']
   print(f'{rect[\"x\"]},{rect[\"y\"]} {rect[\"width\"]}x{rect[\"height\"]}')
   ")"
   grim -g "$geometry" /tmp/wayper_screenshot.png
   ```

### X11

1. **Find the window**:
   ```bash
   xdotool search --name "Wayper"
   ```

2. **Activate the window before capturing**. `windowactivate --sync` switches to its desktop
   and waits until it is visible. If the window is still outside the screen, use
   `xdotool windowmove --sync "$window_id" 0 0` first.
   ```bash
   window_id="$(xdotool search --name 'Wayper' | head -1)"
   xdotool windowactivate --sync "$window_id"
   import -window "$window_id" /tmp/wayper_screenshot.png
   ```

3. **Interact**:
   ```bash
   xdotool key Escape
   ```

## View

Open the captured PNG with the image-capable tool available in the current agent:

- Codex: use the local image view tool.
- Claude Code: use the `Read` tool.

## After capturing

Analyze the screenshot for:
- Layout alignment and spacing issues
- Controls that don't stretch or are misaligned
- Visual hierarchy problems
- Comparison with expected design
