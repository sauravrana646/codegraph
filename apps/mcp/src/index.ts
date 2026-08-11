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
import path from "node:path";

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
    enrich: { type: "boolean", description: "Opt-in model enrichment for explain-selection" }
  },
  required: ["rootPath", "filePath", "line"]
} as const;

const ALLOWED_ROOTS = (process.env.CODEGRAPH_ALLOWED_ROOTS ?? "")
  .split(path.delimiter)
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => path.resolve(value));

function assertAllowedRoot(rootPath: string): string {
  const resolved = path.resolve(rootPath);

  if (ALLOWED_ROOTS.length === 0) {
    return resolved;
  }

  const allowed = ALLOWED_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!allowed) {
    throw new Error("rootPath is not in CODEGRAPH_ALLOWED_ROOTS");
  }

  return resolved;
}

function asToolRequest(args: ToolArgs): ToolRequest {
  return {
    rootPath: assertAllowedRoot(args.rootPath),
    filePath: args.filePath,
    line: args.line,
    selectedText: args.selectedText,
    depth: args.depth,
    enrich: args.enrich,
    // MCP callers never supply provider credentials/baseUrl.
    provider: undefined,
    trustProviderConfig: false
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
    !Number.isInteger(candidate.line) ||
    (candidate.line as number) < 1
  ) {
    throw new Error("Tool arguments require rootPath, filePath, and integer line >= 1");
  }

  if (path.isAbsolute(candidate.filePath) || candidate.filePath.includes("\0")) {
    throw new Error("filePath must be a workspace-relative path");
  }

  if (
    candidate.depth !== undefined &&
    candidate.depth !== "statement" &&
    candidate.depth !== "function" &&
    candidate.depth !== "class" &&
    candidate.depth !== "auto"
  ) {
    throw new Error("depth must be statement|function|class|auto");
  }

  if (candidate.selectedText !== undefined && typeof candidate.selectedText !== "string") {
    throw new Error("selectedText must be a string");
  }

  if (candidate.enrich !== undefined && typeof candidate.enrich !== "boolean") {
    throw new Error("enrich must be a boolean");
  }

  return {
    rootPath: candidate.rootPath,
    filePath: candidate.filePath,
    line: candidate.line as number,
    selectedText: candidate.selectedText,
    depth: candidate.depth,
    enrich: candidate.enrich
  };
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
