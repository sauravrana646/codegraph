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
- `Codegraph: Find Definition`
- `Codegraph: Find Usages`

Optional settings under **Codegraph › Enrichment**.

## Pair with the Agent Skill

For agent workflows (Cursor Agent / Claude / Codex), also import the portable skill:

```bash
npm run package:skill
# or
skills/codegraph/scripts/install-skill.sh --target cursor
```

See `skills/codegraph/README.md`.
