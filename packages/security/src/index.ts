import fs from "node:fs/promises";
import path from "node:path";

import type { WorkspaceRelativePath } from "@codegraph/protocol";
import { normalizeWorkspacePath, toWorkspaceRelativePath } from "@codegraph/workspace";

export interface SecretMatch {
  kind: "token" | "password" | "private_key" | "connection_string";
  match: string;
  start: number;
  end: number;
}

const SECRET_PATTERNS: Array<{ kind: SecretMatch["kind"]; pattern: RegExp }> = [
  { kind: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: "token", pattern: /\b(?:ghp|sk|api[_-]?key)[a-z0-9_\-]{8,}\b/gi },
  { kind: "password", pattern: /\bpassword\s*=\s*["'][^"']+["']/gi },
  { kind: "connection_string", pattern: /\b(?:postgres|mysql|mongodb):\/\/[^\s"'`]+/gi }
];

export function scanForSecrets(content: string): SecretMatch[] {
  const matches: SecretMatch[] = [];

  for (const { kind, pattern } of SECRET_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      if (match.index === undefined) {
        continue;
      }

      matches.push({
        kind,
        match: match[0],
        start: match.index,
        end: match.index + match[0].length
      });
    }
  }

  return matches.sort((left, right) => left.start - right.start);
}

export function redactSecrets(content: string): string {
  let redacted = content;

  for (const match of scanForSecrets(content).reverse()) {
    redacted = `${redacted.slice(0, match.start)}[REDACTED:${match.kind}]${redacted.slice(match.end)}`;
  }

  return redacted;
}

export async function assertSymlinkContained(rootPath: string, inputPath: string): Promise<WorkspaceRelativePath> {
  const normalizedRoot = path.resolve(rootPath);
  const resolvedPath = normalizeWorkspacePath(normalizedRoot, inputPath);
  const realPath = await fs.realpath(resolvedPath).catch(() => resolvedPath);
  const relativeToRoot = path.relative(normalizedRoot, realPath);

  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error(`Symlink escapes workspace root: ${inputPath}`);
  }

  return toWorkspaceRelativePath(normalizedRoot, resolvedPath);
}
