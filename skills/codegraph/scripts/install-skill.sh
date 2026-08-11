#!/usr/bin/env bash
# Install/import the Codegraph Agent Skill into Cursor, Claude, or Codex skill dirs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET="cursor"
SCOPE="project"
MODE="link"
PROJECT_ROOT="$(pwd)"

usage() {
  cat <<'EOF'
Usage:
  install-skill.sh [--target cursor|claude|agents|all] [--scope project|user] [--mode link|copy]

Examples:
  install-skill.sh --target cursor
  install-skill.sh --target claude --scope user --mode copy
  install-skill.sh --target all
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

resolve_dest_parent() {
  local product="$1"
  if [[ "$SCOPE" == "user" ]]; then
    case "$product" in
      cursor) echo "${HOME}/.cursor/skills" ;;
      claude) echo "${HOME}/.claude/skills" ;;
      agents) echo "${HOME}/.agents/skills" ;;
      *) return 1 ;;
    esac
  else
    case "$product" in
      cursor) echo "${PROJECT_ROOT}/.cursor/skills" ;;
      claude) echo "${PROJECT_ROOT}/.claude/skills" ;;
      agents) echo "${PROJECT_ROOT}/.agents/skills" ;;
      *) return 1 ;;
    esac
  fi
}

install_one() {
  local product="$1"
  local parent dest
  parent="$(resolve_dest_parent "$product")"
  dest="${parent}/codegraph"
  mkdir -p "$parent"
  rm -rf "$dest"
  if [[ "$MODE" == "copy" ]]; then
    mkdir -p "$dest"
    cp -R "$SKILL_SRC/." "$dest/"
    echo "Copied skill -> $dest"
  else
    ln -sfn "$SKILL_SRC" "$dest"
    echo "Linked skill -> $dest"
  fi
}

if [[ "$TARGET" == "all" ]]; then
  install_one cursor
  install_one claude
  install_one agents
else
  install_one "$TARGET"
fi

echo
echo "Next: configure MCP (recommended) using skills/codegraph/assets/mcp.*.json"
echo "Then restart the agent host."
