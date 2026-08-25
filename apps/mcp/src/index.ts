#!/usr/bin/env node
import {
  runEnsureIndexTool,
  runExplainSelectionTool,
  runFindDefinitionTool,
  runFindUsagesTool,
  runGetProjectOverviewTool,
  runGetSymbolContextTool,
  runLogicalSectionTool,
  runSearchCodebaseTool,
  runTraceCallChainTool,
  type ToolRequest
} from "@codegraph/agent-tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { z } from "zod";

const locationShape = {
  rootPath: z.string().describe("Absolute workspace root path"),
  filePath: z.string().describe("Workspace-relative file path"),
  line: z.number().int().min(1).describe("1-based line number"),
  selectedText: z.string().optional().describe("Optional selected symbol or text"),
  depth: z.enum(["statement", "function", "class", "auto"]).optional().describe("Logical section depth")
};

const searchShape = {
  rootPath: z.string().describe("Absolute workspace root path"),
  query: z.string().describe("Symbol or name fragment to search"),
  filePath: z.string().optional().describe("Optional workspace-relative file path"),
  line: z.number().int().min(1).optional(),
  selectedText: z.string().optional()
};

const rootShape = {
  rootPath: z.string().describe("Absolute workspace root path"),
  force: z.boolean().optional().describe("Rebuild the local index from scratch")
};

type LocationArgs = {
  rootPath: string;
  filePath: string;
  line: number;
  selectedText?: string;
  depth?: "statement" | "function" | "class" | "auto";
};

type SearchArgs = {
  rootPath: string;
  query: string;
  filePath?: string;
  line?: number;
  selectedText?: string;
};

type RootArgs = {
  rootPath: string;
  force?: boolean;
};

type RegisterTool = (
  name: string,
  config: { description: string; inputSchema: Record<string, unknown> },
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>
) => void;

const ALLOWED_ROOTS = (() => {
  const configured = (process.env.CODEGRAPH_ALLOWED_ROOTS ?? "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));
  return configured.length > 0 ? configured : [path.resolve(process.cwd())];
})();

function assertAllowedRoot(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  const allowed = ALLOWED_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!allowed) {
    throw new Error("rootPath is not in CODEGRAPH_ALLOWED_ROOTS");
  }

  return resolved;
}

function asToolRequest(args: LocationArgs): ToolRequest {
  if (path.isAbsolute(args.filePath) || args.filePath.includes("\0")) {
    throw new Error("filePath must be a workspace-relative path");
  }

  return {
    rootPath: assertAllowedRoot(args.rootPath),
    filePath: args.filePath,
    line: args.line,
    selectedText: args.selectedText,
    depth: args.depth,
    enrich: false,
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

  const registerTool = (server as unknown as { registerTool: RegisterTool }).registerTool.bind(server);

  registerTool(
    "explain_selection",
    {
      description: "Bounded source window for a Python/Go target (no AST/LSP dump).",
      inputSchema: locationShape
    },
    async (args) => envelopeResult(await runExplainSelectionTool(asToolRequest(args as LocationArgs)))
  );

  registerTool(
    "find_definition",
    {
      description: "Import-scoped definition file:line candidates from the local index.",
      inputSchema: locationShape
    },
    async (args) => envelopeResult(await runFindDefinitionTool(asToolRequest(args as LocationArgs)))
  );

  registerTool(
    "find_usages",
    {
      description: "Import-scoped usage file:line candidates (call/import/attribute).",
      inputSchema: locationShape
    },
    async (args) => envelopeResult(await runFindUsagesTool(asToolRequest(args as LocationArgs)))
  );

  registerTool(
    "logical_section",
    {
      description: "Extract the logical section around a line with depth statement|function|class|auto.",
      inputSchema: locationShape
    },
    async (args) => envelopeResult(await runLogicalSectionTool(asToolRequest(args as LocationArgs)))
  );

  registerTool(
    "get_symbol_context",
    {
                    description: "Index neighborhood: defs, callers, callees, related files (no repo re-scan).",
      inputSchema: locationShape
    },
    async (args) => envelopeResult(await runGetSymbolContextTool(asToolRequest(args as LocationArgs)))
  );

  registerTool(
    "trace_call_chain",
    {
      description: "One-hop call sites for the selected symbol from the local index.",
      inputSchema: locationShape
    },
    async (args) => envelopeResult(await runTraceCallChainTool(asToolRequest(args as LocationArgs)))
  );

  registerTool(
    "search_codebase",
    {
      description: "Search indexed Python/Go symbol names (local, no LLM).",
      inputSchema: searchShape
    },
    async (args) => {
      const typed = args as SearchArgs;
      return envelopeResult(
        await runSearchCodebaseTool({
          rootPath: assertAllowedRoot(typed.rootPath),
          filePath: typed.filePath ?? ".",
          line: typed.line ?? 1,
          selectedText: typed.selectedText,
          query: typed.query
        })
      );
    }
  );

  registerTool(
    "get_project_overview",
    {
      description: "Local index overview: packages, entrypoints, notable symbols.",
      inputSchema: rootShape
    },
    async (args) => {
      const typed = args as RootArgs;
      return envelopeResult(
        await runGetProjectOverviewTool({
          rootPath: assertAllowedRoot(typed.rootPath),
          filePath: ".",
          line: 1
        })
      );
    }
  );

  registerTool(
    "ensure_index",
    {
      description: "Build or incrementally refresh the local Python/Go workspace index.",
      inputSchema: rootShape
    },
    async (args) => {
      const typed = args as RootArgs;
      return envelopeResult(
        await runEnsureIndexTool({
          rootPath: assertAllowedRoot(typed.rootPath),
          filePath: ".",
          line: 1,
          force: typed.force
        })
      );
    }
  );

  const transport = new StdioServerTransport();
  console.error(`Codegraph MCP allowed roots: ${ALLOWED_ROOTS.join(", ")}`);
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Codegraph MCP server failed:", error);
  process.exit(1);
});
