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
import { z } from "zod";

// Zod raw shape required by MCP SDK at runtime.
const toolInputShape = {
  rootPath: z.string().describe("Absolute workspace root path"),
  filePath: z.string().describe("Workspace-relative file path"),
  line: z.number().int().min(1).describe("1-based line number"),
  selectedText: z.string().optional().describe("Optional selected symbol or text"),
  depth: z.enum(["statement", "function", "class", "auto"]).optional().describe("Logical section depth"),
  enrich: z.boolean().optional().describe("Opt-in model enrichment (usually leave false; agent enriches)")
};

type ToolArgs = {
  rootPath: string;
  filePath: string;
  line: number;
  selectedText?: string;
  depth?: "statement" | "function" | "class" | "auto";
  enrich?: boolean;
};

type RegisterTool = (
  name: string,
  config: { description: string; inputSchema: typeof toolInputShape },
  handler: (args: ToolArgs) => Promise<{ content: Array<{ type: "text"; text: string }> }>
) => void;

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
  if (path.isAbsolute(args.filePath) || args.filePath.includes("\0")) {
    throw new Error("filePath must be a workspace-relative path");
  }

  return {
    rootPath: assertAllowedRoot(args.rootPath),
    filePath: args.filePath,
    line: args.line,
    selectedText: args.selectedText,
    depth: args.depth,
    enrich: args.enrich,
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

async function main(): Promise<void> {
  const server = new McpServer({
    name: "codegraph",
    version: "0.1.0"
  });

  // Avoid MCP SDK Zod generic depth explosions under classic moduleResolution.
  const registerTool = (server as unknown as { registerTool: RegisterTool }).registerTool.bind(server);

  registerTool(
    "explain_selection",
    {
      description:
        "Build a deterministic Python-first selection explanation with sources, confidence, and optional enrichment.",
      inputSchema: toolInputShape
    },
    async (args) => envelopeResult(await runExplainSelectionTool(asToolRequest(args)))
  );

  registerTool(
    "find_definition",
    {
      description: "Find ranked definition candidates for the selected symbol or line.",
      inputSchema: toolInputShape
    },
    async (args) => envelopeResult(await runFindDefinitionTool(asToolRequest(args)))
  );

  registerTool(
    "find_usages",
    {
      description: "Find ranked usage candidates (calls, attributes, imports, mentions) for the selected symbol.",
      inputSchema: toolInputShape
    },
    async (args) => envelopeResult(await runFindUsagesTool(asToolRequest(args)))
  );

  registerTool(
    "logical_section",
    {
      description: "Extract the logical section around a line with depth statement|function|class|auto.",
      inputSchema: toolInputShape
    },
    async (args) => envelopeResult(await runLogicalSectionTool(asToolRequest(args)))
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Codegraph MCP server failed:", error);
  process.exit(1);
});
