#!/usr/bin/env bash
# Build single-binary releases of the print bridge for all supported OSes.
# Uses `bun build --compile` — the resulting binary is self-contained
# (Bun runtime + bundled JS + native deps embedded). End-users don't need
# Node, npm, or anything else installed.
#
#   ./build.sh              # build all targets
#   ./build.sh macos-arm64  # build one target only
#
# Output: bridge/dist/print-bridge-<target>[.exe]

set -euo pipefail

cd "$(dirname "$0")"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun not installed. Get it from https://bun.sh"
  exit 1
fi

TARGETS=("win-x64" "macos-arm64" "macos-x64" "linux-x64")
if [[ $# -gt 0 ]]; then
  TARGETS=("$@")
fi

mkdir -p dist

bun install --no-summary

for tgt in "${TARGETS[@]}"; do
  ext=""
  case "$tgt" in
    win-x64)     btarget="bun-windows-x64";   ext=".exe" ;;
    macos-arm64) btarget="bun-darwin-arm64" ;;
    macos-x64)   btarget="bun-darwin-x64" ;;
    linux-x64)   btarget="bun-linux-x64" ;;
    *) echo "Unknown target: $tgt"; exit 1 ;;
  esac
  outfile="dist/print-bridge-${tgt}${ext}"
  echo "==> building $outfile"
  bun build --compile --target="$btarget" --outfile="$outfile" ./src/index.mjs
  if [[ -z "$ext" ]]; then chmod +x "$outfile"; fi
done

echo
echo "Built:"
ls -lh dist/
