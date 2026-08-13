import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parsePythonFile, type PythonAstImport, type PythonAstSymbol } from "@codegraph/language-intelligence";
import { readContainedFile } from "@codegraph/security";
import { createWorkspaceId } from "@codegraph/workspace";

import { attachCallGraph, neighborhoodLinesForPointer, resolvePythonModuleFiles } from "./graph";
import { INDEX_VERSION, type IndexedFile, type IndexedImport, type IndexedSymbol, type WorkspaceIndex } from "./types";

export { INDEX_VERSION } from "./types";
export type {
  CallResolveVia,
  GraphEdge,
  IndexedCallSite,
  IndexedFile,
  IndexedImport,
  IndexedSymbol,
  SymbolNeighborhood,
  WorkspaceIndex
} from "./types";
export {
  attachCallGraph,
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

export interface IndexUpdateResult {
  index: WorkspaceIndex;
  changed: number;
  removed: number;
  unchanged: number;
  total: number;
  storagePath: string;
}

function normalizeRel(file: string): string {
  return file.replace(/\\/g, "/");
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
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) {
      if (entry.name !== "." && entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
        continue;
      }
      if (entry.isDirectory() && (SKIP_DIRS.has(entry.name) || entry.name.startsWith("."))) {
        continue;
      }
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
    signature: symbol.signature,
    docstring: symbol.docstring ?? undefined,
    calls: (symbol.calls ?? [])
      .filter((call) => call.name && call.line)
      .map((call) => ({ name: call.name, line: call.line })),
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

async function loadIndex(storagePath: string, rootPath: string): Promise<WorkspaceIndex | undefined> {
  try {
    const raw = await fsp.readFile(storagePath, "utf8");
    return parseIndexPayload(raw, rootPath);
  } catch {
    return undefined;
  }
}

export function readWorkspaceIndexSync(rootPath: string): WorkspaceIndex | undefined {
  try {
    const raw = fs.readFileSync(indexStoragePath(rootPath), "utf8");
    return parseIndexPayload(raw, rootPath);
  } catch {
    return undefined;
  }
}

async function saveIndex(storagePath: string, index: WorkspaceIndex): Promise<void> {
  attachCallGraph(index);
  await fsp.mkdir(path.dirname(storagePath), { recursive: true });
  const tmp = `${storagePath}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(index)}\n`, "utf8");
  await fsp.rename(tmp, storagePath);
}

async function indexOneFile(rootPath: string, relativePath: string): Promise<IndexedFile | undefined> {
  try {
    const contained = await readContainedFile(rootPath, relativePath);
    const stat = await fsp.stat(contained.absolutePath);
    if (stat.size > MAX_INDEX_FILE_BYTES) {
      return undefined;
    }
    const parsed = await parsePythonFile(contained.absolutePath, contained.content);
    return {
      relativePath: normalizeRel(contained.relativePath),
      contentHash: hashContent(contained.content),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      symbols: toIndexedSymbols(parsed.symbols),
      imports: toIndexedImports(parsed.imports)
    };
  } catch {
    return undefined;
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

export async function ensureWorkspaceIndex(
  rootPath: string,
  options?: { force?: boolean }
): Promise<IndexUpdateResult> {
  const resolved = path.resolve(rootPath);
  const storagePath = indexStoragePath(resolved);
  const previous = options?.force ? undefined : await loadIndex(storagePath, resolved);
  const listed = (await walkPythonFiles(resolved)).slice(0, MAX_INDEXED_PYTHON_FILES);
  const files: Record<string, IndexedFile> = {};
  const stale = previous?.files ?? {};
  const toParse: string[] = [];
  let unchanged = 0;

  for (const relativePath of listed) {
    const existing = stale[relativePath];
    if (!existing) {
      toParse.push(relativePath);
      continue;
    }
    try {
      const contained = await readContainedFile(resolved, relativePath);
      const stat = await fsp.stat(contained.absolutePath);
      const hash = hashContent(contained.content);
      if (existing.contentHash === hash && Math.abs(existing.mtimeMs - stat.mtimeMs) < 2) {
        files[relativePath] = existing;
        unchanged += 1;
        continue;
      }
    } catch {
      // fall through to reparse
    }
    toParse.push(relativePath);
  }

  const parsed = await mapPool(toParse, 6, (file) => indexOneFile(resolved, file));
  let changed = 0;
  for (const item of parsed) {
    if (!item) {
      continue;
    }
    files[item.relativePath] = item;
    changed += 1;
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
  return {
    index,
    changed,
    removed,
    unchanged,
    total: Object.keys(files).length,
    storagePath
  };
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

  for (const raw of relativePaths) {
    const relativePath = normalizeRel(raw);
    if (!relativePath.endsWith(".py")) {
      continue;
    }
    const indexed = await indexOneFile(resolved, relativePath);
    if (!indexed) {
      if (files[relativePath]) {
        delete files[relativePath];
        removed += 1;
      }
      continue;
    }
    files[relativePath] = indexed;
    changed += 1;
  }

  const index: WorkspaceIndex = {
    ...previous,
    files,
    updatedAt: Date.now()
  };
  await saveIndex(storagePath, index);
  return {
    index,
    changed,
    removed,
    unchanged: Object.keys(files).length - changed,
    total: Object.keys(files).length,
    storagePath
  };
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
  return neighborhoodLinesForPointer(readWorkspaceIndexSync(rootPath), filePath, line, selectedText);
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
