#!/usr/bin/env bash
# Codegraph live tutoring watcher (learn-codebase compatible).
#
# Watches ~/.cursor/codegraph/wake.log (and can point at learn-codebase) and wakes
# Cursor Agent with grounded explain context when Live Explain is ON.
#
# Usage:
#   skills/codegraph/scripts/watch-cursor.sh
#   CODEGRAPH_WATCH_DIR=~/.cursor/learn-codebase skills/codegraph/scripts/watch-cursor.sh
#
# Requires: Live Explain ON in the Codegraph extension (creates `enabled`).

set -euo pipefail

WATCH_DIR="${CODEGRAPH_WATCH_DIR:-$HOME/.cursor/codegraph}"
FALLBACK_DIR="${CODEGRAPH_WATCH_FALLBACK:-$HOME/.cursor/learn-codebase}"
MIN_INTERVAL_MS="${CODEGRAPH_WAKE_MIN_MS:-2500}"
LAST_WAKE_MS=0
LAST_KEY=""

resolve_dir() {
  if [[ -d "$WATCH_DIR" ]]; then
    echo "$WATCH_DIR"
    return
  fi
  if [[ -d "$FALLBACK_DIR" ]]; then
    echo "$FALLBACK_DIR"
    return
  fi
  mkdir -p "$WATCH_DIR"
  echo "$WATCH_DIR"
}

DIR="$(resolve_dir)"
STATE_FILE="$DIR/state.json"
WAKE_FILE="$DIR/wake.log"
ENABLED_FILE="$DIR/enabled"
PROMPT_FILE="$DIR/pending-prompt.md"

touch "$WAKE_FILE"

log() {
  printf '[codegraph-watch] %s\n' "$*" >&2
}

now_ms() {
  python3 -c 'import time; print(int(time.time() * 1000))'
}

is_enabled() {
  [[ -f "$ENABLED_FILE" ]]
}

build_prompt_from_state() {
  if [[ -f "$PROMPT_FILE" ]]; then
    cat "$PROMPT_FILE"
    return
  fi
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "Codegraph live wake with no state.json"
    return
  fi
  STATE_FILE="$STATE_FILE" python3 - <<'PY'
import json, os, pathlib
state = json.loads(pathlib.Path(os.environ["STATE_FILE"]).read_text())
symbol = state.get("selection") or state.get("selectedText") or "(cursor only)"
print(
    "codegraph-slim-v2\n"
    "Use the Codegraph skill / MCP tools.\n"
    "Codegraph Live Explain — answer in this Agent chat.\n"
    "Do not ask for API keys.\n"
    "Do NOT paste or wait for large code dumps; fetch with tools.\n\n"
    "TARGET:\n"
    f"rootPath: {state.get('rootPath', '')}\n"
    f"filePath: {state.get('filePath') or state.get('path', '')}\n"
    f"line: {state.get('line', 1)}\n"
    f"symbol: {symbol}\n\n"
    "REQUIRED TOOL FLOW (pull data yourself):\n"
    "1) Call Codegraph explain_selection with enrich omitted/false.\n"
    "2) If needed, call find_definition and/or find_usages.\n"
    "3) Optionally logical_section for surrounding class/function.\n"
    "4) Only after tools return, write the tutoring answer.\n\n"
    "Cite only tool file:line sources; never invent files/symbols; keep it concise.\n"
)
PY
}

copy_prompt() {
  local prompt="$1"
  if command -v pbcopy >/dev/null 2>&1; then
    printf '%s' "$prompt" | pbcopy
    return 0
  fi
  if command -v xclip >/dev/null 2>&1; then
    printf '%s' "$prompt" | xclip -selection clipboard
    return 0
  fi
  if command -v wl-copy >/dev/null 2>&1; then
    printf '%s' "$prompt" | wl-copy
    return 0
  fi
  return 1
}

wake_cursor_agent() {
  local prompt
  prompt="$(build_prompt_from_state)"
  copy_prompt "$prompt" || true

  if command -v osascript >/dev/null 2>&1; then
    osascript <<'APPLESCRIPT' >/dev/null 2>&1 || true
tell application "Cursor" to activate
delay 0.2
tell application "System Events"
  -- Focus Agent / Composer (Cursor)
  keystroke "i" using {command down}
  delay 0.25
  keystroke "v" using {command down}
  delay 0.2
  key code 36 -- Return / submit
end tell
APPLESCRIPT
    log "Sent prompt to Cursor Agent (Cmd+I, paste, Enter)."
    return
  fi

  log "Wake event ready at $PROMPT_FILE (open Agent chat and paste; clipboard used when available)."
}

state_key() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo ""
    return
  fi
  STATE_FILE="$STATE_FILE" python3 - <<'PY'
import json, os, pathlib
state = json.loads(pathlib.Path(os.environ["STATE_FILE"]).read_text())
print(
    f"{state.get('absolutePath') or state.get('path')}:{state.get('line')}:"
    f"{state.get('selection') or state.get('selectedText') or ''}"
)
PY
}

handle_wake() {
  if ! is_enabled; then
    log "Live Explain is OFF (missing $ENABLED_FILE) — ignoring wake."
    return
  fi

  local key now
  key="$(state_key)"
  now="$(now_ms)"
  if [[ -n "$key" && "$key" == "$LAST_KEY" ]]; then
    return
  fi
  if (( now - LAST_WAKE_MS < MIN_INTERVAL_MS )); then
    return
  fi
  LAST_WAKE_MS="$now"
  LAST_KEY="$key"
  log "Wake for $key"
  wake_cursor_agent
}

log "Watching $WAKE_FILE (enabled marker: $ENABLED_FILE)"
log "Toggle Codegraph Live Explain ON, then move the cursor in a Python file."

if [[ -s "$WAKE_FILE" ]]; then
  handle_wake || true
fi

tail -n 0 -F "$WAKE_FILE" | while IFS= read -r _; do
  handle_wake || true
done
