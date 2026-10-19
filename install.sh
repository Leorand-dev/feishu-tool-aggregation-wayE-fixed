#!/usr/bin/env bash
# Apply the Feishu tool-summary aggregation fix (wayE) to an installed
# @openclaw/feishu monitor bundle.
#
# Usage:
#   ./install.sh <path-to-installed-monitor.account-*.mjs>
#
# The target is the plugin's compiled bundle, typically found under:
#   <openclaw-home>/npm/projects/*/node_modules/@openclaw/feishu/dist/.setup/monitor.account-*.mjs
#
# The installer detects the target's build by hash, selects the matching
# per-version patch, and applies it. Idempotent: re-running on an
# already-patched file reports "already patched".
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# version -> "pristine_sha patched_sha patch_path"
VERSIONS=(
  "2026.10.5 72a0a198e31e71e4690e2b86296d53983863e99e8d3a0872ac4cbb83aefe3bfe 2b3af8e44abc4bd580ccdf27a77ba2e85e53c2a46051fedfa6d5c01ba9270c68 $HERE/patches/2026.10.5/feishu-tool-aggregation.patch"
)

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "usage: $0 <path-to-monitor.account-*.mjs>" >&2
  exit 2
fi
if [ ! -f "$TARGET" ]; then
  echo "error: not a file: $TARGET" >&2
  exit 2
fi

sum() { sha256sum "$1" | cut -d' ' -f1; }
CUR="$(sum "$TARGET")"

# already patched for any known version?
for v in "${VERSIONS[@]}"; do
  read -r ver porch pat patch <<<"$v"
  if [ "$CUR" = "$pat" ]; then
    echo "already patched (plugin build $ver; $TARGET)"
    exit 0
  fi
done

# find matching pristine build
MATCH=""
for v in "${VERSIONS[@]}"; do
  read -r ver porch pat patch <<<"$v"
  if [ "$CUR" = "$porch" ]; then
    MATCH="$ver $pat $patch"
    break
  fi
done

if [ -z "$MATCH" ]; then
  echo "error: $TARGET does not match any known pristine plugin build." >&2
  echo "  actual sha256: $CUR" >&2
  echo "Known pristine builds:" >&2
  for v in "${VERSIONS[@]}"; do read -r ver porch pat patch <<<"$v"; echo "  $ver  $porch" >&2; done
  echo "This patch targets specific builds; re-derive it for a new release." >&2
  exit 1
fi

read -r VER EXPECTED_PATCHED PATCH <<<"$MATCH"
BAK="$(dirname "$TARGET")/.monitor.backup-$(date -u +%Y%m%dT%H%M%SZ).mjs"
cp -p "$TARGET" "$BAK"
echo "backup: $BAK"
echo "applying patch for plugin build $VER"

if ! patch -p0 "$TARGET" < "$PATCH"; then
  echo "error: patch failed; restoring backup." >&2
  cp -p "$BAK" "$TARGET"
  rm -f "$TARGET.rej" "$TARGET.orig"
  exit 1
fi

NEW="$(sum "$TARGET")"
if [ "$NEW" != "$EXPECTED_PATCHED" ]; then
  echo "error: post-patch hash mismatch; restoring backup." >&2
  cp -p "$BAK" "$TARGET"
  exit 1
fi

echo "patched OK: $TARGET"
echo "sha256: $NEW"
echo "Restart the gateway for the change to take effect."
