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
  provider?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
}

function logicalSectionMetadata(confidence: number): ResolutionMetadata {
  return {
    source: "ast",
    capabilityTier: confidence >= 0.7 ? 2 : 1,
    confidence
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
    provider: request.provider
  });

  return toolSuccess(
    "explain-selection",
    {
      workspace: enriched.workspace,
      context: enriched.context,
      explanation: enriched.explanation
    },
    {
      metadata: enriched.metadata,
      enrichment: enriched.enrichment as ToolEnrichmentMetadata
    }
  );
}

export async function runFindDefinitionTool(request: ToolRequest): Promise<ToolEnvelope<unknown>> {
  const items = await findDefinition(request);
  return toolSuccess("find-definition", { items });
}

export async function runFindUsagesTool(request: ToolRequest): Promise<ToolEnvelope<unknown>> {
  const items = await findUsages(request);
  return toolSuccess("find-usages", { items });
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
