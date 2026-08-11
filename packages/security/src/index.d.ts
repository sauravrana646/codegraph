import type { WorkspaceRelativePath } from "@codegraph/protocol";
export interface SecretMatch {
    kind: "token" | "password" | "private_key" | "connection_string";
    match: string;
    start: number;
    end: number;
}
export declare function scanForSecrets(content: string): SecretMatch[];
export declare function redactSecrets(content: string): string;
export declare function assertSymlinkContained(rootPath: string, inputPath: string): Promise<WorkspaceRelativePath>;
//# sourceMappingURL=index.d.ts.map