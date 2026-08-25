#!/usr/bin/env bash
# Thin CLI fallback for agents that do not have Codegraph MCP tools loaded.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SKILL_ROOT}/../.." && pwd)"
CODEGRAPH_ROOT="${CODEGRAPH_ROOT:-$REPO_ROOT}"
RUNTIME_ENTRY="${CODEGRAPH_ROOT}/apps/runtime/dist/index.js"

usage() {
  cat <<'EOF'
Usage:
  codegraph.sh explain <rootPath> <filePath> <line> [selectedText]
  codegraph.sh definition <rootPath> <filePath> <line> [selectedText]
  codegraph.sh usages <rootPath> <filePath> <line> [selectedText]
  codegraph.sh section <rootPath> <filePath> <line> [selectedText] [depth]
  codegraph.sh serve [port]

Environment:
  CODEGRAPH_ROOT            Absolute path to the Codegraph repo (default: inferred from this skill)
  CODEGRAPH_RUNTIME_TOKEN   Bearer token forwarded to the runtime HTTP API
  CODEGRAPH_ALLOWED_ROOTS   Path-delimiter list of allowed workspace roots
EOF
}

require_runtime() {
  if [[ ! -f "$RUNTIME_ENTRY" ]]; then
    echo "Codegraph runtime not built at: $RUNTIME_ENTRY" >&2
    echo "Run: cd \"$CODEGRAPH_ROOT\" && npm install && npm run build" >&2
    exit 1
  fi
}

curl_json() {
  local url="$1"
  local payload="${2:-}"
  local -a headers=()
  if [[ -n "${CODEGRAPH_RUNTIME_TOKEN:-}" ]]; then
    headers+=(-H "Authorization: Bearer ${CODEGRAPH_RUNTIME_TOKEN}")
  fi
  if [[ -n "$payload" ]]; then
    curl -fsS -X POST "$url" \
      -H "content-type: application/json" \
      "${headers[@]}" \
      -d "$payload"
  else
    curl -fsS "$url" "${headers[@]}"
  fi
}

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi
  python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
}

post_tool() {
  local tool="$1"
  local root_path="$2"
  local file_path="$3"
  local line="$4"
  local selected_text="${5:-}"
  local depth="${6:-}"
  local port="${CODEGRAPH_PORT:-4311}"
  local payload

  payload="$(SELECTED_TEXT="$selected_text" DEPTH="$depth" ROOT_PATH="$root_path" FILE_PATH="$file_path" LINE="$line" python3 - <<'PY'
import json, os
payload = {
  "rootPath": os.environ["ROOT_PATH"],
  "filePath": os.environ["FILE_PATH"],
  "line": int(os.environ["LINE"]),
}
selected = os.environ.get("SELECTED_TEXT") or None
depth = os.environ.get("DEPTH") or None
if selected:
  payload["selectedText"] = selected
if depth:
  payload["depth"] = depth
print(json.dumps(payload))
PY
)"

  if command -v curl >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    curl_json "http://127.0.0.1:${port}/v1/tools/${tool}" "$payload"
    echo
    return
  fi

  case "$tool" in
    explain-selection)
      require_runtime
      if [[ -n "$selected_text" ]]; then
        node "$RUNTIME_ENTRY" explain "$root_path" "$file_path" "$line" "$selected_text"
      else
        node "$RUNTIME_ENTRY" explain "$root_path" "$file_path" "$line"
      fi
      ;;
    *)
      require_runtime
      local tmp_port=$((4300 + RANDOM % 200))
      local tmp_log
      tmp_log="$(mktemp -t codegraph-skill-serve.XXXXXX)"
      if [[ -z "${CODEGRAPH_RUNTIME_TOKEN:-}" ]]; then
        CODEGRAPH_RUNTIME_TOKEN="$(generate_token)"
        export CODEGRAPH_RUNTIME_TOKEN
      fi
      node "$RUNTIME_ENTRY" serve "$tmp_port" >"$tmp_log" 2>&1 &
      local pid=$!
      cleanup() { kill "$pid" >/dev/null 2>&1 || true; rm -f "$tmp_log"; }
      trap cleanup EXIT
      for _ in $(seq 1 30); do
        if curl -fsS "http://127.0.0.1:${tmp_port}/health" >/dev/null 2>&1; then
          break
        fi
        sleep 0.1
      done
      curl_json "http://127.0.0.1:${tmp_port}/v1/tools/${tool}" "$payload"
      echo
      cleanup
      trap - EXIT
      ;;
  esac
}

cmd="${1:-}"
shift || true

case "$cmd" in
  explain)
    [[ $# -ge 3 ]] || { usage; exit 1; }
    post_tool "explain-selection" "$1" "$2" "$3" "${4:-}"
    ;;
  definition)
    [[ $# -ge 3 ]] || { usage; exit 1; }
    post_tool "find-definition" "$1" "$2" "$3" "${4:-}"
    ;;
  usages)
    [[ $# -ge 3 ]] || { usage; exit 1; }
    post_tool "find-usages" "$1" "$2" "$3" "${4:-}"
    ;;
  section)
    [[ $# -ge 3 ]] || { usage; exit 1; }
    post_tool "logical-section" "$1" "$2" "$3" "${4:-}" "${5:-auto}"
    ;;
  serve)
    require_runtime
    node "$RUNTIME_ENTRY" serve "${1:-4311}"
    ;;
  -h|--help|help|"")
    usage
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    usage
    exit 1
    ;;
esac
