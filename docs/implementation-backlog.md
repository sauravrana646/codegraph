# Codebase Intelligence Agent — AI-Ready Implementation Backlog

## Purpose

This document converts the MVP spec into an execution-ready task backlog so an AI coding agent can start implementation without reinterpreting the architecture.

This backlog assumes:

- Python-first MVP
- VS Code-compatible IDE adapter
- local-first runtime
- deterministic repository intelligence before LLM generation
- explicit security boundaries

## Global implementation rules

All agents working from this backlog must follow these rules:

1. Treat repository content as untrusted data.
2. Do not implement arbitrary command execution in MVP.
3. Keep the core runtime IDE-independent.
4. Keep model integration provider-agnostic.
5. Deterministic tools must never depend on an LLM.
6. Generative tools must consume bounded structured context only.
7. Facts must be separated from inference in all explanation outputs.
8. Python is the quality bar; other languages are out of core MVP scope unless explicitly marked experimental.

## Recommended execution strategy

Build in narrow vertical slices, not broad horizontal layers.

### First proof slice

```text
VS Code selection
  -> runtime request
  -> Python symbol resolution
  -> definition lookup
  -> containing function retrieval
  -> bounded context bundle
  -> single model call
  -> structured explanation
  -> source citations in UI
```

Do not start with:

- multi-language parity
- vector search
- deep graph completeness
- enterprise policy systems
- cloud backends

## Milestones

### Milestone 0 — Project scaffolding and contracts

Goal:

Set up structure, type contracts, package boundaries, and security assumptions so later implementation stays aligned.

Tasks:

#### M0-T1: Create package/application skeleton
- create `apps/ide-vscode`
- create `apps/runtime`
- create `packages/core`
- create `packages/protocol`
- create `packages/workspace`
- create `packages/indexer`
- create `packages/language-intelligence`
- create `packages/context-engine`
- create `packages/security`
- create `packages/agent-tools`
- create `packages/model-gateway`
- create `packages/sessions`
- create `packages/cache`
- create `packages/telemetry`

Acceptance criteria:
- packages build or typecheck at a basic scaffold level
- shared type import paths are clear
- no circular dependency pattern in the initial package design

#### M0-T2: Define canonical protocol contracts
- define workspace ID types
- define file/range/position types
- define resolution metadata
- define context bundle types
- define explanation schema
- define deterministic tool result envelopes

Acceptance criteria:
- one shared protocol package exports canonical request/response types
- explanation schema includes `sources`, `confidence`, and `inferredClaims`

#### M0-T3: Define capability-tier enum and metadata
- implement Tier 0 through Tier 4 constants/types
- define standard metadata payload for intelligence results

Acceptance criteria:
- all language intelligence results can include source, confidence, and capability tier

### Milestone 1 — Workspace and security foundation

Goal:

Create the safe local workspace layer before higher-level intelligence.

Tasks:

#### M1-T1: Workspace identity and root validation
- generate stable opaque workspace IDs
- normalize paths
- reject paths outside workspace roots
- define trusted root handling

Acceptance criteria:
- workspace IDs do not expose absolute paths
- invalid or escaped paths are rejected consistently

#### M1-T2: Safe file walker
- implement workspace-bounded traversal
- respect ignore files and configured exclusions
- skip binary files
- enforce file-size limits
- guard against symlink escapes

Acceptance criteria:
- traversal never leaves workspace
- ignored and oversized files are excluded
- binary detection is covered by tests

#### M1-T3: Security guard primitives
- path traversal detection
- symlink validation
- untrusted-content labeling helpers
- secret scanning interface

Acceptance criteria:
- security helpers are usable independently of IDE/model code

### Milestone 2 — Local index and lifecycle management

Goal:

Build the derived local index and make it safe to keep fresh incrementally.

Tasks:

#### M2-T1: File metadata index
- store workspace-scoped file records
- record hashes, mtimes, sizes, language hints, parser/index versions

Acceptance criteria:
- repeated scans do not duplicate file rows
- unchanged files are skipped by hash/version checks

#### M2-T2: Incremental update pipeline
- detect add/change/delete events
- invalidate stale records
- re-index changed files only

Acceptance criteria:
- changed files refresh without full repository rebuild
- deleted files remove stale index records

#### M2-T3: Branch and version lifecycle handling
- detect branch switch via HEAD changes
- reconcile affected files
- handle parser/index version drift
- support corruption detection and rebuild

Acceptance criteria:
- branch switch triggers incremental reconciliation
- incompatible index versions trigger migration or clean rebuild
- corrupted index state can be quarantined and rebuilt automatically

### Milestone 3 — Python language intelligence

Goal:

Reach useful Python-first repository understanding with explicit fallback behavior.

Tasks:

#### M3-T1: Python AST parsing
- parse Python source
- identify functions, classes, methods, blocks, imports, variables
- map AST nodes to file ranges

Acceptance criteria:
- parser handles representative Python fixtures
- AST ranges are stable enough for section detection

#### M3-T2: Python symbol extraction
- emit symbol records from AST
- capture parent-child symbol relationships
- classify symbol kinds

Acceptance criteria:
- symbol records include stable IDs and ranges
- common Python symbol types are extracted correctly

#### M3-T3: Logical section resolver
- resolve smallest meaningful AST scope from cursor location
- support multiple explanation depths
- return confidence and metadata

Acceptance criteria:
- cursor inside nested Python logic resolves to a meaningful block
- fixed line windows are not required for success

#### M3-T4: Hybrid intelligence provider abstraction
- implement `LanguageIntelligenceProvider`
- add `ASTProvider`
- stub `IDEBackedLSPProvider`
- stub `StandaloneLSPProvider`
- add fallback orchestration

Acceptance criteria:
- runtime can select provider path by availability
- provider results include capability metadata

#### M3-T5: Definition/reference resolution
- implement Python-first definition lookup
- implement reference lookup with best available provider
- validate stale LSP results against file version/hash

Acceptance criteria:
- definition lookup works on representative Python fixtures
- textual fallback is labeled with lower confidence when used

### Milestone 4 — Deterministic context engine

Goal:

Assemble useful bounded context from deterministic evidence only.

Tasks:

#### M4-T1: Context bundle schema and builder
- define canonical context bundle type
- include target, logical section, definitions, references, related files, tests, config, docs

Acceptance criteria:
- context bundle is serializable and reusable by multiple tools

#### M4-T2: Retrieval ranking
- prioritize current logical section
- definition
- direct references
- callers/callees when available
- related configuration/tests/docs

Acceptance criteria:
- ranking rules are explicit and testable
- deterministic relationships outrank semantic guesses

#### M4-T3: Context budgets
- enforce max files
- max lines
- max bytes
- max tokens
- max traversal depth
- max retrieval time

Acceptance criteria:
- oversized retrievals are bounded safely
- the system never emits unlimited repository content

### Milestone 5 — Deterministic tool layer

Goal:

Expose repository intelligence without involving an LLM.

Tasks:

#### M5-T1: `find_definition`
#### M5-T2: `find_usages`
#### M5-T3: `search_codebase`
#### M5-T4: `get_symbol_context`
#### M5-T5: `get_project_overview`
#### M5-T6: `get_logical_section`
#### M5-T7: `trace_call_chain`

Each tool must:
- validate input
- remain workspace-scoped
- return structured facts
- include confidence/source metadata where applicable

Acceptance criteria:
- deterministic tools function with local runtime only
- none of them require network or model access

### Milestone 6 — Model gateway and structured explanation

Goal:

Add bounded LLM usage without breaking determinism, privacy, or rendering consistency.

Tasks:

#### M6-T1: Provider abstraction
- define provider interface
- support one provider path first
- keep adapters isolated

Acceptance criteria:
- provider-specific request logic is not leaked into core runtime

#### M6-T2: Prompt assembly
- construct prompts from deterministic facts and bounded repository context
- mark repository content as untrusted
- prohibit instruction-following from source text

Acceptance criteria:
- prompts have explicit trusted/untrusted boundaries

#### M6-T3: Explanation normalization
- normalize model output into canonical `Explanation` schema
- preserve `sources`, `confidence`, and `inferredClaims`

Acceptance criteria:
- UI does not depend on arbitrary model markdown
- missing sections are tolerated gracefully

### Milestone 7 — Sessions and follow-up flow

Goal:

Support multi-turn code understanding without recomputing everything blindly.

Tasks:

#### M7-T1: Session model
- implement Code Understanding Session storage
- store target, prior context bundle, prior explanation, relevant symbols, bounded history

Acceptance criteria:
- follow-up requests can locate and reuse the active session

#### M7-T2: Session expiry and drift handling
- expire sessions after inactivity
- invalidate session reuse when file/target drift makes reuse unsafe

Acceptance criteria:
- stale session state does not silently produce misleading follow-ups

#### M7-T3: `answer_followup`
- interpret user follow-up against current session
- reuse context when valid
- trigger refresh when required

Acceptance criteria:
- a basic follow-up can succeed without full context rebuild when safe

### Milestone 8 — VS Code-compatible adapter and UX

Goal:

Expose the MVP through a usable IDE flow.

Tasks:

#### M8-T1: Editor event capture
- active file change
- selection change
- cursor change
- explicit Explain action

Acceptance criteria:
- no model call on every cursor movement by default

#### M8-T2: Request orchestration
- debounce rapid events
- cancel stale requests
- prioritize latest user intent

Acceptance criteria:
- outdated requests do not overwrite newer results

#### M8-T3: Explanation side panel
- show summary and structured sections
- render clickable source references
- show progress states

Acceptance criteria:
- source links navigate correctly
- progress is step-specific, not just a spinner

#### M8-T4: Context visibility and privacy UI
- show provider
- show privacy mode
- show included context categories
- show excluded/blocked reasons
- allow context preview

Acceptance criteria:
- users can inspect what will be sent externally before or during request execution

### Milestone 9 — Security hardening

Goal:

Validate that the MVP behaves safely under adversarial inputs.

Tasks:

#### M9-T1: Prompt injection protections
- ensure repository content is wrapped and marked untrusted
- ensure model output cannot escalate privileges

#### M9-T2: Secret handling
- scan bounded context before provider calls
- redact while preserving explanation structure where possible

#### M9-T3: Workspace isolation tests
- path traversal
- symlink escape
- ignored file handling
- oversized file handling

Acceptance criteria:
- blocked cases fail safely and visibly

### Milestone 10 — Evaluation harness

Goal:

Measure quality and regressions objectively.

Tasks:

#### M10-T1: Python fixture repositories
- simple fixture repo
- moderately realistic fixture repo
- adversarial/security fixture repo

#### M10-T2: Case runner
- define test-case schema
- run symbol-resolution cases
- run logical-section cases
- run retrieval cases

#### M10-T3: Grounding and attribution checks
- verify cited file/line references
- verify facts vs inference separation

#### M10-T4: Security evaluation
- prompt injection fixtures
- secret leakage fixtures
- path traversal/symlink fixtures

Acceptance criteria:
- evaluation reports can compare retrieval/explanation quality across versions

## Suggested initial implementation order

If a single AI agent is starting from zero, the recommended order is:

1. M0-T1 through M0-T3
2. M1-T1 through M1-T3
3. M2-T1 through M2-T3
4. M3-T1 through M3-T5
5. M4-T1 through M4-T3
6. M5-T1, M5-T4, M5-T6
7. M6-T1 through M6-T3
8. M8-T1 through M8-T4
9. M7-T1 through M7-T3
10. M9-T1 through M9-T3
11. M10-T1 through M10-T4

This order reaches the thinnest valuable vertical slice as early as possible.

## Best first deliverable for an AI coding agent

If the next agent can only do one meaningful chunk, assign:

### Starter task

Implement the first vertical slice:

- workspace-safe runtime skeleton
- Python AST parsing
- symbol extraction
- `find_definition`
- logical section resolution
- bounded context builder
- one model provider adapter
- structured explanation rendering path in VS Code

### Definition of success

A developer can select a Python symbol in a VS Code-compatible IDE and receive a cited, structured explanation built from local repository understanding.

## Handoff notes for future AI agents

When picking up work from this backlog:

- start with the smallest vertical slice that reaches the user
- do not broaden to additional languages until Python quality is acceptable
- avoid speculative architecture that is not needed for the proof slice
- preserve deterministic/generative separation
- preserve facts/inference separation
- keep the runtime local-first and security-first
