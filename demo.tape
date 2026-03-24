Output assets/demo-cli.gif

Set Shell "bash"
Set FontSize 14
Set Width 960
Set Height 600
Set Theme "Catppuccin Mocha"
Set Padding 20
Set TypingSpeed 40ms
Set CursorBlink false

# Hidden setup: activate venv, mask paths, ensure SFW mode, clean prompt
Hide
Type "export VIRTUAL_ENV_DISABLE_PROMPT=1"
Enter
Type "source /home/da/projects/wayper/.venv/bin/activate"
Enter
Type `export PS1='$ '`
Enter
Type `wayper() { command wayper "$@" | sed "s|/home/[^/]*/|~/|g"; }`
Enter
Type "command wayper mode sfw >/dev/null 2>&1"
Enter
Sleep 500ms
Type "clear"
Enter
Sleep 300ms
Show

# Show available commands
Type "wayper --help"
Enter
Sleep 3s

# Human-readable status
Type "wayper status"
Enter
Sleep 3s

# JSON output — change wallpaper
Type "wayper --json next"
Enter
Sleep 2.5s

# Dislike + undo workflow
Type "wayper --json dislike"
Enter
Sleep 2s

Type "wayper --json undislike"
Enter
Sleep 2s

# Favorites workflow
Type "wayper --json fav"
Enter
Sleep 2s

Type "wayper --json unfav"
Enter
Sleep 3s
