#!/usr/bin/env bash
set -euo pipefail

artifact="${1:-}"
destination="${2:-}"
mode="${3:-launch}"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS package launch smoke must run on macOS" >&2
  exit 2
fi
if [[ -z "$artifact" || ! -f "$artifact" || -L "$artifact" || -z "$destination" || ( "$mode" != "launch" && "$mode" != "stage-only" ) ]]; then
  echo "usage: stage-macos-smoke-app.sh <dmg-or-zip> <destination-app> [launch|stage-only]" >&2
  exit 2
fi
if [[ "$destination" != *.app ]]; then
  echo "destination must end in .app" >&2
  exit 2
fi

allowed_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
mkdir -p "$allowed_root"
allowed_root_real="$(cd "$allowed_root" && pwd -P)"
destination_parent="$(dirname "$destination")"
mkdir -p "$destination_parent"
destination_parent_real="$(cd "$destination_parent" && pwd -P)"
case "$destination_parent_real" in
  "$allowed_root_real"|"$allowed_root_real"/*) ;;
  *) echo "refusing destination outside the temporary root: $destination_parent_real" >&2; exit 2 ;;
esac
destination="$destination_parent_real/$(basename "$destination")"

safe_remove_directory() {
  local target="$1"
  [[ ! -e "$target" && ! -L "$target" ]] && return
  if [[ -L "$target" ]]; then
    echo "refusing recursive removal of symlink: $target" >&2
    exit 1
  fi
  local target_parent_real target_real
  target_parent_real="$(cd "$(dirname "$target")" && pwd -P)"
  target_real="$target_parent_real/$(basename "$target")"
  case "$target_real" in
    "$allowed_root_real"/*) rm -rf -- "$target_real" ;;
    *) echo "refusing cleanup outside the temporary root: $target_real" >&2; exit 1 ;;
  esac
}

scratch="$(mktemp -d "$allowed_root_real/lnwjing-installed-smoke.XXXXXX")"
device=''
cleanup() {
  if [[ -n "${destination:-}" ]]; then
    while IFS= read -r candidate_pid; do
      [[ -n "$candidate_pid" ]] && kill -TERM "$candidate_pid" >/dev/null 2>&1 || true
    done < <(pgrep -f "$destination/Contents/MacOS/lnwjing" 2>/dev/null || true)
  fi
  if [[ -n "$device" ]]; then hdiutil detach "$device" >/dev/null 2>&1 || true; fi
  safe_remove_directory "$scratch"
}

dump_launch_diagnostics() {
  echo "--- macOS launch diagnostics ---" >&2
  sw_vers >&2 || true
  uname -a >&2 || true
  shasum -a 256 "$artifact" >&2 || true
  if [[ -d "${destination:-}" ]]; then
    codesign --display --verbose=4 "$destination" >&2 || true
    if [[ -f "$destination/Contents/MacOS/lnwjing" ]]; then
      codesign --display --entitlements :- "$destination/Contents/MacOS/lnwjing" >&2 || true
    fi
  fi
  /usr/bin/log show --last 2m --style compact --predicate 'process == "lnwjing" OR eventMessage CONTAINS[c] "lnwjing"' 2>/dev/null | tail -n 120 >&2 || true
  echo "--- end macOS launch diagnostics ---" >&2
}
trap cleanup EXIT

case "$artifact" in
  *.dmg)
    mount_point="$scratch/mount"
    mkdir -p "$mount_point"
    device="$(hdiutil attach -nobrowse -readonly -mountpoint "$mount_point" "$artifact" | awk 'END { print $1 }')"
    source_app="$(find "$mount_point" -maxdepth 2 -name 'lnwjing.app' -type d -print -quit)"
    ;;
  *.zip)
    extract_root="$scratch/extracted"
    mkdir -p "$extract_root"
    ditto -x -k "$artifact" "$extract_root"
    source_app="$(find "$extract_root" -maxdepth 3 -name 'lnwjing.app' -type d -print -quit)"
    ;;
  *)
    echo "expected a .dmg or .zip macOS artifact" >&2
    exit 2
    ;;
esac

if [[ -z "${source_app:-}" || ! -d "$source_app" ]]; then
  echo "lnwjing.app was not found in the packaged artifact" >&2
  exit 1
fi
safe_remove_directory "$destination"
ditto "$source_app" "$destination"

executable="$destination/Contents/MacOS/lnwjing"
if [[ ! -f "$executable" || -L "$executable" || ! -x "$executable" ]]; then
  echo "installed macOS executable is invalid: $executable" >&2
  exit 1
fi
codesign --verify --deep --strict "$destination"

if [[ "$mode" == "stage-only" ]]; then
  echo "Staged macOS package without launching: $destination" >&2
  echo "$destination"
  exit 0
fi

# Launch through LaunchServices, not by exec'ing the Mach-O directly. This is
# the boundary a user hits after copying the app out of the DMG/ZIP.
open -n "$destination"
pid=''
for _ in {1..30}; do
  pid="$(pgrep -f "$executable" | head -n 1 || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 1
done
if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
  echo "LaunchServices did not keep lnwjing running from the packaged app" >&2
  dump_launch_diagnostics
  exit 1
fi
sleep 3
if ! kill -0 "$pid" 2>/dev/null; then
  echo "lnwjing exited during packaged LaunchServices startup smoke" >&2
  dump_launch_diagnostics
  exit 1
fi
kill -TERM "$pid" 2>/dev/null || true
for _ in {1..20}; do
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 0.25
done
if kill -0 "$pid" 2>/dev/null; then
  kill -KILL "$pid" 2>/dev/null || true
fi

echo "Installed macOS package launch smoke passed: $destination" >&2
echo "$executable"
