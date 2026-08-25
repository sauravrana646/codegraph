# Codegraph Agent Skill

Portable Agent Skills package (`SKILL.md` format) for Cursor, Claude Code, Claude Desktop (skill upload), Codex, and other compatible agents.

## Import options

### A. Symlink / copy into an agent skills folder

```bash
export CODEGRAPH_ROOT=/absolute/path/to/codegraph
"$CODEGRAPH_ROOT/skills/codegraph/scripts/install-skill.sh" --target cursor
"$CODEGRAPH_ROOT/skills/codegraph/scripts/install-skill.sh" --target claude
"$CODEGRAPH_ROOT/skills/codegraph/scripts/install-skill.sh" --target all --scope user
```

### B. Import a ZIP

```bash
"$CODEGRAPH_ROOT/skills/codegraph/scripts/package-skill.sh"
# -> artifacts/codegraph-skill.zip
```

Unzip into `.cursor/skills/`, `.claude/skills/`, or upload where your agent supports custom skills.

### C. Also enable MCP tools (recommended)

Build once:

```bash
cd "$CODEGRAPH_ROOT"
npm install && npm run build
```

Then merge `assets/mcp.cursor.json` or `assets/mcp.claude-desktop.json` into your MCP config (replace `REPLACE_WITH_CODEGRAPH_ROOT`).

Without MCP, agents can still follow this skill and call `scripts/codegraph.sh`.

## Live tutoring (learn-codebase compatible)

Codegraph Live Explain writes the same kind of bridge files your local learn-codebase skill uses:

```text
~/.cursor/codegraph/{enabled,state.json,wake.log,pending-prompt.md}
# mirrored to ~/.cursor/learn-codebase/ by default
```

1. Install the VSIX + this skill.
2. Run `scripts/watch-cursor.sh` in a terminal.
3. Toggle **Codegraph Live Explain** ON.
4. Tell Agent: `Start Codegraph live tutoring`.
5. Move the cursor — panel updates immediately; watcher wakes Agent.

See [references/live-tutoring.md](references/live-tutoring.md).
