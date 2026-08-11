# Live tutoring (learn-codebase compatible)

This is the interactive loop that matches the local **learn-codebase** skill pattern:

1. Toggle Live Explain **once** (status bar / Command Palette / panel).
2. Extension writes cursor state on every move (no Command Palette per symbol).
3. A small watcher wakes Cursor Agent with grounded context.
4. The agent uses this skill + Codegraph tools to tutor/explain.

## Runtime files

Primary (Codegraph):

```text
~/.cursor/codegraph/
  enabled            # present only while Live Explain is ON
  state.json         # latest path / line / selection
  wake.log           # append-only cursor-move events
  pending-prompt.md  # ready-to-paste agent prompt
```

Compatibility mirror (so an existing learn-codebase watcher still works):

```text
~/.cursor/learn-codebase/
  enabled
  state.json
  wake.log
  pending-prompt.md
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
6. Move the cursor / select symbols — panel updates immediately; watcher wakes Agent with the pending prompt.

## Stop

1. Toggle Live Explain OFF (removes `enabled`).
2. Stop the watcher (`Ctrl+C`).
3. Optionally tell Agent: `Stop live tutoring`.

## Agent behavior while tutoring

When woken for a live cursor move:

1. Read `~/.cursor/codegraph/state.json` / `pending-prompt.md` (or the learn-codebase mirror).
2. Prefer grounded facts already in `pending-prompt.md`; otherwise call `explain_selection` with `enrich` omitted/false.
3. Respond in **learn-codebase style**:
   - Location + short code citation
   - Purpose
   - Fields table
   - Valid shapes / examples when useful
   - Docstring/validator notes
   - End with: Ask about that, or keep moving.
4. No UI chatter about toggles, modes, enrichment status, or pills.
5. Do **not** ask for API keys.

## API key mode (same tutoring card)

When Live Explain is on with **API key provider**:

1. Panel shows a clean tutoring card (Purpose / Fields / Notes).
2. Extension enriches that card in-panel via the OpenAI-compatible provider.
3. No mode/toggle clutter in the panel — settings stay in VS Code Settings.

## What each piece owns

| Piece | Role |
| --- | --- |
| Codegraph VSIX | Toggle, panel facts, writes bridge files on cursor move |
| `watch-cursor.sh` | Tails `wake.log`, rate-limits, wakes Agent (clipboard / macOS automation) |
| This skill | Tutoring instructions + tool usage for grounded explanations |
| Deterministic core | Symbols, fields, validators, definitions, usages, sources |

The side panel stays useful even if Agent is not running — it shows deterministic structure immediately.
