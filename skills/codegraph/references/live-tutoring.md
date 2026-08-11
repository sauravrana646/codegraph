# Live tutoring (learn-codebase compatible)

This is the interactive loop that matches the local **learn-codebase** skill pattern:

1. Toggle Live Explain **once** (status bar / Command Palette).
2. Extension writes cursor state on every move (no Command Palette per symbol).
3. Auto-handoff / watcher wakes Cursor Agent with a **slim pointer** only (`codegraph-slim-v3`).
4. Agent **reads the source** (or a bounded section tool) and explains — no AST/LSP context packs on any path.

## Runtime files

Primary (Codegraph):

```text
~/.cursor/codegraph/
  enabled            # present only while Live Explain is ON
  state.json         # latest path / line / selection
  wake.log           # append-only cursor-move events
  pending-prompt.md  # slim pointer (codegraph-slim-v3)
```

Compatibility mirror (so an existing learn-codebase watcher still works):

```text
~/.cursor/learn-codebase/
  enabled
  state.json
  wake.log
  pending-prompt.md  # same slim pointer
```

Settings:

- `codegraph.liveExplain.writeAgentBridge` (default on)
- `codegraph.liveExplain.compatLearnCodebase` (default on)

## Start

1. Install/reload the Codegraph VSIX (**0.1.2+**).
2. Install this skill (`npm run install:skill` or copy `skills/codegraph` → `~/.cursor/skills/codegraph`).
3. In a terminal (optional watcher):

   ```bash
   chmod +x skills/codegraph/scripts/watch-cursor.sh
   skills/codegraph/scripts/watch-cursor.sh
   ```

4. In Cursor: **Codegraph: Toggle Live Explain Mode** → ON.
5. Open Agent chat once and say: `Start Codegraph live tutoring` (or `/codegraph`).
6. Move the cursor — Agent gets `codegraph-slim-v3` pointer and reads source itself.

## Stop

1. Toggle Live Explain OFF (removes `enabled`).
2. Stop the watcher (`Ctrl+C`) if running.
3. Optionally tell Agent: `Stop live tutoring`.

## Agent behavior while tutoring

When woken for a live cursor move:

1. Read the slim pointer in `~/.cursor/codegraph/state.json` / `pending-prompt.md`.
2. Open/read the file around `line` (or `logical_section` / `explain_selection` for a bounded window).
3. Optionally use `find_definition` / `find_usages` for `file:line` locations only.
4. Respond in **learn-codebase style** (Purpose / Fields / Notes / keep moving).
5. Do **not** ask for API keys, AST dumps, or LSP context.

## API key mode

1. Extension builds a **source window** + file:line index (no IDE LSP gather).
2. Panel enriches via OpenAI-compatible provider.
3. Still no AST/LSP context packs in the prompt — only the source window.

## What each piece owns

| Piece | Role |
| --- | --- |
| Codegraph VSIX | Toggle, slim pointer handoff, bridge files |
| `watch-cursor.sh` | Optional wake helper with the same slim prompt |
| This skill | Tutoring instructions + read-source workflow |
| MCP tools | Bounded section / location lookups on demand |
