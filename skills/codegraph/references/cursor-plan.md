# Cursor / Claude plan workflow (agent does enrichment too)

## Rule

Pick **one** generative path:

| Mode | Checkbox | LLM used for |
| --- | --- | --- |
| Built-in agent (default) | `useBuiltInAgent` | **All** generative work: enrichment + explanation |
| API key provider | `useApiKeyProvider` | **All** generative work: in-panel enrichment |

Neither path ships AST/LSP context packs.

## Agent mode

1. Extension sends a **slim pointer** plus a compact **index neighborhood** (`codegraph-slim-v4`: file / line / symbol / callers / callees).
2. Agent reads **only the target section** (and neighborhood files if quoting). Do not grep the repo when NEIGHBORHOOD is present.
3. Never ask for API keys.
4. Cite real `file:line` values.

## API key mode

1. Extension builds a short **source window** + file:line index (no IDE LSP).
2. Enrichment runs via OpenAI-compatible provider.
3. Panel shows enriched narrative fields.

## Skill behavior

When this skill is active inside Cursor/Claude Agent:

- Read the target source; do not request AST/LSP dumps.
- Call tools only for bounded sections or location lists.
- Write the explanation yourself.
- Do not request `CODEGRAPH_API_KEY` / `OPENAI_API_KEY`.
