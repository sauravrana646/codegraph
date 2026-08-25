import type {
  ContextBundle,
  Explanation,
  ResolutionMetadata,
  WorkspaceSummary
} from "@codegraph/protocol";

export type { ContextBundle, Explanation };

export interface SelectionContextResultLike {
  workspace: WorkspaceSummary;
  context: ContextBundle;
  metadata: ResolutionMetadata;
  explanation: Explanation;
}
