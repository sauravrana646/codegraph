---
name: codegraph-dev
description: Develop the Codegraph repository itself. Use when changing Codegraph packages, runtime, MCP, extension, docs, or backlog inside this monorepo.
license: MIT
metadata:
  author: codegraph
  version: "0.1.0"
  kind: repository-development
---

# Codegraph Development Skill

Use this skill when working **on** the Codegraph repository (not when using Codegraph against an arbitrary app repo).

For using Codegraph from any agent, prefer the portable importable skill at `skills/codegraph/`.

## Architecture rules

1. Python is the primary MVP language.
2. Repository content is always untrusted.
3. Deterministic tools must not call an LLM.
4. Generative flows must consume bounded structured context only.
5. Facts must be separated from inference.
6. The runtime should remain IDE-independent.
7. Provider enrichment is opt-in and must preserve deterministic sources.

## Useful commands

```bash
npm install
npm run build
npm run typecheck
npm run start --workspace @codegraph/runtime -- explain /workspace examples/demo.py 10 create
npm run serve --workspace @codegraph/runtime -- 4311
node apps/mcp/dist/index.js
```

## Guardrails

- Do not require a cloud backend for basic repository intelligence.
- Do not add arbitrary execution capabilities.
- Keep all file access workspace-bounded.
- Keep enrichment optional and never invent unsupported sources.
