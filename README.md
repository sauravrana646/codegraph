# codegraph

Codegraph is a Python-first codebase intelligence platform that helps developers and AI agents understand unfamiliar repositories by building bounded local context, tracing code relationships, and producing secure, source-grounded explanations.

## Current status

This repository now contains the first usable local MVP slice:

- `apps/ide-vscode` — a VS Code/Cursor extension with an `Explain Selection` command and side-panel explanation view
- `apps/runtime` — a local runtime CLI that builds bounded explanation context for a workspace/file/line
- `packages/protocol` — shared type contracts
- `packages/workspace` — workspace identity and safe path helpers
- `packages/security` — secret scanning/redaction and symlink containment checks
- `packages/language-intelligence` — AST-backed Python symbol parsing through a safe `python3` bridge with fallback behavior
- `packages/model-gateway` — optional OpenAI-compatible provider enrichment over deterministic context
- `packages/core` — deterministic Python-aware selection analysis, definition discovery, reference search, scope resolution, and explanation assembly
- `docs/` — PRD, TDD, implementation plan, and AI-ready backlog
- `examples/demo.py` — sample Python file for local smoke testing

This is not the full long-term product yet, but it is now usable as a local deterministic explainer for Python-oriented repository exploration.

## Requirements

- Node.js 20+
- npm 10+
- Cursor or VS Code for extension development

## Install

From the repository root:

```bash
npm install
```

## Build

Build all workspaces:

```bash
npm run build
```

Typecheck all workspaces:

```bash
npm run typecheck
```

## Run the runtime prototype

The runtime exposes a local CLI that:

- detects a target symbol from the selection or line
- uses AST-backed Python symbol parsing when `python3` is available
- scans bounded Python files in the workspace
- finds candidate definitions and references
- assembles structured explanation output
- reports capability/confidence metadata

Example:

```bash
npm run build --workspace @codegraph/runtime
npm run start --workspace @codegraph/runtime -- /workspace examples/demo.py 10 create
```

Expected behavior:

- prints a JSON payload with workspace metadata
- includes definitions, references, and related code excerpts
- includes a structured explanation block
- reports current capability metadata for the request

## Run the local JSON API

The runtime can also expose the deterministic Codegraph tools over local HTTP.

Start the server:

```bash
npm run serve --workspace @codegraph/runtime -- 4311
```

Health check:

```bash
curl http://127.0.0.1:4311/health
```

Available endpoints:

- `POST /v1/tools/explain-selection`
- `POST /v1/tools/find-definition`
- `POST /v1/tools/find-usages`
- `POST /v1/tools/logical-section`
- `POST /v1/sessions/explain-selection`
- `POST /v1/sessions/followup`

All tool endpoints accept:

```json
{
  "rootPath": "/workspace",
  "filePath": "examples/demo.py",
  "line": 10,
  "selectedText": "create",
  "depth": "auto",
  "enrich": false
}
```

### Response envelope

Every runtime API response uses a shared envelope:

```json
{
  "ok": true,
  "tool": "explain-selection",
  "data": {},
  "metadata": {
    "source": "ast",
    "capabilityTier": 2,
    "confidence": 0.82
  },
  "enrichment": {
    "used": false,
    "error": "Enrichment not requested..."
  }
}
```

Error responses use:

```json
{
  "ok": false,
  "tool": "find-definition",
  "error": {
    "code": "invalid_request",
    "message": "..."
  }
}
```

Session endpoints add a `session` object with `sessionId`, timestamps, and optional `action`.

### Optional model-backed enrichment

Deterministic retrieval is always the base path. Model enrichment is opt-in and only rewrites narrative explanation fields while preserving deterministic sources and inferred claims.

Enable enrichment with either:

- request body: `"enrich": true`
- environment: `CODEGRAPH_ENRICH=1`

Provider configuration:

```bash
export CODEGRAPH_API_KEY="..."
# optional:
export CODEGRAPH_BASE_URL="https://api.openai.com/v1"
export CODEGRAPH_MODEL="gpt-4o-mini"
```

`OPENAI_API_KEY` / `OPENAI_BASE_URL` are also accepted as aliases.

Example enriched explain request:

```bash
curl -X POST http://127.0.0.1:4311/v1/tools/explain-selection \
  -H "content-type: application/json" \
  -d '{"rootPath":"/workspace","filePath":"examples/demo.py","line":10,"selectedText":"create","enrich":true}'
```

Successful explain responses place narrative content under `data` and report enrichment at the top level of the envelope. If enrichment fails, deterministic `data` is still returned and the error is reported in `enrichment.error`.

Example:

```bash
curl -X POST http://127.0.0.1:4311/v1/tools/find-definition \
  -H "content-type: application/json" \
  -d '{"rootPath":"/workspace","filePath":"examples/demo.py","line":10,"selectedText":"create"}'
```

Find-definition / find-usages return `{ "ok": true, "tool": "...", "data": { "items": [...] } }`.
Logical-section returns `{ "ok": true, "tool": "logical-section", "data": { "section": {...} }, "metadata": {...} }`.

### Session-based follow-up API

Create a short-lived session:

```bash
curl -X POST http://127.0.0.1:4311/v1/sessions/explain-selection \
  -H "content-type: application/json" \
  -d '{"rootPath":"/workspace","filePath":"examples/demo.py","line":10,"selectedText":"create"}'
```

Then reuse the returned `sessionId` for follow-up operations:

```bash
curl -X POST http://127.0.0.1:4311/v1/sessions/followup \
  -H "content-type: application/json" \
  -d '{"sessionId":"<session-id>","action":"find-usages"}'
```

Supported follow-up actions:

- `explain-selection`
- `find-definition`
- `find-usages`
- `logical-section`

Sessions are in-memory and short-lived. They are intended for local agent or tool workflows, not durable storage.

## Run in Cursor IDE

Cursor can run the VS Code-compatible extension in `apps/ide-vscode`.

### Option 1: open the repo and work on the code

1. Open this repository in Cursor.
2. Run:

   ```bash
   npm install
   npm run build
   ```

3. Edit the extension code under `apps/ide-vscode/src/extension.ts`.
4. Edit runtime and shared packages under `apps/runtime` and `packages/*`.

### Option 2: launch the extension in an Extension Development Host

Because Cursor is VS Code-compatible, the extension can be developed with the normal VS Code extension workflow.

1. Open the repository in Cursor.
2. Build the workspace:

   ```bash
   npm run build
   ```

3. Open the `apps/ide-vscode` folder or keep the full repo open.
4. Start an Extension Development Host using the standard VS Code/Cursor extension-debug workflow.
5. In the new host window, open a workspace with a Python file.
6. Select text or place the cursor on a line.
7. Run the command palette action:

   ```text
   Codegraph: Explain Selection
   ```

Current behavior:

- gathers local selection context
- performs deterministic Python-aware symbol discovery and bounded reference search
- opens a side panel with summary, sources, inferred claims, caveats, and enrichment status
- lets you click cited source locations in the panel to jump back into the editor
- adds command palette actions for `Codegraph: Find Definition` and `Codegraph: Find Usages`
- keeps a lightweight in-memory session for the current explanation target so related commands can reuse it
- keeps a raw JSON trace in the `Codegraph` output channel for debugging
- optionally enriches narrative fields when `codegraph.enrichment.enabled` is on and an API key is configured

Useful settings:

```text
codegraph.enrichment.enabled
codegraph.enrichment.apiKey
codegraph.enrichment.baseUrl
codegraph.enrichment.model
```

Useful commands in Cursor/VS Code:

```text
Codegraph: Explain Selection
Codegraph: Find Definition
Codegraph: Find Usages
```

## Use this project as a Cursor skill

A repository-local skill is included at:

```text
.cursor/skills/codegraph/SKILL.md
```

This gives Cursor agents project-specific guidance about:

- current architecture
- implementation guardrails
- useful commands
- recommended next steps

If you want Cursor agents to use it while working in this repo:

1. Open the repository in Cursor.
2. Keep the `.cursor/skills/codegraph/SKILL.md` file committed in the repo.
3. Ask the agent to work on Codegraph implementation tasks; the agent can read the local skill and follow the repo-specific instructions.

## Current MVP limitations

This first usable version is intentionally narrow:

- Python understanding is AST-backed for symbol discovery, but still uses bounded deterministic heuristics for reference search and explanation assembly
- optional provider enrichment is opt-in and OpenAI-compatible only for now
- workspace scanning is bounded
- dynamic/runtime-only references will be missed
- no mandatory cloud backend
- no durable multi-user sessions yet

## Recommended next implementation steps

The best next engineering tasks are:

1. improve logical section detection and scope resolution
2. strengthen deterministic reference quality and ranking
3. expand provider adapters beyond OpenAI-compatible endpoints
4. deepen follow-up Code Understanding Sessions in the extension UI
5. expose richer tool schemas for MCP wrapping

For the full sequence, see:

- `docs/implementation-plan.md`
- `docs/implementation-backlog.md`
