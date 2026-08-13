# Codegraph workflows

## Explain an unfamiliar symbol

1. If the Live Explain handoff includes **NEIGHBORHOOD**, trust those `file:line` facts and read only the target section — do not scan the repo.
2. Otherwise gather location (`rootPath`, `filePath`, `line`, `selectedText`) and call `get_symbol_context` or `explain_selection`.
3. Answer from neighborhood / tool facts, expanding narrative yourself.
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

1. Prefer the handoff NEIGHBORHOOD (or `get_symbol_context`) before reading extra files.
2. Separate:
   - Facts: sources, definitions, callers/callees, metadata
   - Inferences: your synthesis beyond returned sources
3. If capability tier/confidence is low, say uncertainty explicitly.

## Session-style follow-up (HTTP)

1. `POST /v1/sessions/explain-selection`
2. Reuse `sessionId` with `POST /v1/sessions/followup` and `action` in:
   - `explain-selection`
   - `find-definition`
   - `find-usages`
   - `logical-section`
