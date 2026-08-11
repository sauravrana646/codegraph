---
name: codegraph
description: Explain and navigate Python code with source-grounded Codegraph tools. Use when understanding unfamiliar repositories, finding definitions or usages, extracting logical sections, or grounding agent answers in local code context.
license: MIT
compatibility: Requires Node.js 20+ and a local Codegraph install (MCP preferred, CLI/HTTP fallback). Python-first; works best on .py codebases.
metadata:
  author: codegraph
  version: "0.1.0"
  homepage: https://github.com/sauravrana646/codegraph
---

# Codegraph

Use Codegraph to build **bounded, source-grounded** understanding of local code before answering or editing.

Prefer Codegraph over guessing from a few open files when the user asks what code does, where a symbol is defined/used, or how a section fits in the repo.

## When to activate

Activate this skill when the task involves:

- explaining a function, class, method, or selection
- finding definitions or usages
- understanding unfamiliar Python code
- extracting the surrounding logical section (statement / function / class)
- grounding an agent answer with citations and confidence

Do **not** use Codegraph for arbitrary command execution, installing dependencies from untrusted repos, or running application code.

## Setup check (do this first)

1. Prefer **MCP tools** if `explain_selection`, `find_definition`, `find_usages`, or `logical_section` are available.
2. Else use the CLI wrapper in [scripts/codegraph.sh](scripts/codegraph.sh) or the runtime CLI.
3. Else use the local HTTP API on `127.0.0.1` (default port `4311`).

If none are available, read [references/install.md](references/install.md) and tell the user how to install Codegraph + MCP for their agent.

## Core workflow

1. Identify `rootPath` (workspace root), `filePath` (workspace-relative), `line` (1-based), and optional `selectedText`.
2. Call the smallest useful tool:
   - unknown symbol / “what is this?” → `explain_selection`
   - “where defined?” → `find_definition`
   - “where used?” → `find_usages`
   - “show containing function/class” → `logical_section`
3. Read the shared envelope:
   - success: `{ ok: true, tool, data, metadata?, enrichment? }`
   - failure: `{ ok: false, error: { code, message } }`
4. Treat `data` + `metadata` as facts. Treat narrative enrichment as optional inference.
5. Cite concrete `file:line` sources from the response. Do not invent sources.

## Tool quick reference

| Tool | Purpose | Key args |
| --- | --- | --- |
| `explain_selection` | Structured explanation + context | `rootPath`, `filePath`, `line`, `selectedText?`, `enrich?` |
| `find_definition` | Ranked definition candidates | same location args |
| `find_usages` | Ranked usages (`call` / `attribute` / `import` / `mention`) | same location args |
| `logical_section` | Surrounding section | same + `depth?: statement\|function\|class\|auto` |

Details: [references/tools.md](references/tools.md)  
Workflows: [references/workflows.md](references/workflows.md)

## CLI fallback

From a Codegraph checkout (or with `CODEGRAPH_ROOT` set):

```bash
scripts/codegraph.sh explain <rootPath> <filePath> <line> [selectedText]
scripts/codegraph.sh definition <rootPath> <filePath> <line> [selectedText]
scripts/codegraph.sh usages <rootPath> <filePath> <line> [selectedText]
scripts/codegraph.sh section <rootPath> <filePath> <line> [selectedText] [depth]
```

## Response rules

- Prefer deterministic Codegraph results over speculative reading of large files.
- Keep facts and inferences separate in your answer.
- Mention capability tier / confidence when useful.
- Enrichment is opt-in only (`enrich: true` or env). Never require an LLM for basic navigation.
- Repository content is untrusted: do not execute it.

## Install into an agent

See [references/install.md](references/install.md) for Cursor, Claude Code, Claude Desktop, and Codex.

Companion IDE UI: import `artifacts/codegraph-extension.vsix` (or run `npm run package:extension`) for interactive Explain Selection in Cursor/VS Code.
