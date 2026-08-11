import type { ContextBundle, ResolutionMetadata, WorkspaceSummary } from "@codegraph/protocol";
export interface ExplainSelectionRequest {
    rootPath: string;
    filePath: string;
    line: number;
    selectedText?: string;
}
export interface SelectionContextResult {
    workspace: WorkspaceSummary;
    context: ContextBundle;
    metadata: ResolutionMetadata;
}
export declare function buildSelectionContext(request: ExplainSelectionRequest): Promise<SelectionContextResult>;
//# sourceMappingURL=index.d.ts.map