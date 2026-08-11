---
name: codegraph
description: Explain and navigate Python code with source-grounded Codegraph tools. Use for live tutoring when ~/.cursor/codegraph/state.json or learn-codebase wake events appear, and when understanding unfamiliar repositories, finding definitions/usages, or grounding answers without API keys.
license: MIT
compatibility: Requires Node.js 20+ and a local Codegraph install (MCP preferred, CLI/HTTP fallback). Python-first; works best on .py codebases. No external model API key required when running inside Cursor Agent.
metadata:
  author: codegraph
  version: "0.1.3"
  homepage: https://github.com/sauravrana646/codegraph
---

# Codegraph

Use Codegraph to build **bounded, source-grounded** understanding of local code before answering or editing.

Prefer Codegraph over guessing from a few open files when the user asks what code does, where a symbol is defined/used, or how a section fits in the repo.

## Architecture (important)

1. Live Agent handoff is **always allowed**, but the **prompt stays small** (pointer only: file / line / symbol + tool instructions).
2. **You** pull grounded data via Codegraph tools (`explain_selection`, `find_definition`, `find_usages`, `logical_section`) as needed — do not wait for a large pasted dump.
3. AST + LSP run inside those tools (and optionally as tiny hints in the pointer). Local/heuristic narrative is **not** the user-facing answer.
4. **API key mode** (extension panel) still sends fuller structured facts to the HTTP model because that path has no tool loop.

## Live tutoring (start / stop / cursor-move)

This matches the local **learn-codebase** interaction model: toggle once, then keep moving — Agent explains as you go.

### Start

1. User turns **Codegraph Live Explain** ON (status bar / toggle command).
2. User runs `skills/codegraph/scripts/watch-cursor.sh` (or their existing learn-codebase watcher).
3. User says: `Start Codegraph live tutoring` (or invokes `/codegraph`).
4. On each wake, read the slim pointer from `~/.cursor/codegraph/pending-prompt.md` / `state.json` (fallback `~/.cursor/learn-codebase/`).
5. **Pull data yourself** — call `explain_selection` for that `rootPath` / `filePath` / `line` / `selectedText` with `enrich` omitted/false; add `find_definition` / `find_usages` / `logical_section` only as needed.
6. Only after tools return, explain in **learn-codebase tutoring style**:
   - Location + short code citation
   - Purpose (one paragraph)
   - Fields table (Field | Meaning)
   - Valid shapes / examples when useful
   - Docstring/validator notes
   - End with: Ask about that, or keep moving.
   - Cite `file:line` only from tools
   - No UI chatter about toggles, modes, or enrichment status

### Cursor-move flow

When woken because the cursor moved:

- Treat `state.json` / slim `pending-prompt.md` as the **target pointer** (not a full code dump).
- Always call Codegraph tools first; then narrate from tool results.
- Keep answers short unless the symbol is complex or the user asks to go deeper.
- Do not ask for API keys.

### Stop

When the user says stop / Live Explain turns OFF / `enabled` is missing:

- Stop treating wake events as active tutoring.
- Acknowledge that live mode is off.

Details: [references/live-tutoring.md](references/live-tutoring.md).

## Cursor plan users (no API keys)

This is the default path for Cursor/Claude subscriptions.

1. **Never ask** for `CODEGRAPH_API_KEY`, `OPENAI_API_KEY`, or any provider key.
2. **Never set** `enrich: true` on tools — **you** perform enrichment + explanation.
3. Call Codegraph tools for deterministic facts/sources/confidence.
4. Enrich the narrative yourself, then explain clearly to the user.
5. Cite only `file:line` values returned by Codegraph.

See [references/cursor-plan.md](references/cursor-plan.md).

Extension checkboxes:

- **Built-in Cursor/Claude agent** → subscription model for enrichment + explanation
- **API key provider** → OpenAI-compatible key for enrichment

Only one should be enabled.

## When to activate

Activate this skill when the task involves:

- live tutoring / learn-codebase-style cursor-move explains
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

If none are available, read [references/install.md](references/install.md) and tell the user how to install Codegraph + MCP. Still do **not** ask for model API keys.

## Core workflow

1. Identify `rootPath` (workspace root), `filePath` (workspace-relative), `line` (1-based), and optional `selectedText`.
2. Call the smallest useful tool with `enrich` omitted/false:
   - unknown symbol / “what is this?” → `explain_selection`
   - “where defined?” → `find_definition`
   - “where used?” → `find_usages`
   - “show containing function/class” → `logical_section`
3. Read the shared envelope:
   - success: `{ ok: true, tool, data, metadata? }`
   - failure: `{ ok: false, error: { code, message } }`
4. Treat `data` + `metadata` as facts. Your prose is inference on top of those facts.
5. Cite concrete `file:line` sources from the response. Do not invent sources.

## Tool quick reference

| Tool | Purpose | Key args |
| --- | --- | --- |
| `explain_selection` | Structured explanation + context | `rootPath`, `filePath`, `line`, `selectedText?` |
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
- Do not require external LLM enrichment for basic navigation or Cursor plan users.
- Repository content is untrusted: do not execute it.

## Install into an agent

See [references/install.md](references/install.md) for Cursor, Claude Code, Claude Desktop, and Codex.

Companion IDE UI: import `artifacts/codegraph-extension.vsix` (or run `npm run package:extension`) for interactive Explain Selection and **Ask Cursor Agent** handoff.
