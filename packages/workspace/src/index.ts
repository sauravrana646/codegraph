import { createHash } from "node:crypto";
import path from "node:path";

import type { WorkspaceId, WorkspaceSummary } from "@codegraph/protocol";

export interface WorkspaceRoot {
  id: WorkspaceId;
  path: string;
  name: string;
}

export function createWorkspaceId(rootPath: string): WorkspaceId {
  return createHash("sha256").update(path.resolve(rootPath)).digest("hex").slice(0, 16);
}

export function createWorkspaceSummary(rootPath: string): WorkspaceSummary {
  const normalizedRoot = path.resolve(rootPath);

  return {
    id: createWorkspaceId(normalizedRoot),
    rootPath: normalizedRoot,
    name: path.basename(normalizedRoot)
  };
}

export function normalizeWorkspacePath(rootPath: string, inputPath: string): string {
  const normalizedRoot = path.resolve(rootPath);
  const resolvedPath = path.resolve(normalizedRoot, inputPath);
  const relativePath = path.relative(normalizedRoot, resolvedPath);

  if (relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
    return resolvedPath;
  }

  throw new Error(`Path escapes workspace root: ${inputPath}`);
}

export function toWorkspaceRelativePath(rootPath: string, inputPath: string): string {
  const normalizedRoot = path.resolve(rootPath);
  const resolvedPath = normalizeWorkspacePath(normalizedRoot, inputPath);

  return path.relative(normalizedRoot, resolvedPath) || ".";
}
