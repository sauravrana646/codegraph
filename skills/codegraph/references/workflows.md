# Codegraph workflows

## Explain an unfamiliar symbol

1. Gather location (`rootPath`, `filePath`, `line`, `selectedText`).
2. Call `explain_selection` with `enrich` omitted or `false`.
3. Answer from `data.explanation` + `data.context` sources, expanding narrative yourself if needed.
4. On Cursor plans, never request API keys and never set `enrich: true`.

See also [cursor-plan.md](cursor-plan.md).

## Find definition then usages

1. `find_definition` → open/cite top hit.
2. `find_usages` on the same request → summarize call sites by file.
3. If results look noisy, mention kind/score and prefer `call` over `mention`.

## Bound context for a change

1. `logical_section` with `depth: function` (or `class`).
2. Use the excerpt + start/end lines as the edit window.
3. Optionally `find_usages` to check callers before editing.

## Agent answer with citations

1. Run Codegraph tools before writing a definitive explanation.
2. Separate:
   - Facts: sources, definitions, usages, metadata
   - Inferences: your synthesis beyond returned sources
3. If capability tier/confidence is low, say uncertainty explicitly.

## Session-style follow-up (HTTP)

1. `POST /v1/sessions/explain-selection`
2. Reuse `sessionId` with `POST /v1/sessions/followup` and `action` in:
   - `explain-selection`
   - `find-definition`
   - `find-usages`
   - `logical-section`
