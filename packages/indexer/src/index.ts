import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parsePythonFile, pythonParserUnavailable, type PythonAstImport, type PythonAstSymbol } from "@codegraph/language-intelligence";
import { FileTooLargeError, readContainedFile, redactSecrets } from "@codegraph/security";
import { createWorkspaceId } from "@codegraph/workspace";

import { attachCallGraph, neighborhoodLinesForPointer, resolvePythonModuleFiles } from "./graph";
import {
  INDEX_VERSION,
  type IndexedFile,
  type IndexedImport,
  type IndexedSymbol,
  type ParseSource,
  type WorkspaceIndex
} from "./types";

export { INDEX_VERSION } from "./types";
export type {
  CallResolveVia,
  GraphEdge,
  IndexedCallSite,
  IndexedFile,
  IndexedImport,
  IndexedSymbol,
  ParseSource,
  SymbolNeighborhood,
  WorkspaceIndex
} from "./types";
export {
  attachCallGraph,
  displaySymbolName,
  findIndexedDefinitions,
  formatNeighborhoodLines,
  lookupNeighborhood,
  neighborhoodLinesForPointer,
  resolvePythonModuleFiles
} from "./graph";

export const MAX_INDEXED_PYTHON_FILES = 2000;
export const MAX_INDEX_FILE_BYTES = 1_500_000;

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "env",
  "node_modules",
  "dist",
  "build",
  "out",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".ruff_cache",
  ".pytest_cache",
  ".codegraph",
  ".cursor",
  "site-packages",
  ".eggs",
  ".idea"
]);

const indexMemoryCache = new Map<string, WorkspaceIndex>();

export interface IndexUpdateResult {
  index: WorkspaceIndex;
  changed: number;
  removed: number;
  unchanged: number;
  total: number;
  skipped: number;
  failed: number;
  parseAst: number;
  parseRegex: number;
  astUnavailable: boolean;
  storagePath: string;
}

function normalizeRel(file: string): string {
  return file.replace(/\\/g, "/");
}

function cacheKey(rootPath: string): string {
  return path.resolve(rootPath);
}

export function getCachedWorkspaceIndex(rootPath: string): WorkspaceIndex | undefined {
  return indexMemoryCache.get(cacheKey(rootPath));
}

export function setCachedWorkspaceIndex(rootPath: string, index: WorkspaceIndex): void {
  indexMemoryCache.set(cacheKey(rootPath), index);
}

export function indexStorageDir(rootPath: string): string {
  const id = createWorkspaceId(path.resolve(rootPath));
  return path.join(os.homedir(), ".cursor", "codegraph", "indexes", id);
}

export function indexStoragePath(rootPath: string): string {
  return path.join(indexStorageDir(rootPath), "index.json");
}

async function walkPythonFiles(rootPath: string, currentDir = rootPath): Promise<string[]> {
  const entries = await fsp.readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && (SKIP_DIRS.has(entry.name) || entry.name.startsWith("."))) {
      continue;
    }

    if (entry.isSymbolicLink()) {
      continue;
    }

    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkPythonFiles(rootPath, absolutePath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".py")) {
      files.push(normalizeRel(path.relative(rootPath, absolutePath)));
    }
  }

  return files;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function toIndexedSymbols(symbols: PythonAstSymbol[]): IndexedSymbol[] {
  return symbols.map((symbol) => ({
    name: symbol.name,
    kind: symbol.kind,
    line: symbol.line,
    endLine: symbol.endLine,
    bases: symbol.bases ?? [],
    members: (symbol.members ?? []).map((member) => member.name),
    parentName: symbol.parentName ?? undefined,
    signature: symbol.signature ? redactSecrets(symbol.signature) : undefined,
    docstring: symbol.docstring ? redactSecrets(symbol.docstring) : undefined,
    calls: (symbol.calls ?? [])
      .filter((call) => call.name && call.line)
      .map((call) => ({
        name: call.name,
        line: call.line,
        ...(call.receiver ? { receiver: call.receiver } : {})
      })),
    callees: [],
    callers: []
  }));
}

function toIndexedImports(imports: PythonAstImport[]): IndexedImport[] {
  return imports.map((item) => ({
    kind: item.kind,
    module: item.module,
    names: item.names,
    alias: item.alias ?? null,
    line: item.line
  }));
}

function parseIndexPayload(raw: string, rootPath: string): WorkspaceIndex | undefined {
  const parsed = JSON.parse(raw) as WorkspaceIndex;
  if (parsed.version !== INDEX_VERSION || parsed.rootPath !== path.resolve(rootPath)) {
    return undefined;
  }
  return parsed;
}

function rememberIndex(index: WorkspaceIndex): void {
  setCachedWorkspaceIndex(index.rootPath, index);
}

async function loadIndex(storagePath: string, rootPath: string): Promise<WorkspaceIndex | undefined> {
  try {
    const raw = await fsp.readFile(storagePath, "utf8");
    const parsed = parseIndexPayload(raw, rootPath);
    if (parsed) {
      rememberIndex(parsed);
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function readWorkspaceIndexSync(rootPath: string): WorkspaceIndex | undefined {
  const cached = getCachedWorkspaceIndex(rootPath);
  if (cached) {
    return cached;
  }
  try {
    const raw = fs.readFileSync(indexStoragePath(rootPath), "utf8");
    const parsed = parseIndexPayload(raw, rootPath);
    if (parsed) {
      rememberIndex(parsed);
    }
    return parsed;
  } catch {
    return undefined;
  }
}

async function saveIndex(storagePath: string, index: WorkspaceIndex): Promise<void> {
  attachCallGraph(index);
  rememberIndex(index);
  await fsp.mkdir(path.dirname(storagePath), { recursive: true });
  const tmp = `${storagePath}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(index)}\n`, "utf8");
  await fsp.rename(tmp, storagePath);
}

type IndexFileOutcome =
  | { status: "ok"; file: IndexedFile }
  | { status: "skipped" }
  | { status: "failed" };

async function indexOneFile(rootPath: string, relativePath: string): Promise<IndexFileOutcome> {
  try {
    const contained = await readContainedFile(rootPath, relativePath, { maxBytes: MAX_INDEX_FILE_BYTES });
    const stat = await fsp.stat(contained.absolutePath);
    const parsed = await parsePythonFile(contained.absolutePath, contained.content);
    return {
      status: "ok",
      file: {
        relativePath: normalizeRel(contained.relativePath),
        contentHash: hashContent(contained.content),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        parseSource: parsed.source,
        symbols: toIndexedSymbols(parsed.symbols),
        imports: toIndexedImports(parsed.imports)
      }
    };
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      return { status: "skipped" };
    }
    return { status: "failed" };
  }
}

async function mapPool<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const current = next;
      next += 1;
      const item = items[current];
      if (item === undefined) {
        continue;
      }
      results[current] = await mapper(item);
    }
  }

  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

function parseCounts(files: Record<string, IndexedFile>): { parseAst: number; parseRegex: number } {
  let parseAst = 0;
  let parseRegex = 0;
  for (const file of Object.values(files)) {
    const source: ParseSource = file.parseSource ?? "python_ast";
    if (source === "regex_fallback") {
      parseRegex += 1;
    } else {
      parseAst += 1;
    }
  }
  return { parseAst, parseRegex };
}

function toUpdateResult(
  index: WorkspaceIndex,
  storagePath: string,
  counts: { changed: number; removed: number; unchanged: number; skipped: number; failed: number }
): IndexUpdateResult {
  const parsed = parseCounts(index.files);
  return {
    index,
    changed: counts.changed,
    removed: counts.removed,
    unchanged: counts.unchanged,
    total: Object.keys(index.files).length,
    skipped: counts.skipped,
    failed: counts.failed,
    parseAst: parsed.parseAst,
    parseRegex: parsed.parseRegex,
    astUnavailable: pythonParserUnavailable(),
    storagePath
  };
}

export async function ensureWorkspaceIndex(
  rootPath: string,
  options?: { force?: boolean }
): Promise<IndexUpdateResult> {
  const resolved = path.resolve(rootPath);
  const storagePath = indexStoragePath(resolved);
  const previous = options?.force ? undefined : await loadIndex(storagePath, resolved);
  const allListed = await walkPythonFiles(resolved);
  const truncated = Math.max(0, allListed.length - MAX_INDEXED_PYTHON_FILES);
  const listed = allListed.slice(0, MAX_INDEXED_PYTHON_FILES);
  const files: Record<string, IndexedFile> = {};
  const stale = previous?.files ?? {};
  const toParse: string[] = [];
  let unchanged = 0;
  let skipped = truncated;
  let failed = 0;

  for (const relativePath of listed) {
    const existing = stale[relativePath];
    if (!existing) {
      toParse.push(relativePath);
      continue;
    }
    try {
      const contained = await readContainedFile(resolved, relativePath, { maxBytes: MAX_INDEX_FILE_BYTES });
      const stat = await fsp.stat(contained.absolutePath);
      const hash = hashContent(contained.content);
      if (existing.contentHash === hash && Math.abs(existing.mtimeMs - stat.mtimeMs) < 2) {
        files[relativePath] = existing;
        unchanged += 1;
        continue;
      }
    } catch (error) {
      if (error instanceof FileTooLargeError) {
        skipped += 1;
        continue;
      }
      // fall through to reparse
    }
    toParse.push(relativePath);
  }

  const parsed = await mapPool(toParse, 6, (file) => indexOneFile(resolved, file));
  let changed = 0;
  for (const item of parsed) {
    if (item.status === "ok") {
      files[item.file.relativePath] = item.file;
      changed += 1;
      continue;
    }
    if (item.status === "skipped") {
      skipped += 1;
      continue;
    }
    failed += 1;
  }

  const removed = Object.keys(stale).filter((file) => !files[file]).length;
  const index: WorkspaceIndex = {
    version: INDEX_VERSION,
    workspaceId: createWorkspaceId(resolved),
    rootPath: resolved,
    updatedAt: Date.now(),
    files
  };
  await saveIndex(storagePath, index);
  return toUpdateResult(index, storagePath, { changed, removed, unchanged, skipped, failed });
}

export async function reindexPaths(rootPath: string, relativePaths: string[]): Promise<IndexUpdateResult> {
  const resolved = path.resolve(rootPath);
  const storagePath = indexStoragePath(resolved);
  const previous =
    (await loadIndex(storagePath, resolved)) ??
    ({
      version: INDEX_VERSION,
      workspaceId: createWorkspaceId(resolved),
      rootPath: resolved,
      updatedAt: 0,
      files: {}
    } satisfies WorkspaceIndex);

  const files = { ...previous.files };
  let changed = 0;
  let removed = 0;
  let skipped = 0;
  let failed = 0;

  for (const raw of relativePaths) {
    const relativePath = normalizeRel(raw);
    if (!relativePath.endsWith(".py")) {
      continue;
    }
    const indexed = await indexOneFile(resolved, relativePath);
    if (indexed.status !== "ok") {
      if (files[relativePath]) {
        delete files[relativePath];
        removed += 1;
      }
      if (indexed.status === "skipped") {
        skipped += 1;
      } else {
        failed += 1;
      }
      continue;
    }
    files[relativePath] = indexed.file;
    changed += 1;
  }

  const index: WorkspaceIndex = {
    ...previous,
    files,
    updatedAt: Date.now()
  };
  await saveIndex(storagePath, index);
  return toUpdateResult(index, storagePath, {
    changed,
    removed,
    unchanged: Object.keys(files).length - changed,
    skipped,
    failed
  });
}

export async function readWorkspaceIndex(rootPath: string): Promise<WorkspaceIndex | undefined> {
  return loadIndex(indexStoragePath(rootPath), rootPath);
}

export function readNeighborhoodLines(
  rootPath: string,
  filePath: string,
  line: number,
  selectedText?: string
): string[] {
  return neighborhoodLinesForPointer(getCachedWorkspaceIndex(rootPath), filePath, line, selectedText);
}

export function listIndexedFiles(index: WorkspaceIndex): IndexedFile[] {
  return Object.values(index.files);
}

export function filesImportingSymbol(
  index: WorkspaceIndex,
  symbolName: string,
  definitionFiles: string[]
): string[] {
  const defSet = new Set(definitionFiles.map(normalizeRel));
  const matches: string[] = [];

  for (const file of Object.values(index.files)) {
    const rel = normalizeRel(file.relativePath);
    if (defSet.has(rel)) {
      matches.push(rel);
      continue;
    }
    const importsSymbol = file.imports.some((item) => {
      if (item.names.includes("*")) {
        const resolved = resolvePythonModuleFiles(index, rel, item.module);
        return resolved.some((candidate) => defSet.has(candidate));
      }
      if (!item.names.includes(symbolName) && item.alias !== symbolName) {
        return false;
      }
      const resolved = resolvePythonModuleFiles(index, rel, item.module);
      return resolved.length === 0 || resolved.some((candidate) => defSet.has(candidate));
    });
    if (importsSymbol) {
      matches.push(rel);
    }
  }

  return [...new Set(matches)];
}
