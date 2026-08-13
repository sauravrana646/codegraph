import {
  ensureWorkspaceIndex,
  filesImportingSymbol,
  findIndexedDefinitions,
  listIndexedFiles,
  lookupNeighborhood,
  readWorkspaceIndex,
  resolvePythonModuleFiles,
  type GraphEdge,
  type IndexedSymbol,
  type IndexUpdateResult,
  type WorkspaceIndex
} from "@codegraph/indexer";
import type { SourceReference } from "@codegraph/protocol";
import { redactSecrets, readContainedFile } from "@codegraph/security";
import { rememberSession, type UnderstandingSession } from "@codegraph/sessions";
import { createWorkspaceId } from "@codegraph/workspace";

export interface ProjectOverview {
  pythonFileCount: number;
  symbolCount: number;
  classCount: number;
  functionCount: number;
  topLevelPackages: string[];
  entrypoints: string[];
  notableSymbols: Array<{ file: string; line: number; name: string; kind: string }>;
}

export interface CodeSearchHit {
  file: string;
  line: number;
  name: string;
  kind: string;
  score: number;
}

export interface SymbolContext {
  symbol: string;
  definitions: SourceReference[];
  references: SourceReference[];
  relatedFiles: SourceReference[];
  callers: SourceReference[];
  callees: SourceReference[];
}

export interface CallChainHop {
  file: string;
  line: number;
  kind: string;
  excerpt?: string;
}

function normalizeRel(file: string): string {
  return file.replace(/\\/g, "/");
}

function excerptLine(content: string, line: number): string {
  const lines = content.split(/\r?\n/);
  return redactSecrets(lines[Math.max(0, line - 1)] ?? "");
}

export async function getOrBuildIndex(rootPath: string, force = false): Promise<IndexUpdateResult> {
  return ensureWorkspaceIndex(rootPath, { force });
}

export async function requireIndex(rootPath: string): Promise<WorkspaceIndex> {
  const existing = await readWorkspaceIndex(rootPath);
  if (existing && Object.keys(existing.files).length > 0) {
    return existing;
  }
  const updated = await ensureWorkspaceIndex(rootPath);
  return updated.index;
}

export function buildProjectOverview(index: WorkspaceIndex): ProjectOverview {
  const files = listIndexedFiles(index);
  const packages = new Set<string>();
  let classCount = 0;
  let functionCount = 0;
  const notable: ProjectOverview["notableSymbols"] = [];

  for (const file of files) {
    const top = normalizeRel(file.relativePath).split("/")[0];
    if (top && !top.startsWith(".") && top.endsWith(".py") === false) {
      packages.add(top);
    }
    for (const symbol of file.symbols) {
      if (symbol.name === "<module>") {
        continue;
      }
      if (symbol.kind === "class") {
        classCount += 1;
      } else {
        functionCount += 1;
      }
      if (symbol.kind === "class" || symbol.line <= 80) {
        notable.push({
          file: file.relativePath,
          line: symbol.line,
          name: symbol.name,
          kind: symbol.kind
        });
      }
    }
  }

  const entrypointHints = new Set([
    "main.py",
    "app.py",
    "manage.py",
    "wsgi.py",
    "asgi.py",
    "__main__.py",
    "cli.py",
    "server.py"
  ]);
  const entrypoints = files
    .map((file) => normalizeRel(file.relativePath))
    .filter((file) => {
      const base = file.split("/").pop() ?? "";
      return entrypointHints.has(base);
    })
    .slice(0, 12);

  return {
    pythonFileCount: files.length,
    symbolCount: classCount + functionCount,
    classCount,
    functionCount,
    topLevelPackages: [...packages].sort().slice(0, 16),
    entrypoints,
    notableSymbols: notable
      .sort((left, right) => (left.kind === "class" ? 0 : 1) - (right.kind === "class" ? 0 : 1))
      .slice(0, 24)
  };
}

export function searchIndexedSymbols(index: WorkspaceIndex, query: string, limit = 20): CodeSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) {
    return [];
  }
  const hits: CodeSearchHit[] = [];
  for (const file of listIndexedFiles(index)) {
    const fileScore = normalizeRel(file.relativePath).toLowerCase().includes(needle) ? 8 : 0;
    for (const symbol of file.symbols) {
      if (symbol.name === "<module>") {
        continue;
      }
      const name = symbol.name.toLowerCase();
      let score = fileScore;
      if (name === needle) {
        score += 100;
      } else if (name.startsWith(needle)) {
        score += 70;
      } else if (name.includes(needle)) {
        score += 40;
      } else {
        continue;
      }
      if (symbol.kind === "class") {
        score += 5;
      }
      hits.push({
        file: file.relativePath,
        line: symbol.line,
        name: symbol.name,
        kind: symbol.kind,
        score
      });
    }
  }
  return hits.sort((left, right) => right.score - left.score).slice(0, limit);
}

export function preferImportedDefinitions(
  index: WorkspaceIndex,
  originFile: string,
  symbolName: string
): Array<IndexedSymbol & { file: string }> {
  const origin = index.files[normalizeRel(originFile)];
  const all = findIndexedDefinitions(index, symbolName, originFile);
  if (!origin || all.length <= 1) {
    return all;
  }

  const importedFiles = new Set<string>();
  for (const item of origin.imports) {
    if (!item.names.includes(symbolName) && item.alias !== symbolName && !item.names.includes("*")) {
      continue;
    }
    for (const resolved of resolvePythonModuleFiles(index, originFile, item.module)) {
      importedFiles.add(resolved);
    }
  }

  const imported = all.filter((item) => importedFiles.has(item.file));
  if (imported.length > 0) {
    return imported;
  }
  const local = all.filter((item) => item.file === normalizeRel(originFile));
  return local.length > 0 ? local : all;
}

export async function collectImportScopedUsages(
  rootPath: string,
  index: WorkspaceIndex,
  symbolName: string,
  definitionFiles: string[],
  originFile: string,
  limit = 12
): Promise<SourceReference[]> {
  const candidates = filesImportingSymbol(index, symbolName, definitionFiles);
  if (!candidates.includes(normalizeRel(originFile))) {
    candidates.unshift(normalizeRel(originFile));
  }

  const defKeys = new Set(definitionFiles.map((file) => `${normalizeRel(file)}`));
  const pattern = new RegExp(`\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const refs: SourceReference[] = [];

  for (const file of candidates.slice(0, 40)) {
    let content: string;
    try {
      content = (await readContainedFile(rootPath, file)).content;
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let indexLine = 0; indexLine < lines.length; indexLine += 1) {
      const line = lines[indexLine] ?? "";
      if (!pattern.test(line) || /^\s*#/.test(line)) {
        continue;
      }
      if (/^\s*(?:async\s+)?(?:def|class)\s+/.test(line) && defKeys.has(file)) {
        continue;
      }
      const lineNumber = indexLine + 1;
      let kind: SourceReference["kind"] = "mention";
      if (new RegExp(`\\b(?:from\\s+\\S+\\s+import\\s+.*\\b${symbolName}\\b|import\\s+.*\\b${symbolName}\\b)`).test(line)) {
        kind = "import";
      } else if (new RegExp(`\\b${symbolName}\\s*\\(`).test(line)) {
        kind = "call";
      } else if (new RegExp(`\\.${symbolName}\\b|\\b${symbolName}\\.`).test(line)) {
        kind = "attribute";
      }
      const score = (kind === "call" ? 100 : kind === "import" ? 70 : kind === "attribute" ? 80 : 30) +
        (file === normalizeRel(originFile) ? 5 : 0);
      refs.push({
        file,
        line: lineNumber,
        excerpt: redactSecrets(line.trim()),
        kind,
        score
      });
    }
  }

  const seen = new Set<string>();
  const strong = refs.filter((item) => item.kind !== "mention");
  const pool = strong.length > 0 ? strong : refs;
  return pool
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .filter((item) => {
      const key = `${item.file}:${item.line}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

export function rankRelatedFiles(
  definitions: SourceReference[],
  references: SourceReference[],
  limit = 8
): SourceReference[] {
  const seen = new Set<string>();
  const ranked: SourceReference[] = [];
  for (const item of [...definitions, ...references].sort((left, right) => (right.score ?? 0) - (left.score ?? 0))) {
    if (seen.has(item.file)) {
      continue;
    }
    seen.add(item.file);
    ranked.push(item);
    if (ranked.length >= limit) {
      break;
    }
  }
  return ranked;
}

function edgeToRef(edge: GraphEdge, kind: SourceReference["kind"]): SourceReference {
  return {
    file: edge.file,
    line: edge.line,
    kind,
    score: Math.round(edge.confidence * 100)
  };
}

export async function buildSymbolContext(input: {
  rootPath: string;
  filePath: string;
  line: number;
  symbolName: string;
}): Promise<SymbolContext> {
  const index = await requireIndex(input.rootPath);
  const neighborhood = lookupNeighborhood(index, input.filePath, input.line, input.symbolName);
  if (
    neighborhood &&
    (neighborhood.callers.length > 0 ||
      neighborhood.callees.length > 0 ||
      neighborhood.definitions.length > 0)
  ) {
    const callers = neighborhood.callers.map((edge) => edgeToRef(edge, "call"));
    const callees = neighborhood.callees.map((edge) => edgeToRef(edge, "call"));
    const definitions = neighborhood.definitions.map((edge) => edgeToRef(edge, "definition"));
    return {
      symbol: neighborhood.symbol,
      definitions,
      references: [...callers, ...callees],
      relatedFiles: neighborhood.related.map((edge) => edgeToRef(edge, "mention")),
      callers,
      callees
    };
  }

  const defs = preferImportedDefinitions(index, input.filePath, input.symbolName);
  const definitions: SourceReference[] = defs.map((item) => ({
    file: item.file,
    line: item.line,
    kind: "definition",
    score: 100
  }));
  const definitionFiles = defs.map((item) => item.file);
  const references = await collectImportScopedUsages(
    input.rootPath,
    index,
    input.symbolName,
    definitionFiles.length ? definitionFiles : [input.filePath],
    input.filePath
  );
  const callers = references.filter((item) => item.kind === "call");
  return {
    symbol: input.symbolName,
    definitions,
    references,
    relatedFiles: rankRelatedFiles(definitions, references),
    callers,
    callees: []
  };
}

export async function traceCallChain(input: {
  rootPath: string;
  filePath: string;
  symbolName: string;
  line?: number;
}): Promise<CallChainHop[]> {
  const context = await buildSymbolContext({
    rootPath: input.rootPath,
    filePath: input.filePath,
    line: input.line ?? 1,
    symbolName: input.symbolName
  });
  return context.callers.slice(0, 12).map((item) => ({
    file: item.file,
    line: item.line,
    kind: item.kind ?? "call",
    excerpt: item.excerpt
  }));
}

export async function persistUnderstandingSession(input: {
  rootPath: string;
  filePath: string;
  line: number;
  selectedText?: string;
  symbol?: string;
  definitionFiles: string[];
  usageFiles: string[];
}): Promise<UnderstandingSession> {
  return rememberSession({
    sessionId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: createWorkspaceId(input.rootPath),
    rootPath: input.rootPath,
    filePath: input.filePath,
    line: input.line,
    selectedText: input.selectedText,
    symbol: input.symbol,
    definitionFiles: input.definitionFiles,
    usageFiles: input.usageFiles,
    updatedAt: Date.now()
  });
}
