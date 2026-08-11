# Codegraph tool reference

All surfaces (MCP, HTTP, CLI) share the same envelope and request shape.

## Common request

```json
{
  "rootPath": "/abs/path/to/workspace",
  "filePath": "examples/demo.py",
  "line": 10,
  "selectedText": "create",
  "depth": "auto",
  "enrich": false
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `rootPath` | yes | Absolute workspace root |
| `filePath` | yes | Path relative to `rootPath` |
| `line` | yes | 1-based line |
| `selectedText` | no | Symbol / selection text |
| `depth` | no | `statement` \| `function` \| `class` \| `auto` (logical section) |
| `enrich` | no | Opt-in narrative enrichment for explain |
| `provider` | no | `{ apiKey?, baseUrl?, model? }` for enrichment |

## Envelope

Success:

```json
{
  "ok": true,
  "tool": "explain-selection",
  "data": {},
  "metadata": {
    "source": "ast",
    "capabilityTier": 2,
    "confidence": 0.82
  },
  "enrichment": {
    "used": false
  }
}
```

Error:

```json
{
  "ok": false,
  "error": {
    "code": "invalid_request",
    "message": "..."
  }
}
```

## Tools

### `explain_selection`

Returns a bounded source window for the target (`section` excerpt) — not an AST/LSP dump.

Use for: “what does this do?”, onboarding to a symbol, citation-backed answers after you read the window.

### `find_definition`

Returns `{ items: [{ file, line, kind, score }] }` ranked definition locations.

Prefer the top-scoring item unless conflicts are obvious.

### `find_usages`

Returns `{ items: [{ file, line, kind, score }] }` ranked usage locations.

Kinds: `call`, `attribute`, `import`, `mention`. Definition lines are filtered out.

### `logical_section`

Returns `{ section: { file, symbolName?, kind, depth, startLine, endLine, excerpt, confidence } }`.

Use `depth: function` or `class` when you need a bounded excerpt for editing/review.

## HTTP endpoints

Base: `http://127.0.0.1:4311`

- `GET /health`
- `POST /v1/tools/explain-selection`
- `POST /v1/tools/find-definition`
- `POST /v1/tools/find-usages`
- `POST /v1/tools/logical-section`
- `POST /v1/sessions/explain-selection`
- `POST /v1/sessions/followup`

## Language expectations

- Gold path: Python (`.py`)
- Tools return bounded source windows and `file:line` locations — not AST/LSP context packs
- Other languages: weaker / experimental; say so when confidence is low
