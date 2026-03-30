---
name: screenshot
description: Take a screenshot of the running wayper-gui and analyze the UI for layout/design issues. Use when debugging GUI problems or verifying visual changes.
allowed-tools: Bash, Read
---

# GUI Screenshot & Inspection

Take a screenshot of the running wayper-gui and analyze the current UI state.

If `$ARGUMENTS` is provided, read that file as a screenshot instead of capturing a new one.

## Capture Strategy

Detect the display server and use the appropriate tool chain:

```bash
if [ "$XDG_SESSION_TYPE" = "wayland" ]; then
    # Wayland — use grim + hyprctl/swaymsg for window geometry
    # (xdotool/import/gnome-screenshot do NOT work on Wayland)
fi
```

### Wayland + Hyprland

1. **Find the window** with `hyprctl`:
   ```bash
   hyprctl clients -j | python3 -c "
   import json, sys
   for c in json.load(sys.stdin):
       if 'wayper' in c.get('title','').lower() or 'wayper' in c.get('class','').lower():
           print(f'{c[\"at\"][0]},{c[\"at\"][1]} {c[\"size\"][0]}x{c[\"size\"][1]}')
   "
   ```

2. **Capture** with `grim`:
   ```bash
   # Use the geometry from step 1
   grim -g "X,Y WxH" /tmp/wayper_screenshot.png
   ```

3. **Focus/interact** with the window:
   ```bash
   hyprctl dispatch focuswindow "title:Wayper"
   # Send keys via wtype (Wayland equivalent of xdotool key)
   wtype -k Escape
   ```

### Wayland + Sway

1. **Find the window**:
   ```bash
   swaymsg -t get_tree | python3 -c "
   import json, sys
   def find(node):
       if 'wayper' in node.get('name','').lower():
           r = node['rect']; print(f'{r[\"x\"]},{r[\"y\"]} {r[\"width\"]}x{r[\"height\"]}')
       for c in node.get('nodes', []) + node.get('floating_nodes', []):
           find(c)
   find(json.load(sys.stdin))
   "
   ```

2. **Capture** with `grim` (same as Hyprland).

### X11

1. **Find the window**:
   ```bash
   xdotool search --name "Wayper"
   ```

2. **Capture**:
   ```bash
   import -window "$(xdotool search --name 'Wayper' | head -1)" /tmp/wayper_screenshot.png
   ```

3. **Interact**:
   ```bash
   xdotool windowactivate $(xdotool search --name "Wayper" | head -1)
   xdotool key Escape
   ```

## View

Use the `Read` tool on the PNG file — Claude can read images directly.

## After capturing

Analyze the screenshot for:
- Layout alignment and spacing issues
- Controls that don't stretch or are misaligned
- Visual hierarchy problems
- Comparison with expected design
