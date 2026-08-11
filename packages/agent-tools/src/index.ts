import { buildSelectionContext, findDefinition, findUsages, getLogicalSection } from "@codegraph/core";
import { enrichSelectionContext } from "@codegraph/model-gateway";
import {
  toolSuccess,
  type LogicalSectionDepth,
  type ResolutionMetadata,
  type ToolEnvelope,
  type ToolEnrichmentMetadata
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
    source: "ast",
    capabilityTier: confidence >= 0.7 ? 2 : 1,
    confidence
  };
}

function slimSource(item: { file: string; line: number; excerpt?: string; kind?: string; score?: number }) {
  return {
    file: item.file,
    line: item.line,
    kind: item.kind,
    score: item.score,
    excerpt: item.excerpt ? item.excerpt.trim().slice(0, 160) : undefined
  };
}

/** Compact tool payload so Agent does not drown in full file excerpts. */
function slimExplainPayload(enriched: Awaited<ReturnType<typeof enrichSelectionContext>>) {
  return {
    workspace: { rootPath: enriched.workspace.rootPath, id: enriched.workspace.id },
    target: enriched.context.target,
    definitions: enriched.context.definitions.slice(0, 6).map(slimSource),
    references: enriched.context.references.slice(0, 10).map(slimSource),
    explanation: {
      summary: enriched.explanation.summary,
      structure: enriched.explanation.howItWorks,
      confidence: enriched.explanation.confidence,
      sources: (enriched.explanation.sources ?? []).slice(0, 8).map(slimSource)
    }
  };
}

export async function runExplainSelectionTool(request: ToolRequest): Promise<ToolEnvelope<unknown>> {
  const deterministic = await buildSelectionContext({
    rootPath: request.rootPath,
    filePath: request.filePath,
    line: request.line,
    selectedText: request.selectedText
  });

  const enriched = await enrichSelectionContext(deterministic, {
    enabled: request.enrich,
    provider: request.provider,
    trustProviderConfig: request.trustProviderConfig === true
  });

  return toolSuccess("explain-selection", slimExplainPayload(enriched), {
    metadata: enriched.metadata,
    enrichment: enriched.enrichment as ToolEnrichmentMetadata
  });
}

export async function runFindDefinitionTool(request: ToolRequest): Promise<ToolEnvelope<unknown>> {
  const items = await findDefinition(request);
  return toolSuccess("find-definition", {
    items: items.slice(0, 8).map((item) => ({
      file: item.file,
      line: item.line,
      kind: item.kind,
      score: item.score,
      excerpt: item.excerpt ? item.excerpt.trim().slice(0, 160) : undefined
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
      score: item.score,
      excerpt: item.excerpt ? item.excerpt.trim().slice(0, 160) : undefined
    }))
  });
}

export async function runLogicalSectionTool(request: ToolRequest): Promise<ToolEnvelope<unknown>> {
  const section = await getLogicalSection(request);
  return toolSuccess("logical-section", { section }, { metadata: logicalSectionMetadata(section.confidence) });
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
