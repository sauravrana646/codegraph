# codegraph

Codegraph is a Python-first codebase intelligence platform that helps developers and AI agents understand unfamiliar repositories by building bounded local context, tracing code relationships, and producing secure, source-grounded explanations.

## Current status

This repository now contains the first implementation scaffold for the MVP:

- `apps/ide-vscode` — a VS Code/Cursor extension entry point with an `Explain Selection` command
- `apps/runtime` — a local runtime CLI prototype
- `packages/protocol` — shared type contracts
- `packages/workspace` — workspace identity and safe path helpers
- `packages/security` — secret scanning/redaction and symlink containment checks
- `packages/core` — initial selection-context assembly logic
- `docs/` — PRD, TDD, implementation plan, and AI-ready backlog

This is not the full product yet. It is the first buildable slice that establishes the architecture and local development workflow.

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

The runtime currently exposes a simple CLI that builds bounded local context for a file and line.

Example:

```bash
npm run build --workspace @codegraph/runtime
npm run start --workspace @codegraph/runtime -- /workspace README.md 1 codegraph
```

Expected behavior:

- prints a JSON payload with workspace metadata
- includes a small redacted excerpt around the selected line
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
- computes a bounded result without calling an LLM
- writes the result to the `Codegraph` output channel
- shows a small info notification with the current capability tier

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

## Recommended next implementation steps

The best next engineering tasks are:

1. implement Python AST parsing
2. add symbol extraction
3. add logical section resolution
4. build deterministic tools such as `find_definition`
5. add provider abstraction and structured explanation normalization
6. evolve the extension from an output channel prototype to a panel-based UX

For the full sequence, see:

- `docs/implementation-plan.md`
- `docs/implementation-backlog.md`
