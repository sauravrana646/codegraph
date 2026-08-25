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

export class FileTooLargeError extends Error {
  readonly size: number;
  readonly maxBytes: number;

  constructor(size: number, maxBytes: number) {
    super(`File exceeds maxBytes (${size} > ${maxBytes})`);
    this.name = "FileTooLargeError";
    this.size = size;
    this.maxBytes = maxBytes;
  }
}

const SECRET_PATTERNS: Array<{ kind: SecretMatch["kind"]; pattern: RegExp }> = [
  // Full PEM / OpenSSH private key blocks
  {
    kind: "private_key",
    pattern: /-----BEGIN [A-Z0-9 \-]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 \-]*PRIVATE KEY-----/g
  },
  {
    kind: "private_key",
    pattern: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g
  },
  // Common cloud / SCM tokens
  { kind: "token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g },
  { kind: "token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: "token", pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { kind: "token", pattern: /\bsk-proj-[A-Za-z0-9_\-]{20,}\b/g },
  { kind: "token", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "token", pattern: /\bASIA[0-9A-Z]{16}\b/g },
  { kind: "token", pattern: /\b(?:aws)?_?(?:secret)?_?access_?key[_-]?(?:id)?\s*[=:]\s*["']?[A-Za-z0-9\/+=]{20,}["']?/gi },
  { kind: "token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "token", pattern: /\bBearer\s+[A-Za-z0-9\-._~+\/]+=*\b/gi },
  { kind: "token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "token", pattern: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token)\s*[=:]\s*["'][^"']{8,}["']/gi },
  { kind: "password", pattern: /\bpassword\s*=\s*["'][^"']+["']/gi },
  { kind: "connection_string", pattern: /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp):\/\/[^\s"'`]+/gi }
];

export function scanForSecrets(content: string): SecretMatch[] {
  const matches: SecretMatch[] = [];

  for (const { kind, pattern } of SECRET_PATTERNS) {
    // Reset lastIndex for global patterns reused across calls.
    pattern.lastIndex = 0;

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

  return matches.sort((left, right) => left.start - right.start || right.end - left.end);
}

export function redactSecrets(content: string): string {
  let redacted = content;
  const matches = scanForSecrets(content);

  // Apply longer matches first so nested/overlapping patterns redact fully.
  const ordered = [...matches].sort((left, right) => right.end - right.start - (left.end - left.start) || right.start - left.start);

  const used: Array<{ start: number; end: number }> = [];

  for (const match of ordered) {
    if (used.some((range) => match.start < range.end && match.end > range.start)) {
      continue;
    }

    used.push({ start: match.start, end: match.end });
  }

  for (const range of used.sort((left, right) => right.start - left.start)) {
    const kind = matches.find((item) => item.start === range.start && item.end === range.end)?.kind ?? "token";
    redacted = `${redacted.slice(0, range.start)}[REDACTED:${kind}]${redacted.slice(range.end)}`;
  }

  return redacted;
}

export async function resolveContainedRealPath(
  rootPath: string,
  inputPath: string
): Promise<{ relativePath: WorkspaceRelativePath; realPath: string }> {
  const normalizedRoot = path.resolve(rootPath);
  const realRoot = await fs.realpath(normalizedRoot).catch(() => normalizedRoot);
  const resolvedPath = normalizeWorkspacePath(normalizedRoot, inputPath);
  const realPath = await fs.realpath(resolvedPath).catch(async () => {
    // For missing leaf files, realpath the parent and append the basename.
    const parent = path.dirname(resolvedPath);
    const realParent = await fs.realpath(parent).catch(() => parent);
    return path.join(realParent, path.basename(resolvedPath));
  });

  const relativeToRoot = path.relative(realRoot, realPath);

  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error(`Symlink escapes workspace root: ${inputPath}`);
  }

  return {
    relativePath: toWorkspaceRelativePath(normalizedRoot, resolvedPath),
    realPath
  };
}

export async function assertSymlinkContained(rootPath: string, inputPath: string): Promise<WorkspaceRelativePath> {
  const contained = await resolveContainedRealPath(rootPath, inputPath);
  return contained.relativePath;
}

export async function readContainedFile(
  rootPath: string,
  inputPath: string,
  options?: { maxBytes?: number }
): Promise<{
  absolutePath: string;
  relativePath: WorkspaceRelativePath;
  content: string;
}> {
  const { relativePath, realPath } = await resolveContainedRealPath(rootPath, inputPath);

  if (options?.maxBytes !== undefined) {
    const stat = await fs.stat(realPath);
    if (stat.size > options.maxBytes) {
      throw new FileTooLargeError(stat.size, options.maxBytes);
    }
  }

  const content = await fs.readFile(realPath, "utf8");

  return { absolutePath: realPath, relativePath, content };
}
