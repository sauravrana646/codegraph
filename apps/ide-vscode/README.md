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

Turn it on **once**, then keep coding — no Command Palette on every symbol.

1. Click the status bar **Codegraph Live: OFF** (or run **Codegraph: Toggle Live Explain Mode** once).
2. Open a Python file.
3. Move the cursor or select a symbol — the side panel updates automatically with deterministic facts/sources.
4. When you want subscription-model narrative, click **Enrich & Explain with Agent** in the panel (optional, on demand).

Live Explain stays in-panel. It does **not** open Cursor Agent chat on every cursor move.

Toggle off the same way (status bar, panel button, or Command Palette).

Settings:

- `codegraph.liveExplain.enabled` — persisted on/off
- `codegraph.liveExplain.debounceMs` — delay before refresh (default 450)
- `codegraph.liveExplain.pythonOnly` — only auto-explain Python editors (default on)

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
