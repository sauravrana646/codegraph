export type WorkspaceId = string;
export type WorkspaceRelativePath = string;

export interface Position {
  line: number;
  column: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export type CapabilityTier = 0 | 1 | 2 | 3 | 4;

export type ResolutionSource = "ide_lsp" | "standalone_lsp" | "ast" | "text";

export interface ResolutionMetadata {
  source: ResolutionSource;
  capabilityTier: CapabilityTier;
  confidence: number;
}

export interface WorkspaceSummary {
  id: WorkspaceId;
  rootPath: string;
  name: string;
}

export interface TargetContext {
  workspaceId: WorkspaceId;
  file: WorkspaceRelativePath;
  range?: Range;
  line?: number;
  selectedText?: string;
}

export type ReferenceKind = "definition" | "call" | "attribute" | "import" | "mention";

export interface SourceReference {
  file: WorkspaceRelativePath;
  line: number;
  column?: number;
  excerpt?: string;
  kind?: ReferenceKind;
  score?: number;
}

export type LogicalSectionDepth = "statement" | "function" | "class" | "auto";

/** Narrative detail for Live Explain / Agent handoff / API enrichment. */
export type ExplainDepth = "short" | "standard" | "deep";

export interface FlowStep {
  title: string;
  detail: string;
  source?: SourceReference;
}

export interface Example {
  title: string;
  description: string;
  source?: SourceReference;
}

export interface InferredClaim {
  claim: string;
  confidence: "low" | "medium" | "high";
  evidence: SourceReference[];
}

export type ExplanationConfidence = "low" | "medium" | "high";

export interface Explanation {
  summary: string;
  whatItDoes?: string;
  howItWorks?: string;
  whyItExists?: string;
  codebaseUsage?: string;
  executionFlow?: FlowStep[];
  examples?: Example[];
  relatedCode?: SourceReference[];
  caveats?: string[];
  confidence: ExplanationConfidence;
  sources: SourceReference[];
  inferredClaims?: InferredClaim[];
}

export interface FileRecord {
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  contentHash: string;
  mtimeMs: number;
  size: number;
  language?: string;
}

export interface ContextBundle {
  workspace: WorkspaceSummary;
  target: TargetContext;
  definitions: SourceReference[];
  references: SourceReference[];
  relatedFiles: SourceReference[];
  documentation: SourceReference[];
  configuration: SourceReference[];
}

export type ToolName =
  | "explain-selection"
  | "find-definition"
  | "find-usages"
  | "logical-section"
  | "search-codebase"
  | "get-symbol-context"
  | "get-project-overview"
  | "trace-call-chain"
  | "ensure-index"
  | "sessions.explain-selection"
  | "sessions.followup"
  | "health";

export interface ToolEnrichmentMetadata {
  used: boolean;
  provider?: string;
  model?: string;
  error?: string;
}

export interface ToolSessionMetadata {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  ttlMs?: number;
  action?: string;
}

export interface ToolSuccessEnvelope<TData> {
  ok: true;
  tool: ToolName | string;
  data: TData;
  metadata?: ResolutionMetadata;
  enrichment?: ToolEnrichmentMetadata;
  session?: ToolSessionMetadata;
}

export interface ToolErrorEnvelope {
  ok: false;
  tool?: ToolName | string;
  error: {
    code: string;
    message: string;
  };
}

export type ToolEnvelope<TData> = ToolSuccessEnvelope<TData> | ToolErrorEnvelope;

/** @deprecated Prefer ToolSuccessEnvelope for API responses. */
export interface ToolResult<TData> {
  data: TData;
  metadata: ResolutionMetadata;
}

export function toolSuccess<TData>(
  tool: ToolName | string,
  data: TData,
  extras?: {
    metadata?: ResolutionMetadata;
    enrichment?: ToolEnrichmentMetadata;
    session?: ToolSessionMetadata;
  }
): ToolSuccessEnvelope<TData> {
  return {
    ok: true,
    tool,
    data,
    ...(extras?.metadata ? { metadata: extras.metadata } : {}),
    ...(extras?.enrichment ? { enrichment: extras.enrichment } : {}),
    ...(extras?.session ? { session: extras.session } : {})
  };
}

export function toolError(
  code: string,
  message: string,
  tool?: ToolName | string
): ToolErrorEnvelope {
  return {
    ok: false,
    ...(tool ? { tool } : {}),
    error: { code, message }
  };
}
