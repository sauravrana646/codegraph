import {
  buildProjectOverview,
  buildSymbolContext,
  ensureWorkspaceIndex,
  findDefinition,
  findUsages,
  getLogicalSection,
  getOrBuildIndex,
  searchIndexedSymbols,
  traceCallChain
} from "@codegraph/core";
import {
  toolSuccess,
  type LogicalSectionDepth,
  type ResolutionMetadata,
  type ToolEnvelope
} from "@codegraph/protocol";

export interface ToolRequest {
  rootPath: string;
  filePath: string;
  line: number;
  selectedText?: string;
  depth?: LogicalSectionDepth;
  enrich?: boolean;
  query?: string;
  force?: boolean;
  /**
   * Provider overrides are only honored when trustProviderConfig is true
   * (trusted local callers such as the IDE extension). HTTP/MCP ignore these.
   */
  provider?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
  trustProviderConfig?: boolean;
}

export type NamedToolAction =
  | "explain-selection"
  | "find-definition"
  | "find-usages"
  | "logical-section"
  | "search-codebase"
  | "get-symbol-context"
  | "get-project-overview"
  | "trace-call-chain"
  | "ensure-index";

function logicalSectionMetadata(confidence: number): ResolutionMetadata {
  return {
    source: "ast",
    capabilityTier: confidence >= 0.7 ? 2 : 1,
    confidence
  };
}

function truncateExcerpt(excerpt: string | undefined, maxChars: number): string | undefined {
  if (!excerpt) {
    return undefined;
  }
  const trimmed = excerpt.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function compactRef(item: { file: string; line: number; kind?: string; score?: number; excerpt?: string }) {
  return {
    file: item.file,
    line: item.line,
    kind: item.kind,
    score: item.score,
    excerpt: truncateExcerpt(item.excerpt, 160)
  };
}

/**
 * explain_selection returns a bounded source window only — no AST/LSP dumps.
 * Agent (or API enrichment callers) should read/explain from that window.
 */
export async function runExplainSelectionTool(request: ToolRequest): Promise<ToolEnvelope<unknown>> {
  const section = await getLogicalSection({
    rootPath: request.rootPath,
    filePath: request.filePath,
    line: request.line,
    selectedText: request.selectedText,
    depth: request.depth ?? "auto"
  });

  return toolSuccess(
    "explain-selection",
    {
      target: {
        rootPath: request.rootPath,
        filePath: request.filePath,
        line: request.line,
        selectedText: request.selectedText ?? null
      },
      section: {
        kind: section.kind,
        symbolName: section.symbolName ?? null,
        startLine: section.startLine,
        endLine: section.endLine,
        excerpt: truncateExcerpt(section.excerpt, 900) ?? ""
      }
    },
    { metadata: logicalSectionMetadata(section.confidence) }
  );
}

export async function runFindDefinitionTool(request: ToolRequest): Promise<ToolEnvelope<unknown>> {
  const items = await findDefinition(request);
  return toolSuccess("find-definition", {
    items: items.slice(0, 8).map((item) => compactRef(item))
  });
}

export async function runFindUsagesTool(request: ToolRequest): Promise<ToolEnvelope<unknown>> {
  const items = await findUsages(request);
  return toolSuccess("find-usages", {
    items: items.slice(0, 12).map((item) => compactRef(item))
  });
}

export async function runLogicalSectionTool(request: ToolRequest): Promise<ToolEnvelope<unknown>> {
  const section = await getLogicalSection(request);
  return toolSuccess(
    "logical-section",
    {
      section: {
        ...section,
        excerpt: truncateExcerpt(section.excerpt, 900)
      }
    },
    { metadata: logicalSectionMetadata(section.confidence) }
  );
}

export async function runSearchCodebaseTool(request: ToolRequest): Promise<ToolEnvelope<unknown>> {
  const query = request.query?.trim() || request.selectedText?.trim() || "";
  const { index } = await getOrBuildIndex(request.rootPath);
  const items = searchIndexedSymbols(index, query);
  return toolSuccess("search-codebase", { query, items });
}

export async function runGetSymbolContextTool(request: ToolRequest): Promise<ToolEnvelope<unknown>> {
  const symbol = request.selectedText?.trim() || "";
  const context = await buildSymbolContext({
    rootPath: request.rootPath,
    filePath: request.filePath,
    line: request.line,
    symbolName: symbol || "(unknown)"
  });
  return toolSuccess("get-symbol-context", {
    symbol: context.symbol,
    definitions: context.definitions.slice(0, 6).map((item) => compactRef(item)),
    references: context.references.slice(0, 10).map((item) => compactRef(item)),
    relatedFiles: context.relatedFiles.slice(0, 8).map((item) => compactRef(item)),
    callers: context.callers.slice(0, 8).map((item) => compactRef(item)),
    callees: context.callees.slice(0, 8).map((item) => compactRef(item))
  });
}

export async function runGetProjectOverviewTool(request: ToolRequest): Promise<ToolEnvelope<unknown>> {
  const { index } = await getOrBuildIndex(request.rootPath);
  return toolSuccess("get-project-overview", buildProjectOverview(index));
}

export async function runTraceCallChainTool(request: ToolRequest): Promise<ToolEnvelope<unknown>> {
  const symbol = request.selectedText?.trim() || "";
  const hops = await traceCallChain({
    rootPath: request.rootPath,
    filePath: request.filePath,
    symbolName: symbol,
    line: request.line
  });
  return toolSuccess("trace-call-chain", { symbol, hops });
}

export async function runEnsureIndexTool(request: ToolRequest): Promise<ToolEnvelope<unknown>> {
  const result = await ensureWorkspaceIndex(request.rootPath, { force: Boolean(request.force) });
  return toolSuccess("ensure-index", {
    total: result.total,
    changed: result.changed,
    removed: result.removed,
    unchanged: result.unchanged,
    skipped: result.skipped,
    failed: result.failed,
    truncated: result.truncated,
    parseAst: result.parseAst,
    parseRegex: result.parseRegex,
    astUnavailable: result.astUnavailable,
    goAstUnavailable: result.goAstUnavailable,
    updatedAt: result.index.updatedAt
  });
}

export async function runNamedTool(
  action: NamedToolAction,
  request: ToolRequest
): Promise<ToolEnvelope<unknown>> {
  switch (action) {
    case "explain-selection":
      return runExplainSelectionTool(request);
    case "find-definition":
      return runFindDefinitionTool(request);
    case "find-usages":
      return runFindUsagesTool(request);
    case "search-codebase":
      return runSearchCodebaseTool(request);
    case "get-symbol-context":
      return runGetSymbolContextTool(request);
    case "get-project-overview":
      return runGetProjectOverviewTool(request);
    case "trace-call-chain":
      return runTraceCallChainTool(request);
    case "ensure-index":
      return runEnsureIndexTool(request);
    default:
      return runLogicalSectionTool(request);
  }
}
