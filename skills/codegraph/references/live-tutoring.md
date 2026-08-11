# Live tutoring (learn-codebase compatible)

This is the interactive loop that matches the local **learn-codebase** skill pattern:

1. Toggle Live Explain **once** (status bar / Command Palette / panel).
2. Extension writes cursor state on every move (no Command Palette per symbol).
3. A small watcher / auto-handoff wakes Cursor Agent with a **slim pointer** (file / line / symbol + tool instructions) — not a large AST dump.
4. The agent **pulls** grounded facts via Codegraph tools, then tutors/explains.

## Runtime files

Primary (Codegraph):

```text
~/.cursor/codegraph/
  enabled            # present only while Live Explain is ON
  state.json         # latest path / line / selection
  wake.log           # append-only cursor-move events
  pending-prompt.md  # slim pointer + required tool flow (not a full code dump)
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

1. Install/reload the Codegraph VSIX.
2. Install this skill (`npm run install:skill` or copy `skills/codegraph` → `~/.cursor/skills/codegraph`).
3. In a terminal:

   ```bash
   chmod +x skills/codegraph/scripts/watch-cursor.sh
   skills/codegraph/scripts/watch-cursor.sh
   ```

   Or point at your existing learn-codebase dir:

   ```bash
   CODEGRAPH_WATCH_DIR=~/.cursor/learn-codebase skills/codegraph/scripts/watch-cursor.sh
   ```

4. In Cursor: **Codegraph: Toggle Live Explain Mode** → ON.
5. Open Agent chat once and say: `Start Codegraph live tutoring` (or `/codegraph`).
6. Move the cursor / select symbols — watcher / auto-handoff wakes Agent with the slim pending prompt; Agent fetches details via tools.

## Stop

1. Toggle Live Explain OFF (removes `enabled`).
2. Stop the watcher (`Ctrl+C`).
3. Optionally tell Agent: `Stop live tutoring`.

## Agent behavior while tutoring

When woken for a live cursor move:

1. Read the slim pointer in `~/.cursor/codegraph/state.json` / `pending-prompt.md` (or the learn-codebase mirror).
2. **Always pull data with tools** — call `explain_selection` with `enrich` omitted/false; then `find_definition` / `find_usages` / `logical_section` as needed. Do not invent from the pointer alone.
3. Only after tools return, respond in **learn-codebase style**:
   - Location + short code citation
   - Purpose
   - Fields table
   - Valid shapes / examples when useful
   - Docstring/validator notes
   - End with: Ask about that, or keep moving.
4. No UI chatter about toggles, modes, enrichment status, or pills.
5. Do **not** ask for API keys.
6. Keep token use low: small input prompt + selective tool calls beats dumping whole files into chat.

## API key mode (same tutoring card)

When Live Explain is on with **API key provider**:

1. Panel shows a clean tutoring card (Purpose / Fields / Notes).
2. Extension enriches that card in-panel via the OpenAI-compatible provider.
3. No mode/toggle clutter in the panel — settings stay in VS Code Settings.

## What each piece owns

| Piece | Role |
| --- | --- |
| Codegraph VSIX | Toggle, slim Agent handoff, writes bridge files on cursor move |
| `watch-cursor.sh` | Tails `wake.log`, rate-limits, wakes Agent with slim prompt |
| This skill | Tutoring instructions + **required tool pull** for grounded explanations |
| Deterministic core / MCP | Symbols, fields, validators, definitions, usages, sources (fetched on demand) |

API key mode still uses the in-panel enrichment path (full structured facts over HTTP). Agent mode keeps prompts small and relies on tools.
