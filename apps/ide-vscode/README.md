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

## Commands

- `Codegraph: Explain Selection`
- `Codegraph: Ask Cursor/Claude Agent`
- `Codegraph: Find Definition`
- `Codegraph: Find Usages`

### Model access checkboxes

In the explanation panel (and in Settings → Codegraph):

- **Use built-in Cursor/Claude agent** (default on) — no API key; hand off grounded context to Cursor/Claude agent
- **Use API key provider** (default off) — OpenAI-compatible enrichment using `codegraph.enrichment.apiKey`

For Cursor plans: keep agent on, API key off.

Optional settings under **Codegraph › Enrichment** for API key mode only.

## Pair with the Agent Skill

For agent workflows (Cursor Agent / Claude / Codex), also import the portable skill:

```bash
npm run package:skill
# or
skills/codegraph/scripts/install-skill.sh --target cursor
```

See `skills/codegraph/README.md`.
