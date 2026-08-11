#!/usr/bin/env node
import {
  runExplainSelectionTool,
  runFindDefinitionTool,
  runFindUsagesTool,
  runLogicalSectionTool,
  type ToolRequest
} from "@codegraph/agent-tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

type ToolArgs = ToolRequest;

const toolInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    rootPath: { type: "string", description: "Absolute workspace root path" },
    filePath: { type: "string", description: "Workspace-relative file path" },
    line: { type: "integer", minimum: 1, description: "1-based line number" },
    selectedText: { type: "string", description: "Optional selected symbol or text" },
    depth: {
      type: "string",
      enum: ["statement", "function", "class", "auto"],
      description: "Logical section depth"
    },
    enrich: { type: "boolean", description: "Opt-in model enrichment for explain-selection" },
    provider: {
      type: "object",
      additionalProperties: false,
      properties: {
        apiKey: { type: "string" },
        baseUrl: { type: "string" },
        model: { type: "string" }
      }
    }
  },
  required: ["rootPath", "filePath", "line"]
} as const;

function asToolRequest(args: ToolArgs): ToolRequest {
  return {
    rootPath: args.rootPath,
    filePath: args.filePath,
    line: args.line,
    selectedText: args.selectedText,
    depth: args.depth,
    enrich: args.enrich,
    provider: args.provider
  };
}

function envelopeResult(envelope: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(envelope, null, 2)
      }
    ]
  };
}

function parseToolArgs(args: unknown): ToolArgs {
  if (!args || typeof args !== "object") {
    throw new Error("Tool arguments must be an object");
  }

  const candidate = args as Partial<ToolArgs>;

  if (
    typeof candidate.rootPath !== "string" ||
    typeof candidate.filePath !== "string" ||
    typeof candidate.line !== "number"
  ) {
    throw new Error("Tool arguments require rootPath, filePath, and line");
  }

  return candidate as ToolArgs;
}

async function main(): Promise<void> {
  const server = new McpServer({
    name: "codegraph",
    version: "0.1.0"
  });

  // MCP SDK Zod typings conflict with the monorepo TypeScript moduleResolution.
  // Use JSON Schema + runtime validation instead.
  const schema = toolInputSchema as unknown as Record<string, never>;

  server.registerTool(
    "explain_selection",
    {
      description:
        "Build a deterministic Python-first selection explanation with sources, confidence, and optional enrichment.",
      inputSchema: schema
    },
    async (args: unknown) => envelopeResult(await runExplainSelectionTool(asToolRequest(parseToolArgs(args))))
  );

  server.registerTool(
    "find_definition",
    {
      description: "Find ranked definition candidates for the selected symbol or line.",
      inputSchema: schema
    },
    async (args: unknown) => envelopeResult(await runFindDefinitionTool(asToolRequest(parseToolArgs(args))))
  );

  server.registerTool(
    "find_usages",
    {
      description: "Find ranked usage candidates (calls, attributes, imports, mentions) for the selected symbol.",
      inputSchema: schema
    },
    async (args: unknown) => envelopeResult(await runFindUsagesTool(asToolRequest(parseToolArgs(args))))
  );

  server.registerTool(
    "logical_section",
    {
      description: "Extract the logical section around a line with depth statement|function|class|auto.",
      inputSchema: schema
    },
    async (args: unknown) => envelopeResult(await runLogicalSectionTool(asToolRequest(parseToolArgs(args))))
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Codegraph MCP server failed:", error);
  process.exit(1);
});
