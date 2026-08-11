# Cursor / Claude plan workflow (agent does enrichment too)

## Rule

Pick **one** generative path:

| Mode | Checkbox | LLM used for |
| --- | --- | --- |
| Built-in agent (default) | `useBuiltInAgent` | **All** generative work: enrichment + explanation |
| API key provider | `useApiKeyProvider` | **All** generative work: in-panel enrichment |

Deterministic tools (definitions, usages, sources, base explanation) always run locally with **no** model.

Details: [references/live-tutoring.md](references/live-tutoring.md).

## Agent mode

1. Extension may gather local hints, but the Agent prompt is a **slim pointer** (file / line / symbol + tool instructions).
2. Live Explain / Ask Agent always hands off to Cursor/Claude Agent (subscription model); the Agent **pulls** facts via Codegraph tools.
3. Never ask for API keys.
4. Agent must cite only Codegraph `file:line` sources returned by tools.

## API key mode

1. Extension builds deterministic context.
2. Enrichment runs via OpenAI-compatible provider using the configured API key.
3. Panel shows enriched narrative fields; sources stay deterministic.

## Skill behavior

When this skill is active inside Cursor/Claude Agent:

- Call tools with `enrich` omitted/false (you are the enrichment model).
- Write enriched explanation yourself from the tool envelope.
- Do not request `CODEGRAPH_API_KEY` / `OPENAI_API_KEY`.
