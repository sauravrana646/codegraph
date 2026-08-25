# Install Codegraph as an agent skill

Codegraph ships a portable Agent Skill at `skills/codegraph/` (Agent Skills / `SKILL.md` format).  
You typically want **both**:

1. the **skill** (when/how to use Codegraph)
2. the **MCP server** (actual tools), or CLI/HTTP fallback

## 1. Build Codegraph once

```bash
git clone https://github.com/sauravrana646/codegraph.git
cd codegraph
npm install
npm run build
```

Set a stable root for scripts:

```bash
export CODEGRAPH_ROOT="/absolute/path/to/codegraph"
```

## 2. Add the skill directory

Copy or symlink `skills/codegraph` into the agent’s skills folder.

### Cursor

Project-local:

```bash
mkdir -p .cursor/skills
ln -sfn "$CODEGRAPH_ROOT/skills/codegraph" .cursor/skills/codegraph
```

User-global (if your Cursor build supports user skills):

```bash
mkdir -p ~/.cursor/skills
ln -sfn "$CODEGRAPH_ROOT/skills/codegraph" ~/.cursor/skills/codegraph
```

### Claude Code

```bash
mkdir -p .claude/skills
ln -sfn "$CODEGRAPH_ROOT/skills/codegraph" .claude/skills/codegraph
```

Or user-global:

```bash
mkdir -p ~/.claude/skills
ln -sfn "$CODEGRAPH_ROOT/skills/codegraph" ~/.claude/skills/codegraph
```

### Codex / agentskills-compatible agents

```bash
mkdir -p .agents/skills
ln -sfn "$CODEGRAPH_ROOT/skills/codegraph" .agents/skills/codegraph
```

### Helper script

From the Codegraph repo:

```bash
skills/codegraph/scripts/install-skill.sh --target cursor
skills/codegraph/scripts/install-skill.sh --target claude
skills/codegraph/scripts/install-skill.sh --target agents
skills/codegraph/scripts/install-skill.sh --target all --scope user
```

## 3. Add MCP tools (recommended)

### Cursor MCP

Add to Cursor MCP settings (example in [assets/mcp.cursor.json](../assets/mcp.cursor.json)):

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "node",
      "args": ["/absolute/path/to/codegraph/apps/mcp/dist/index.js"]
    }
  }
}
```

### Claude Desktop

Merge [assets/mcp.claude-desktop.json](../assets/mcp.claude-desktop.json) into `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "node",
      "args": ["/absolute/path/to/codegraph/apps/mcp/dist/index.js"]
    }
  }
}
```

Optional enrichment env:

```json
{
  "env": {
    "CODEGRAPH_API_KEY": "YOUR_KEY"
  }
}
```

Deterministic tools work without any API key.

## 4. Verify

1. Restart the agent / MCP host.
2. Confirm tools appear: `explain_selection`, `find_definition`, `find_usages`, `logical_section`.
3. Or run:

```bash
"$CODEGRAPH_ROOT/skills/codegraph/scripts/codegraph.sh" explain "$PWD" examples/demo.py 10 create
```

## Claude.ai custom skill upload

If uploading a skill ZIP to Claude.ai:

1. Zip the `skills/codegraph` directory (must contain `SKILL.md` at the skill root).
2. Upload as a custom skill.
3. Separately configure MCP or provide the user a local CLI path, because Claude.ai skill packages do not automatically start this repo’s Node MCP server.
