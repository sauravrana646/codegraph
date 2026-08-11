# Cursor plan workflow (no API keys)

## Goal

Use Codegraph with a Cursor subscription without configuring OpenAI/Anthropic API keys.

## Architecture

```text
User selection / question
        │
        ├─ Extension: deterministic analysis → side panel
        │                 └─ optional "Ask Cursor Agent" handoff
        │
        └─ Cursor Agent + skill/MCP: call explain_selection etc.
                          └─ Agent model writes narrative (Cursor plan)
```

- **Deterministic tools** never need a model key.
- **Narrative quality** comes from the Cursor agent (skill path), not from `CODEGRAPH_API_KEY`.
- Optional OpenAI-compatible enrichment is only for advanced/self-hosted setups.

## Do

1. Install skill + MCP (or use repo symlinks).
2. Install extension VSIX for highlight/click UX.
3. Ask Cursor Agent to explain/navigate code; it should call Codegraph tools with `enrich` unset/false.
4. Use extension **Ask Cursor Agent** to paste grounded context into chat when starting from a selection.

## Do not

1. Ask the user for model API keys for normal Cursor use.
2. Call tools with `enrich: true` on Cursor plan workflows.
3. Invent sources beyond Codegraph citations.
