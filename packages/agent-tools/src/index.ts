import { findDefinition, findUsages, getLogicalSection } from "@codegraph/core";
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

function logicalSectionMetadata(confidence: number): ResolutionMetadata {
  return {
    source: "text",
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
    items: items.slice(0, 8).map((item) => ({
      file: item.file,
      line: item.line,
      kind: item.kind,
      score: item.score
    }))
  });
}

export async function runFindUsagesTool(request: ToolRequest): Promise<ToolEnvelope<unknown>> {
  const items = await findUsages(request);
  return toolSuccess("find-usages", {
    items: items.slice(0, 12).map((item) => ({
      file: item.file,
      line: item.line,
      kind: item.kind,
      score: item.score
    }))
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

export async function runNamedTool(
  action: "explain-selection" | "find-definition" | "find-usages" | "logical-section",
  request: ToolRequest
): Promise<ToolEnvelope<unknown>> {
  if (action === "explain-selection") {
    return runExplainSelectionTool(request);
  }

  if (action === "find-definition") {
    return runFindDefinitionTool(request);
  }

  if (action === "find-usages") {
    return runFindUsagesTool(request);
  }

  return runLogicalSectionTool(request);
}
