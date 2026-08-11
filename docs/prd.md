# Product Requirements Document — Codebase Intelligence Agent

## Product vision

Create a persistent codebase intelligence layer that lets AI explain code in repository context with higher accuracy, better grounding, and clearer source attribution than snippet-only approaches.

The MVP should feel like:

> An experienced engineer who already understands this repository and can explain why code exists, how it works, and where it connects.

## Product thesis

The product is not another generic chatbot inside an IDE. Its value comes from:

- understanding the repository locally
- retrieving relevant context deterministically
- bounding and securing model inputs
- clearly separating facts from inference

## Target user

Primary MVP user:

- developers working in unfamiliar **Python** repositories
- backend/platform/SRE-oriented users who need to understand code, configuration, tests, and control flow quickly

Secondary users:

- engineers onboarding to legacy systems
- technical consultants
- support and security engineers

## MVP positioning

### Gold-standard V1 language

- **Python**

### Early additional language support

- TypeScript/JavaScript may exist in lower capability tiers
- they are not part of the initial quality bar

### Primary environment

- VS Code-compatible IDEs

## Core user problems

Developers frequently need to answer:

- What is this symbol or code section?
- What does it do here?
- Why was this implementation chosen?
- Who calls it?
- What depends on it?
- What configuration or tests affect it?
- Which explanation points are verified facts vs informed inference?

## MVP user stories

### US-001 — Explain a selected Python symbol

As a developer, I want to select a Python symbol and ask for an explanation so I can understand both its general purpose and its role in the current repository.

Acceptance criteria:

- selection is captured correctly
- symbol is resolved with confidence metadata
- relevant surrounding scope is included
- definition and repository usage are identified when available
- explanation contains source citations
- explanation distinguishes fact from inference

### US-002 — Explain a logical Python code section

As a developer, I want to place my cursor in Python code and have the system infer the smallest meaningful block so I do not need to manually select an entire function.

Acceptance criteria:

- AST-based block detection is used when available
- function/method/class context is included appropriately
- fixed line-window heuristics are not the primary mechanism
- explanation can describe execution flow at the right scope

### US-003 — Understand why code exists

As a developer, I want the system to explain why a piece of code likely exists in this repository.

Acceptance criteria:

- direct evidence is retrieved when available
- inferred reasoning is clearly labeled
- the system cites tests, config, callers, or related modules where relevant
- speculation is not presented as verified fact

### US-004 — Continue understanding via follow-up questions

As a developer, I want to ask follow-up questions without redoing all repository understanding from scratch.

Acceptance criteria:

- follow-ups reuse the current Code Understanding Session
- session context is bounded and expires after inactivity
- stale or drifted context is detected and refreshed when needed

### US-005 — Control what leaves my machine

As a developer, I want to know what context is being sent to an external model provider and be able to restrict it.

Acceptance criteria:

- provider is visible
- privacy mode is visible
- context preview is available
- secret scanning/redaction status is visible
- excluded or blocked content is explainable

## Functional requirements

## FR-001 IDE context

The system shall capture:

- workspace
- active file
- cursor
- selection
- language
- user-invoked explanation actions

## FR-002 Repository discovery

The system shall discover repository structure without executing repository code.

## FR-003 Local indexing

The system shall create a local index for supported source files and relevant repository metadata.

## FR-004 Incremental indexing

The index shall be incremental, asynchronous, and derived from workspace state.

## FR-005 Capability-based intelligence

The system shall operate through capability tiers:

- Tier 0 — Text
- Tier 1 — AST
- Tier 2 — Symbol
- Tier 3 — LSP
- Tier 4 — Deep relationship intelligence

Each operation should expose:

- capability tier
- source of result
- confidence

## FR-006 Python-first symbol resolution

The MVP shall prioritize reliable symbol resolution, logical section detection, and repository relationship discovery for Python code.

## FR-007 Deterministic retrieval before semantic retrieval

The system shall prefer:

- structural relationships
- symbol relationships
- repository metadata

before semantic similarity methods.

## FR-008 Structured explanation contract

The system shall produce explanations using a stable structured schema rather than model-specific free-form output.

### Explanation schema

```typescript
interface Explanation {
  summary: string;
  whatItDoes?: string;
  howItWorks?: string;
  whyItExists?: string;
  codebaseUsage?: string;
  executionFlow?: FlowStep[];
  examples?: Example[];
  relatedCode?: SourceReference[];
  caveats?: string[];
  confidence: Confidence;
  sources: SourceReference[];
  inferredClaims?: InferredClaim[];
}
```

## FR-009 Code Understanding Sessions

The system shall support short-lived sessions containing:

- workspace
- file
- target
- previous context bundle
- previous explanation
- relevant symbols
- bounded conversation history

The repository index persists beyond the session.

## FR-010 Deterministic and generative tool separation

The system shall distinguish:

### Deterministic tools

No LLM call:

- `find_definition`
- `find_usages`
- `search_codebase`
- `get_symbol_context`
- `get_project_overview`
- `get_logical_section`
- `trace_call_chain`

### Generative tools

LLM-backed:

- `explain_selection`
- `explain_code_section`
- `answer_followup`
- `explain_architecture`

## FR-011 Privacy controls

The system shall expose:

- local-only mode
- controlled cloud mode
- custom provider mode
- context preview
- provider visibility
- secret redaction status
- inclusion/exclusion reasoning

## FR-012 Source attribution

Important claims should cite source locations wherever feasible.

## UX requirements

### UX-001 Minimal interruption

The default MVP flow is:

```text
Select -> Explain
```

No model call should happen on every cursor movement by default.

### UX-002 Persistent explanation panel

Explanations should render in a side panel with source navigation.

### UX-003 Progress visibility

The UI should show meaningful steps such as:

- finding symbol
- resolving references
- building context
- checking privacy policy
- generating explanation

### UX-004 Context visibility

Users should be able to inspect what context will be sent externally.

Example:

```text
Sending to: Claude
Context included:
- current function
- symbol definition
- 4 references
- 2 related files
Secrets detected: 0
```

### UX-005 Facts vs inference

The UI should clearly distinguish:

- verified facts
- inferred reasoning
- caveats or uncertainty

## Security requirements

- repository content is always untrusted data
- no arbitrary command execution in MVP
- read-only is the default
- all paths must be workspace-bounded and normalized
- symlinks must not escape the workspace
- secret scanning/redaction must run before external model calls
- prompts must explicitly forbid following repository-embedded instructions

## Non-goals for MVP

- autonomous code editing
- arbitrary command execution
- deployment workflows
- multi-user collaboration
- enterprise control plane
- broad language parity
- mandatory cloud backend

## Success criteria

The MVP succeeds when a developer can say:

> I can understand unfamiliar Python code in this repository without manually searching through the project.

And the system can reliably provide:

- correct symbol grounding
- correct or useful logical section resolution
- cited source-backed explanation
- visible privacy boundaries
- explicit fact/inference separation
