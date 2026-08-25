#!/usr/bin/env bash
# Package the portable Codegraph skill as an importable ZIP for Claude/Cursor/etc.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SKILL_SRC}/../.." && pwd)"
OUT_DIR="${REPO_ROOT}/artifacts"
OUT_ZIP="${OUT_DIR}/codegraph-skill.zip"

mkdir -p "$OUT_DIR"
rm -f "$OUT_ZIP"

# Zip so the archive root is the skill directory (SKILL.md at top level when unzipped as codegraph/).
(
  cd "$(dirname "$SKILL_SRC")"
  zip -r "$OUT_ZIP" "$(basename "$SKILL_SRC")" \
    -x "*/.DS_Store" \
    -x "**/.DS_Store"
)

echo "Packaged importable skill: $OUT_ZIP"
echo "Import by unzipping into an agent skills folder, or upload the ZIP where supported."
