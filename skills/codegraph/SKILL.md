---
name: codegraph
description: Explain and navigate Python code with source-grounded Codegraph tools. Use for live tutoring when ~/.cursor/codegraph/state.json or learn-codebase wake events appear, and when understanding unfamiliar repositories, finding definitions/usages, or grounding answers without API keys.
license: MIT
compatibility: Requires Node.js 20+ and a local Codegraph install (MCP preferred, CLI/HTTP fallback). Python-first; works best on .py codebases. No external model API key required when running inside Cursor Agent.
metadata:
  author: codegraph
  version: "0.1.6"
  homepage: https://github.com/sauravrana646/codegraph
---

# Codegraph

Use Codegraph to build **bounded, source-grounded** understanding of local code before answering or editing.

Prefer Codegraph over guessing from a few open files when the user asks what code does, where a symbol is defined/used, or how a section fits in the repo.

## Architecture (important)

Codegraph does **not** ship AST/LSP context packs on any path.

1. **Pointer** — Live Explain / Ask Agent send only `rootPath` / `filePath` / `line` / `symbol` (marker `codegraph-slim-v3`).
2. **Read source** — open the file around that line, or call `logical_section` / `explain_selection` for a bounded source window.
3. **Optional locations** — `find_definition` / `find_usages` return `file:line` only (no structure dumps).
4. **You write the answer** — Agent (subscription) or API key enrichment produces tutoring prose. Local heuristics are never the user-facing explanation.

### Paths

| Path | What is sent | Who explains |
| --- | --- | --- |
| Built-in Agent (default) | Slim pointer only | Cursor/Claude Agent after reading source |
| API key provider | Source window + file:line index over HTTP | Configured model |
| MCP / CLI tools | Bounded section / locations on demand | Caller (usually Agent) |

## Live tutoring (start / stop / cursor-move)

This matches the local **learn-codebase** interaction model: toggle once, then keep moving — Agent explains as you go.

### Start

1. User turns **Codegraph Live Explain** ON (status bar / toggle command).
2. User runs `skills/codegraph/scripts/watch-cursor.sh` (or their existing learn-codebase watcher).
3. User says: `Start Codegraph live tutoring` (or invokes `/codegraph`).
4. On each wake, read the slim pointer from `~/.cursor/codegraph/pending-prompt.md` / `state.json` (fallback `~/.cursor/learn-codebase/`).
5. **Read the source** — open `filePath` around `line`, or call `logical_section` / `explain_selection` for a bounded window. Use `find_definition` / `find_usages` only for `file:line` locations.
6. Explain in **learn-codebase tutoring style**:
   - Location + short code citation
   - Purpose (one paragraph)
   - Fields table (Field | Meaning)
   - Valid shapes / examples when useful
   - Docstring/validator notes
   - End with: Ask about that, or keep moving.
   - Cite real `file:line`
   - No UI chatter about toggles, modes, or enrichment status
   - Do **not** request AST/LSP context blobs

### Cursor-move flow

When woken because the cursor moved:

- Treat `state.json` / slim `pending-prompt.md` as the **target pointer** (not a code dump).
- Read the source (or a bounded tool window); then narrate.
- Keep answers short unless the symbol is complex or the user asks to go deeper.
- Do not ask for API keys.
- Do not ask for AST/LSP context.

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

1. Prefer **MCP tools** if `explain_selection`, `find_definition`, `find_usages`, `logical_section`, `get_symbol_context`, or `get_project_overview` are available.
2. Else use the CLI wrapper in [scripts/codegraph.sh](scripts/codegraph.sh) or the runtime CLI.
3. Else use the local HTTP API on `127.0.0.1` (default port `4311`).

If none are available, read [references/install.md](references/install.md) and tell the user how to install Codegraph + MCP. Still do **not** ask for model API keys.

## Core workflow

1. Identify `rootPath` (workspace root), `filePath` (workspace-relative), `line` (1-based), and optional `selectedText`.
2. Prefer reading the file around that line. Optionally call the smallest useful tool with `enrich` omitted/false:
   - unknown symbol / “what is this?” → `explain_selection` (bounded source window) or `logical_section`
   - neighborhood / callers / related files → `get_symbol_context`
   - “where defined?” → `find_definition` (`file:line` only)
   - “where used?” → `find_usages` (`file:line` only)
   - “who calls this?” → `trace_call_chain`
   - repo map → `get_project_overview`
   - name search → `search_codebase`
3. Do **not** request AST/LSP context packs.
4. Treat tool `data` as facts. Your prose is inference on top of those facts.
5. Cite concrete `file:line` sources. Do not invent sources.

## Tool quick reference

| Tool | Purpose | Key args |
| --- | --- | --- |
| `explain_selection` | Bounded source window for the target | `rootPath`, `filePath`, `line`, `selectedText?` |
| `find_definition` | Ranked definition `file:line` candidates (import-scoped) | same location args |
| `find_usages` | Ranked usage `file:line` candidates (import-scoped) | same location args |
| `logical_section` | Surrounding section excerpt | same + `depth?: statement\|function\|class\|auto` |
| `get_symbol_context` | Defs + usages + callers + related files | location args |
| `trace_call_chain` | One-hop call sites | location args |
| `get_project_overview` | Indexed packages / entrypoints / symbols | `rootPath` |
| `search_codebase` | Search indexed symbol names | `rootPath`, `query` |
| `ensure_index` | Build/refresh local index | `rootPath`, `force?` |

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
