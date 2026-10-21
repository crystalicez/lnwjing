#!/usr/bin/env bash
set -euo pipefail

# Target-native, read-only acceptance helper. It never signs, notarizes, or
# publishes an artifact; those operations belong to protected release CI.
artifact="${1:-}"
if [[ -z "$artifact" || ! -f "$artifact" || -L "$artifact" ]]; then
  echo "usage: verify-macos-release.sh <dmg-or-zip>" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS release verification must run on macOS" >&2
  exit 2
fi

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "$script_directory/.." && pwd -P)"
temporary_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
mkdir -p "$temporary_root"
temporary_root_real="$(cd "$temporary_root" && pwd -P)"
mount_point=''
device=''

require_regular_executable() {
  local file="$1"
  if [[ ! -f "$file" || -L "$file" || ! -x "$file" ]]; then
    echo "required runtime is not a regular executable: $file" >&2
    exit 1
  fi
}

require_regular_file() {
  local file="$1"
  if [[ ! -f "$file" || -L "$file" ]]; then
    echo "required runtime manifest is not a regular file: $file" >&2
    exit 1
  fi
}

safe_remove_directory() {
  local target="$1"
  [[ -z "$target" || ! -d "$target" ]] && return
  local target_real
  target_real="$(cd "$target" && pwd -P)"
  case "$target_real" in
    "$temporary_root_real"/lnwjing-macos-verify.*) rm -rf -- "$target_real" ;;
    *) echo "refusing cleanup outside the temporary root: $target_real" >&2 ;;
  esac
}

cleanup() {
  if [[ -n "$device" ]]; then hdiutil detach "$device" >/dev/null 2>&1 || true; fi
  safe_remove_directory "$mount_point"
}
trap cleanup EXIT

case "$artifact" in
  *.dmg)
    hdiutil verify "$artifact" >/dev/null
    mount_point="$(mktemp -d "$temporary_root_real/lnwjing-macos-verify.XXXXXX")"
    device="$(hdiutil attach -nobrowse -readonly -mountpoint "$mount_point" "$artifact" | awk 'END { print $1 }')"
    app_path="$(find "$mount_point" -maxdepth 2 -name 'lnwjing.app' -type d -print -quit)"
    ;;
  *.zip)
    mount_point="$(mktemp -d "$temporary_root_real/lnwjing-macos-verify.XXXXXX")"
    ditto -x -k "$artifact" "$mount_point"
    app_path="$(find "$mount_point" -maxdepth 3 -name 'lnwjing.app' -type d -print -quit)"
    ;;
  *)
    echo "expected a .dmg or .zip macOS artifact" >&2
    exit 2
    ;;
esac

if [[ -z "${app_path:-}" || ! -d "$app_path" || -L "$app_path" ]]; then
  echo "lnwjing.app was not found in the artifact" >&2
  exit 1
fi
require_regular_executable "$app_path/Contents/MacOS/lnwjing"
require_regular_executable "$app_path/Contents/Resources/lnwjing-mcp-stdio"
require_regular_executable "$app_path/Contents/Resources/runtime-tools/ripgrep/rg"
require_regular_executable "$app_path/Contents/Resources/tunnel-client/tunnel-client"

provenance_path="$(dirname "$artifact")/PROVENANCE.json"
require_regular_file "$provenance_path"
runtime_arch="$(node -e '
  const fs = require("node:fs");
  const provenance = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (provenance.platform !== "darwin" || !["arm64", "x64"].includes(provenance.arch)) process.exit(1);
  process.stdout.write(provenance.arch);
' "$provenance_path")"
machine_arch="$(uname -m)"
case "$runtime_arch/$machine_arch" in
  arm64/arm64|x64/x86_64) ;;
  *) echo "macOS artifact architecture does not match verifier host: artifact=$runtime_arch host=$machine_arch" >&2; exit 1 ;;
esac
require_regular_executable "$app_path/Contents/Resources/native-host/macos/$runtime_arch/lnwjing-macos-host"
require_regular_file "$app_path/Contents/Resources/native-host/macos/$runtime_arch/NATIVE_HOST.json"

if ! /usr/bin/codesign --verify --deep --strict "$app_path" >/dev/null 2>&1; then
  echo "macOS distributable must be signed (ad-hoc community or Developer ID): $app_path" >&2
  exit 1
fi
policy_json="$(node "$repository_root/apps/desktop/scripts/inspect-macos-signing-policy.mjs" \
  --app "$app_path" --arch "$runtime_arch" --provenance "$provenance_path")"
signing_mode="$(node -e '
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => process.stdout.write(JSON.parse(Buffer.concat(chunks)).mode));
' <<<"$policy_json")"
printf '%s\n' "$policy_json"
echo "macOS effective signing policy verified: $signing_mode"

if [[ "${LNWJING_REQUIRE_CODESIGN:-0}" == "1" && "$signing_mode" != "certificate" ]]; then
  echo "LNWJING_REQUIRE_CODESIGN=1 requires a real Developer ID certificate, not ad-hoc signing" >&2
  exit 1
fi
if [[ "${LNWJING_REQUIRE_NOTARIZATION:-0}" == "1" ]]; then
  if [[ "$signing_mode" != "certificate" ]]; then
    echo "notarization requires Developer ID certificate signing" >&2
    exit 1
  fi
  /usr/bin/codesign --verify --deep --strict --test-requirement '=anchor apple generic' "$app_path"
  spctl --assess --type execute "$app_path"
  xcrun stapler validate "$app_path"
fi
echo "macOS artifact verification completed: $artifact"
