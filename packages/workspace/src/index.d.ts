import type { WorkspaceId, WorkspaceSummary } from "@codegraph/protocol";
export interface WorkspaceRoot {
    id: WorkspaceId;
    path: string;
    name: string;
}
export declare function createWorkspaceId(rootPath: string): WorkspaceId;
export declare function createWorkspaceSummary(rootPath: string): WorkspaceSummary;
export declare function normalizeWorkspacePath(rootPath: string, inputPath: string): string;
export declare function toWorkspaceRelativePath(rootPath: string, inputPath: string): string;
//# sourceMappingURL=index.d.ts.map