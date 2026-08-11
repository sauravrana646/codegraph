# Codegraph Development Skill

Use this skill when working on the Codegraph repository.

## Project purpose

Codegraph is a Python-first codebase intelligence platform that helps AI and developers understand repositories through bounded local context, deterministic code intelligence, and secure model-assisted explanations.

## Current implementation status

The repository currently contains the first implementation scaffold:

- npm workspace monorepo
- VS Code/Cursor extension app in `apps/ide-vscode`
- local runtime CLI in `apps/runtime`
- shared protocol package in `packages/protocol`
- workspace path and identity helpers in `packages/workspace`
- security primitives for path/symlink checks and secret redaction in `packages/security`
- initial context assembly helper in `packages/core`

## Architecture rules

1. Python is the primary MVP language.
2. Repository content is always untrusted.
3. Deterministic tools must not call an LLM.
4. Generative flows must consume bounded structured context only.
5. Facts must be separated from inference.
6. The runtime should remain IDE-independent.

## Suggested next implementation order

1. Strengthen Python AST parsing and symbol extraction
2. Add logical section resolution
3. Build deterministic tools such as `find_definition`
4. Improve the runtime context bundle builder
5. Add provider abstraction and explanation normalization
6. Expand the VS Code/Cursor extension from output-channel prototype to panel-based UX

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
npm run start --workspace @codegraph/runtime -- /workspace README.md 1 codegraph
```

## Cursor IDE workflow

1. Open the repository in Cursor.
2. Run `npm install`.
3. Run `npm run build`.
4. Open `apps/ide-vscode` in Cursor when editing the extension.
5. Use the command palette and run `Codegraph: Explain Selection` once the extension is launched in an extension host.

## Guardrails

- Do not add cloud-only dependencies for MVP.
- Do not add arbitrary execution capabilities.
- Keep all file access workspace-bounded.
- Prefer building a thin vertical slice before broadening architecture.
