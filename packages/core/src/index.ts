import fs from "node:fs/promises";
import path from "node:path";

import type { ContextBundle, ResolutionMetadata, SourceReference, TargetContext, WorkspaceSummary } from "@codegraph/protocol";
import { redactSecrets } from "@codegraph/security";
import { createWorkspaceSummary, normalizeWorkspacePath } from "@codegraph/workspace";

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

function languageFromFile(filePath: string): string | undefined {
  if (filePath.endsWith(".py")) {
    return "python";
  }

  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
    return "typescript";
  }

  if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) {
    return "javascript";
  }

  return undefined;
}

function buildExcerpt(lines: string[], lineNumber: number): string {
  const startLine = Math.max(0, lineNumber - 3);
  const endLine = Math.min(lines.length, lineNumber + 2);

  return lines.slice(startLine, endLine).join("\n");
}

function createSourceReference(file: string, line: number, excerpt: string): SourceReference {
  return { file, line, excerpt };
}

export async function buildSelectionContext(request: ExplainSelectionRequest): Promise<SelectionContextResult> {
  const workspace = createWorkspaceSummary(request.rootPath);
  const absoluteFilePath = normalizeWorkspacePath(workspace.rootPath, request.filePath);
  const file = path.relative(workspace.rootPath, absoluteFilePath);
  const content = await fs.readFile(absoluteFilePath, "utf8");
  const lines = content.split(/\r?\n/);
  const excerpt = redactSecrets(buildExcerpt(lines, request.line));

  const target: TargetContext = {
    workspaceId: workspace.id,
    file,
    line: request.line,
    selectedText: request.selectedText
  };

  return {
    workspace,
    context: {
      workspace,
      target,
      definitions: [createSourceReference(file, request.line, excerpt)],
      references: [],
      relatedFiles: [],
      documentation: [],
      configuration: []
    },
    metadata: {
      source: "text",
      capabilityTier: languageFromFile(file) === "python" ? 1 : 0,
      confidence: request.selectedText ? 0.55 : 0.35
    }
  };
}
