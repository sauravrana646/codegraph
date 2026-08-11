# Codegraph VS Code / Cursor extension

Importable IDE extension for local Python-first code understanding.

## Install from VSIX

From the repo root:

```bash
npm install
npm run package:extension
```

This writes `artifacts/codegraph-extension.vsix`.

Then in Cursor / VS Code:

1. Command Palette → **Extensions: Install from VSIX…**
2. Select `artifacts/codegraph-extension.vsix`
3. Reload the window

Or from a terminal:

```bash
cursor --install-extension ./artifacts/codegraph-extension.vsix
```

## Live Explain (recommended)

Turn Live ON once, then **only move your cursor** — no typing, no Enter.

**Agent mode (default):** a slim pointer (`codegraph-slim-v3`) is auto-sent to Cursor Agent chat. Agent reads the source and explains. On macOS, allow **Accessibility** for Cursor the first time (System Settings → Privacy & Security → Accessibility).

**API key mode:** a short source window is enriched in the Codegraph panel (no AST/LSP context packs).

Settings:

- `codegraph.liveExplain.enabled` — persisted on/off
- `codegraph.liveExplain.debounceMs` — delay before refresh (default 450)
- `codegraph.liveExplain.pythonOnly` — only auto-explain Python editors (default on)
- `codegraph.liveExplain.writeAgentBridge` — write `~/.cursor/codegraph/` bridge files (default on)
- `codegraph.liveExplain.compatLearnCodebase` — also mirror to `~/.cursor/learn-codebase/` (default on)

## Commands

- `Codegraph: Toggle Live Explain Mode` — continuous explain on/off
- `Codegraph: Explain Selection` — one-shot explain for the current cursor/selection
- `Codegraph: Enrich & Explain with Agent` — hand off grounded context to Cursor/Claude agent
- `Codegraph: Find Definition`
- `Codegraph: Find Usages`

### Model access checkboxes

In the explanation panel (and in Settings → Codegraph), pick **one**:

- **Built-in Cursor/Claude agent** (default) — subscription model does **enrichment + explanation** when you ask (no API key)
- **API key provider** — OpenAI-compatible key does **enrichment** in-panel (including during Live Explain)

`autoEnrichOnExplain` (default **off**) only affects **manual** Explain Selection in agent mode. It never fires on Live Explain cursor moves.

## Pair with the Agent Skill

For agent workflows (Cursor Agent / Claude / Codex), also import the portable skill:

```bash
npm run package:skill
# or
skills/codegraph/scripts/install-skill.sh --target cursor
```

See `skills/codegraph/README.md`.
