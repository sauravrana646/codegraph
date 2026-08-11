# Codegraph Development Skill

Use this skill when working on the Codegraph repository.

## Project purpose

Codegraph is a Python-first codebase intelligence platform that helps AI and developers understand repositories through bounded local context, deterministic code intelligence, and secure model-assisted explanations.

## Current implementation status

The repository currently contains a usable local MVP:

- npm workspace monorepo
- VS Code/Cursor extension app in `apps/ide-vscode`
- local runtime CLI + JSON API in `apps/runtime`
- MCP stdio adapter in `apps/mcp`
- shared tool runners in `packages/agent-tools`
- shared protocol package in `packages/protocol`
- AST-backed Python language intelligence in `packages/language-intelligence`
- workspace path and identity helpers in `packages/workspace`
- security primitives for path/symlink checks and secret redaction in `packages/security`
- deterministic Python explanation assembly in `packages/core`
- deterministic helpers for definition lookup, usage lookup, and logical section extraction
- optional OpenAI-compatible enrichment in `packages/model-gateway`
- extension commands for Explain Selection, Find Definition, and Find Usages

## Architecture rules

1. Python is the primary MVP language.
2. Repository content is always untrusted.
3. Deterministic tools must not call an LLM.
4. Generative flows must consume bounded structured context only.
5. Facts must be separated from inference.
6. The runtime should remain IDE-independent.
7. Provider enrichment is opt-in and must preserve deterministic sources.

## Suggested next implementation order

1. Deepen Code Understanding Session UX in the extension
2. Expand provider adapters beyond OpenAI-compatible endpoints
3. Add evaluation harness coverage for reference ranking and section depth
4. Harden MCP session/follow-up tooling
5. Broaden beyond Python with explicit experimental language tiers

## Useful commands

Run from the repository root:

```bash
npm install
npm run build
npm run typecheck
```

Run the runtime prototype:

```bash
npm run build --workspace @codegraph/runtime
npm run start --workspace @codegraph/runtime -- explain /workspace examples/demo.py 10 create
```

Run the local runtime API:

```bash
npm run serve --workspace @codegraph/runtime -- 4311
curl http://127.0.0.1:4311/health
```

Run the MCP adapter:

```bash
npm run build --workspace @codegraph/mcp
node apps/mcp/dist/index.js
```

MCP tools:

- `explain_selection`
- `find_definition`
- `find_usages`
- `logical_section`

Available API endpoints:

- `POST /v1/tools/explain-selection`
- `POST /v1/tools/find-definition`
- `POST /v1/tools/find-usages`
- `POST /v1/tools/logical-section`
- `POST /v1/sessions/explain-selection`
- `POST /v1/sessions/followup`

All successful responses use `{ ok, tool, data, metadata?, enrichment?, session? }`.
Errors use `{ ok: false, error: { code, message } }`.

Optional enrichment:

```bash
export CODEGRAPH_API_KEY="..."
export CODEGRAPH_ENRICH=1
# or pass "enrich": true in the request body
```

Session follow-up actions:

- `explain-selection`
- `find-definition`
- `find-usages`
- `logical-section`

## Cursor IDE workflow

1. Open the repository in Cursor.
2. Run `npm install`.
3. Run `npm run build`.
4. Open `apps/ide-vscode` in Cursor when editing the extension.
5. Use the command palette and run `Codegraph: Explain Selection` once the extension is launched in an extension host.

## Guardrails

- Do not require a cloud backend for basic repository intelligence.
- Do not add arbitrary execution capabilities.
- Keep all file access workspace-bounded.
- Prefer building a thin vertical slice before broadening architecture.
- Keep enrichment optional and never let model output invent unsupported sources.
