#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s [--output PATH.png] [--timeout SECONDS]\n' "${0##*/}"
}

skill_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd -- "$skill_dir/../../.." && pwd)"
electron_dir="$repo_root/wayper/electron"
electron_bin="$electron_dir/node_modules/.bin/electron"
output_path=""
timeout_seconds=15

while (($#)); do
  case "$1" in
    --output)
      (($# >= 2)) || { usage >&2; exit 2; }
      output_path="$2"
      shift 2
      ;;
    --timeout)
      (($# >= 2)) || { usage >&2; exit 2; }
      timeout_seconds="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$timeout_seconds" =~ ^[0-9]+$ ]] || {
  printf 'Timeout must be an integer number of seconds.\n' >&2
  exit 2
}
((timeout_seconds >= 1 && timeout_seconds <= 60)) || {
  printf 'Timeout must be between 1 and 60 seconds.\n' >&2
  exit 2
}

test -x "$electron_bin" || {
  printf 'Electron is unavailable at %s; run npm ci in %s first.\n' \
    "$electron_bin" "$electron_dir" >&2
  exit 1
}
pgrep -f '[w]ayper-gui' >/dev/null || {
  printf 'wayper-gui is not running. Start it before requesting an internal capture.\n' >&2
  exit 1
}

if test -z "$output_path"; then
  capture_dir="$(mktemp -d "${TMPDIR:-/tmp}/wayper-electron-capture.XXXXXX")"
  output_path="$capture_dir/wayper.png"
else
  [[ "$output_path" == *.png ]] || {
    printf 'Output path must end in .png.\n' >&2
    exit 2
  }
  output_dir="$(cd -- "$(dirname -- "$output_path")" && pwd)"
  output_path="$output_dir/$(basename -- "$output_path")"
  test ! -e "$output_path" || {
    printf 'Refusing to overwrite existing output: %s\n' "$output_path" >&2
    exit 1
  }
fi

(
  cd -- "$electron_dir"
  WAYPER_DEV=1 "$electron_bin" . "--wayper-capture=$output_path"
) >/dev/null 2>&1 || true

poll_count=$((timeout_seconds * 10))
for ((attempt = 0; attempt < poll_count; attempt += 1)); do
  if test -s "$output_path"; then
    signature="$(od -An -tx1 -N8 "$output_path" | tr -d ' \n')"
    if test "$signature" = '89504e470d0a1a0a'; then
      printf '%s\n' "$output_path"
      exit 0
    fi
  fi
  sleep 0.1
done

printf 'Electron did not produce a PNG within %s seconds. Restart wayper-gui so it loads the capture hook, then retry.\n' \
  "$timeout_seconds" >&2
exit 1
