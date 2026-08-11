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

export interface ToolResult<TData> {
  data: TData;
  metadata: ResolutionMetadata;
}
