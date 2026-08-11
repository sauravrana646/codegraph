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
- opens a side panel with summary, sources, inferred claims, and caveats
- lets you click cited source locations in the panel to jump back into the editor
- keeps a raw JSON trace in the `Codegraph` output channel for debugging
- does not call an LLM yet

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
- workspace scanning is bounded
- dynamic/runtime-only references will be missed
- no model provider integration yet
- no follow-up conversation session UI yet

## Recommended next implementation steps

The best next engineering tasks are:

1. improve logical section detection and scope resolution
2. strengthen deterministic reference quality and ranking
3. add provider abstraction and structured model-backed explanation generation
4. add follow-up Code Understanding Sessions
5. expose the deterministic tools through a more formal runtime/tool API

For the full sequence, see:

- `docs/implementation-plan.md`
- `docs/implementation-backlog.md`
