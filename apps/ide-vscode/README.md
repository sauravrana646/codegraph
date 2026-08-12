# Codegraph VS Code / Cursor extension

![Codegraph icon](media/icon-256.png)

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

**Status bar (left):** `CG Live: ON/OFF` toggles Live Explain; `CG Depth: Short|Standard|Deep` sets answer depth.

- **Short** — purpose only  
- **Standard** — purpose + fields + notes  
- **Deep** — use case, concrete example, why-not-simpler alternatives, and why this design is better

**Agent mode (default):** a slim pointer (`codegraph-slim-v3`) is auto-sent to Cursor Agent chat. Agent reads the source and explains. On macOS, allow **Accessibility** for Cursor the first time (System Settings → Privacy & Security → Accessibility).

**API key mode:** pick a provider (OpenRouter, OpenAI, Groq, Gemini, …); base URL is set automatically. You only enter **API key** + **model**. Enrichment shows in the Codegraph panel.

Command: **Codegraph: Configure API Provider**

Settings:

- `codegraph.liveExplain.enabled` — persisted on/off
- `codegraph.liveExplain.debounceMs` — delay before refresh (default 450)
- `codegraph.liveExplain.pythonOnly` — only auto-explain Python editors (default on)
- `codegraph.liveExplain.writeAgentBridge` — write `~/.cursor/codegraph/` bridge files (default on)
- `codegraph.liveExplain.compatLearnCodebase` — also mirror to `~/.cursor/learn-codebase/` (default on)
- `codegraph.explain.depth` — short / standard / deep

## Commands

- `Codegraph: Toggle Live Explain Mode` — continuous explain on/off
- `Codegraph: Explain Selection` — one-shot explain for the current cursor/selection
- `Codegraph: Enrich & Explain with Agent` — hand off grounded context to Cursor/Claude agent
- `Codegraph: Configure API Provider` — provider dropdown + API key + model presets + connection test
- `Codegraph: Test API Connection`
- `Codegraph: Repo Brief` — first-look map of the Python workspace
- `Codegraph: Set Explain Depth` — short / standard / deep
- `Codegraph: Rebuild Local Index` — incremental Python symbol/import index used by Agent tools

### Model access

Pick **one**:

- **Built-in Cursor/Claude agent** (default) — subscription model; no API key
- **API key provider** — run **Codegraph: Configure API Provider**
  - Dropdown: OpenRouter, OpenAI, Groq, Together, Fireworks, DeepSeek, Mistral, Google Gemini, or Custom
  - Base URL is set automatically (Custom asks for base URL)
  - You only enter **API key** + **model**

`autoEnrichOnExplain` (default **off**) only affects **manual** Explain Selection in agent mode. It never fires on Live Explain cursor moves.

## Pair with the Agent Skill

For agent workflows (Cursor Agent / Claude / Codex), also import the portable skill:

```bash
npm run package:skill
# or
skills/codegraph/scripts/install-skill.sh --target cursor
```

See `skills/codegraph/README.md`.
