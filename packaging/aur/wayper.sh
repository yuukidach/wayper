#!/bin/sh
# Launcher for distribution packages that run Wayper on the system Electron.
# @ELECTRON@ is replaced with the Electron package name at packaging time.
app=/usr/lib/wayper
export WAYPER_AUTOSTART_EXEC=/usr/bin/wayper

# Only switches (--hidden, Chromium flags) start the desktop app; a command
# word or a CLI-level flag selects the CLI. Keep in sync with bin/wayper.cjs.
gui=1
for arg in "$@"; do
    case "$arg" in
        --wayper-capture*) gui=1; break ;;
        -h|--help|--version|--json|--config|--config=*) gui=0 ;;
        -*) ;;
        *) gui=0 ;;
    esac
done

if [ "$gui" -eq 1 ]; then
    # The distribution wrapper applies the user's Electron flags file.
    exec /usr/bin/@ELECTRON@ "$app" "$@"
fi

# CLI commands skip the desktop runtime: no display is needed and hotkey
# actions start faster. The flags file is for Chromium, so bypass the wrapper.
export WAYPER_AUTOSTART_COMMAND='["/usr/bin/wayper","--hidden"]'
ELECTRON_RUN_AS_NODE=1 exec /usr/lib/@ELECTRON@/electron "$app/dist/cli/index.cjs" "$@"
