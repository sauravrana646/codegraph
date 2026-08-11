# Codebase Intelligence Agent — MVP Implementation Plan

## Executive summary

Build a secure, local-first codebase intelligence system that helps AI explain code in repository context. The MVP is **Python-first**, with a VS Code-compatible IDE adapter, a local runtime, deterministic repository intelligence, and optional LLM-backed explanations.

The implementation should prove one core claim:

> Code explanations become materially better when the system understands the repository structure, symbol relationships, and local code context instead of sending a raw snippet to a model.

## Locked architectural decisions

- Gold-standard V1 language: **Python**
- Early TypeScript/JavaScript support: optional and lower-tier until quality reaches parity
- IDE strategy: VS Code-compatible first
- Indexing: local-first, asynchronous, incremental, derived state
- Intelligence strategy: capability tiers with explicit fallback
- Tooling split: deterministic tools vs generative tools
- Follow-ups: short-lived **Code Understanding Sessions**
- Security principle: repository content is always untrusted
- Explanation principle: separate **facts** from **inference**
- Model policy: provider-agnostic, bounded context only

## Product layers

1. **IDE Adapter**
   - Captures selection, cursor, file, workspace, and user actions
   - Renders side panel and source navigation
2. **Local Runtime**
   - Owns indexing, retrieval, security, orchestration, sessions, and tool execution
3. **Model Gateway**
   - Sends only bounded, redacted context to the configured provider

## Capability tiers

The runtime must not assume uniform language intelligence. Every operation should report both source and confidence.

### Tier 0 — Text

Available everywhere:

- file contents
- line/range context
- search/regex
- repository structure

### Tier 1 — AST

Can determine:

- functions
- classes
- blocks
- imports
- variables
- logical sections

### Tier 2 — Symbol intelligence

Can determine:

- definitions
- references
- scope
- imports/exports where language semantics allow

### Tier 3 — LSP intelligence

Can provide:

- go to definition
- find references
- type information
- hover
- document symbols
- workspace symbols

### Tier 4 — Deep relationship intelligence

Runtime-owned analysis:

- call graph
- dependency graph
- test relationships
- configuration relationships
- cross-module relationships

### Fallback model

```text
LSP available?
    ├── yes -> use LSP-backed resolution
    └── no
         ├── AST available -> use AST/symbol intelligence
         └── text/index fallback
```

Example output metadata:

```json
{
  "resolution": "symbol",
  "confidence": 0.94,
  "source": "lsp",
  "capabilityTier": 3
}
```

## Thin vertical slice first

Before broad platform work, build a narrow proof:

```text
VS Code
  -> select Python symbol
  -> resolve symbol
  -> find definition
  -> collect containing function/block
  -> build small bounded context
  -> call one model
  -> render structured explanation
```

### Slice scope

Include:

- Python only
- VS Code-compatible adapter
- one provider path to start
- explain selection
- source citations
- explicit context preview

Exclude:

- vector DB
- enterprise features
- cloud backend
- broad multi-language parity
- deep graph completeness

## Work phases

## Phase 0 — Foundation

Deliver:

- monorepo/package boundaries
- capability-tier definitions
- deterministic/generative tool contract
- explanation schema
- security model
- session model
- privacy UX contract
- evaluation plan

Exit criteria:

- clear separation between adapter/runtime/gateway
- all tools classified by capability and trust model
- repository content explicitly treated as untrusted data

## Phase 1 — IDE Adapter

Build:

- selection and cursor capture
- active file and workspace detection
- side-panel entry point
- source navigation
- request debouncing and cancellation

Rules:

- no model invocation on every cursor move by default
- explicit Explain action is MVP default

## Phase 2 — Workspace discovery and local index

Build:

- workspace-bounded file walker
- ignore handling
- binary/size filtering
- local metadata index
- file hashing
- asynchronous indexing pipeline

The index is derived state from workspace files and Git state.

## Phase 3 — Python language intelligence

Build Python-first:

- AST parsing
- symbol extraction
- logical section resolution
- definition/reference resolution
- confidence reporting

Use hybrid providers:

- IDE-backed LSP when available and fresh
- standalone language provider when needed
- AST/text fallback otherwise

## Phase 4 — Context engine

Build:

- target context construction
- relationship ranking
- bounded retrieval budgets
- citation packaging
- fact vs inference separation

Context must be assembled from deterministic evidence before any model call.

## Phase 5 — Deterministic tools

Implement non-LLM tools first:

- `find_definition`
- `find_usages`
- `search_codebase`
- `get_symbol_context`
- `get_project_overview`
- `get_logical_section`
- `trace_call_chain`

These return structured facts only.

## Phase 6 — Generative explanation tools

Implement:

- `explain_selection`
- `explain_code_section`
- `answer_followup`

These must consume structured context bundles, not unrestricted workspace scans.

## Phase 7 — Sessions and follow-ups

Implement short-lived **Code Understanding Sessions** containing:

- workspace
- file
- target
- previous context bundle
- previous explanation
- relevant symbols
- bounded conversation history

Sessions expire after inactivity; the repository index persists.

## Phase 8 — Security and privacy UX

Build:

- prompt-injection-safe prompt boundaries
- secret scanning/redaction
- path validation
- symlink protections
- provider visibility
- context preview UI
- inclusion/exclusion reasoning

The user should be able to see what is being sent and why.

## Phase 9 — Evaluation harness

Create:

```text
evaluation/
├── fixtures/
│   └── python/
├── cases/
├── expected/
├── runners/
└── reports/
```

Measure:

- symbol resolution correctness
- logical section correctness
- retrieval relevance
- explanation grounding
- source attribution
- secret leakage prevention
- prompt injection resistance

## Index lifecycle rules

The runtime must explicitly handle:

- file change
- file delete
- file rename
- branch switch
- stale LSP results
- parser/index version changes
- index corruption

### Branch switch

```text
HEAD changed
  -> invalidate affected records
  -> re-index changed files
  -> reconcile symbols/references
```

### File rename

Use Git rename information when available; otherwise treat as delete + add and reconcile stale records safely.

### Stale LSP

Validate LSP results against current file hash/version before accepting them.

### Corruption

Detect, quarantine, and rebuild automatically. The developer should not have to delete cache files manually.

## Definition of done for MVP

The MVP is complete when a user can:

1. Open a Python repository in a VS Code-compatible IDE
2. Have the repository indexed locally without running repository code
3. Select a Python symbol
4. Request an explanation
5. Receive a structured explanation with citations
6. Distinguish facts from inference
7. View what context will be sent to the model
8. Follow source links back to the IDE
9. Ask a follow-up question within the same Code Understanding Session
10. Disable external model use and remain functional in deterministic/local modes
