import fs from "node:fs/promises";
import path from "node:path";

import { parsePythonFile, type PythonAstMember, type PythonAstSymbol } from "@codegraph/language-intelligence";
import {
  ensureWorkspaceIndex,
  reindexPaths,
  type IndexedSymbol,
  type WorkspaceIndex
} from "@codegraph/indexer";
import type {
  ContextBundle,
  Explanation,
  LogicalSectionDepth,
  ReferenceKind,
  ResolutionMetadata,
  SourceReference,
  TargetContext,
  WorkspaceSummary
} from "@codegraph/protocol";
import { redactSecrets, readContainedFile } from "@codegraph/security";
import { createWorkspaceSummary } from "@codegraph/workspace";

import {
  buildProjectOverview,
  collectImportScopedUsages,
  persistUnderstandingSession,
  preferImportedDefinitions,
  rankRelatedFiles
} from "./context";

export {
  buildProjectOverview,
  buildSymbolContext,
  getOrBuildIndex,
  searchIndexedSymbols,
  traceCallChain
} from "./context";
export { ensureWorkspaceIndex, reindexPaths } from "@codegraph/indexer";
export { loadSession } from "@codegraph/sessions";

export interface ExplainSelectionRequest {
  rootPath: string;
  filePath: string;
  line: number;
  selectedText?: string;
  depth?: LogicalSectionDepth;
}

type PythonSymbolKind = "function" | "class";

interface PythonSymbol {
  name: string;
  kind: PythonSymbolKind;
  file: string;
  line: number;
  endLine: number;
  indent: number;
  excerpt: string;
  bases: string[];
  decorators: string[];
  docstring?: string;
  members: PythonAstMember[];
}

interface WorkspacePythonAnalysis {
  symbols: PythonSymbol[];
  usedAst: boolean;
}

export interface SelectionContextResult {
  workspace: WorkspaceSummary;
  context: ContextBundle;
  metadata: ResolutionMetadata;
  explanation: Explanation;
}

export interface LogicalSectionResult {
  file: string;
  symbolName?: string;
  kind: PythonSymbolKind | "statement" | "text";
  depth: LogicalSectionDepth;
  startLine: number;
  endLine: number;
  excerpt: string;
  confidence: number;
}

interface SelectionAnalysis {
  workspace: WorkspaceSummary;
  file: string;
  lines: string[];
  selectedSymbol?: string;
  primaryDefinition?: PythonSymbol;
  workspacePythonFiles: Array<{ file: string; absolutePath: string; content: string }>;
  workspaceAnalysis: WorkspacePythonAnalysis;
  localSymbols: PythonSymbol[];
  containingScopes: PythonSymbol[];
  definitions: SourceReference[];
  references: SourceReference[];
  relatedFiles: SourceReference[];
  metadata: ResolutionMetadata;
}

const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
  "match",
  "case",
  "type"
]);

const MAX_DEFINITION_EXCERPT_LINES = 36;

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

function buildExcerpt(lines: string[], lineNumber: number, radius = 2): string {
  const startLine = Math.max(0, lineNumber - 1 - radius);
  const endLine = Math.min(lines.length, lineNumber + radius);

  return lines.slice(startLine, endLine).join("\n");
}

function buildSpanExcerpt(lines: string[], startLine: number, endLine: number, maxLines = MAX_DEFINITION_EXCERPT_LINES): string {
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, Math.max(startLine, endLine));
  const slice = lines.slice(start, end);

  if (slice.length <= maxLines) {
    return slice.join("\n");
  }

  return `${slice.slice(0, maxLines).join("\n")}\n# ... truncated (${end - start - maxLines} more lines)`;
}

function createSourceReference(
  file: string,
  line: number,
  excerpt: string,
  kind?: ReferenceKind,
  score?: number
): SourceReference {
  return { file, line, excerpt, kind, score };
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getLine(lines: string[], lineNumber: number): string {
  return lines[Math.max(0, lineNumber - 1)] ?? "";
}

function firstMeaningfulIdentifier(text: string): string | undefined {
  const defMatch = text.match(/(?:^|\n)\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  if (defMatch?.[1]) {
    return defMatch[1];
  }

  const tokens = text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return tokens.find((token) => !PYTHON_KEYWORDS.has(token));
}

function extractSymbolFromLine(line: string): string | undefined {
  return firstMeaningfulIdentifier(line);
}

function detectSelectedSymbol(lines: string[], lineNumber: number, selectedText?: string): string | undefined {
  if (selectedText?.trim()) {
    return firstMeaningfulIdentifier(selectedText);
  }

  return extractSymbolFromLine(getLine(lines, lineNumber));
}

function hydratePythonSymbols(file: string, content: string, symbols: PythonAstSymbol[]): PythonSymbol[] {
  const lines = content.split(/\r?\n/);

  return symbols.map((symbol) => ({
    name: symbol.name,
    kind: symbol.kind,
    file,
    line: symbol.line,
    endLine: symbol.endLine,
    indent: symbol.indent,
    bases: symbol.bases ?? [],
    decorators: symbol.decorators ?? [],
    docstring: symbol.docstring ?? undefined,
    members: symbol.members ?? [],
    excerpt: redactSecrets(buildSpanExcerpt(lines, symbol.line, symbol.endLine))
  }));
}

function findContainingPythonScopes(symbols: PythonSymbol[], lineNumber: number, file: string): PythonSymbol[] {
  return symbols
    .filter((symbol) => symbol.file === file && symbol.line <= lineNumber && symbol.endLine >= lineNumber)
    .sort((left, right) => left.line - right.line);
}

async function walkWorkspaceFiles(rootPath: string, currentDir = rootPath): Promise<string[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }

    // Skip symlink entries so workspace walks cannot escape via linked files/dirs.
    if (entry.isSymbolicLink()) {
      continue;
    }

    const absolutePath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkWorkspaceFiles(rootPath, absolutePath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    files.push(path.relative(rootPath, absolutePath));
  }

  return files;
}

async function readWorkspacePythonFiles(
  rootPath: string,
  preferRelativePath?: string
): Promise<Array<{ file: string; absolutePath: string; content: string }>> {
  const files = await walkWorkspaceFiles(rootPath);
  const pythonFiles = files.filter((file) => file.endsWith(".py"));
  const preferred = preferRelativePath?.replace(/\\/g, "/");
  const ordered = preferred
    ? [preferred, ...pythonFiles.filter((file) => file.replace(/\\/g, "/") !== preferred)].slice(0, 200)
    : pythonFiles.slice(0, 200);
  const unique = [...new Set(ordered)];
  const results: Array<{ file: string; absolutePath: string; content: string }> = [];

  for (const file of unique) {
    try {
      const contained = await readContainedFile(rootPath, file);
      results.push({
        file: contained.relativePath,
        absolutePath: contained.absolutePath,
        content: contained.content
      });
    } catch {
      // Skip files that fail containment checks.
    }
  }

  return results;
}

async function collectWorkspacePythonSymbols(
  files: Array<{ file: string; absolutePath: string; content: string }>
): Promise<WorkspacePythonAnalysis> {
  const allSymbols = await Promise.all(
    files.map(async ({ file, absolutePath, content }) => {
      const parseResult = await parsePythonFile(absolutePath, content);

      return {
        symbols: hydratePythonSymbols(file, content, parseResult.symbols),
        usedAst: parseResult.source === "python_ast"
      };
    })
  );

  return {
    symbols: allSymbols.flatMap((result) => result.symbols),
    usedAst: allSymbols.some((result) => result.usedAst)
  };
}

function findSymbolDefinitions(symbols: PythonSymbol[], symbolName: string, preferFile?: string): PythonSymbol[] {
  const matches = symbols.filter((symbol) => symbol.name === symbolName);
  if (!preferFile) {
    return matches;
  }

  return [
    ...matches.filter((symbol) => symbol.file === preferFile),
    ...matches.filter((symbol) => symbol.file !== preferFile)
  ];
}

function classifyReferenceKind(line: string, symbolName: string): ReferenceKind {
  const escaped = escapeForRegex(symbolName);

  if (new RegExp(`^\\s*(?:async\\s+)?(?:def|class)\\s+${escaped}\\b`).test(line)) {
    return "definition";
  }

  if (new RegExp(`\\b(?:from\\s+\\S+\\s+import\\s+.*\\b${escaped}\\b|import\\s+.*\\b${escaped}\\b)`).test(line)) {
    return "import";
  }

  if (new RegExp(`\\b${escaped}\\s*\\(`).test(line)) {
    return "call";
  }

  if (new RegExp(`\\.${escaped}\\b`).test(line) || new RegExp(`\\b${escaped}\\.`).test(line)) {
    return "attribute";
  }

  return "mention";
}

function scoreReference(kind: ReferenceKind, sameFile: boolean): number {
  const kindScore: Record<ReferenceKind, number> = {
    call: 100,
    attribute: 80,
    import: 60,
    mention: 40,
    definition: 10
  };

  return kindScore[kind] + (sameFile ? 5 : 0);
}

/** Names that text-grep into noise if used for Jump usages. */
const NOISE_SYMBOL_NAMES = new Set([
  "self",
  "cls",
  "args",
  "kwargs",
  "data",
  "value",
  "values",
  "item",
  "items",
  "key",
  "keys",
  "result",
  "results",
  "error",
  "errors",
  "msg",
  "message",
  "path",
  "name",
  "type",
  "id",
  "obj",
  "config",
  "options",
  "params",
  "status",
  "state",
  "count",
  "index",
  "line",
  "file",
  "text",
  "content"
]);

function findSymbolReferences(
  files: Array<{ file: string; content: string }>,
  symbolName: string,
  definitions: SourceReference[],
  originFile: string,
  limit = 8
): SourceReference[] {
  // Too-short / ultra-common names produce "random" Jump lines via text scan.
  if (symbolName.length < 3 || NOISE_SYMBOL_NAMES.has(symbolName)) {
    return [];
  }

  const pattern = new RegExp(`\\b${escapeForRegex(symbolName)}\\b`);
  const definitionKeys = new Set(definitions.map((definition) => `${definition.file}:${definition.line}`));
  const references: SourceReference[] = [];

  for (const { file, content } of files) {
    const lines = content.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const lineNumber = index + 1;
      const key = `${file}:${lineNumber}`;

      if (!pattern.test(line) || definitionKeys.has(key)) {
        continue;
      }

      const kind = classifyReferenceKind(line, symbolName);

      if (kind === "definition") {
        continue;
      }

      // Skip bare mentions when the line is only a comment/string-ish noise heuristic:
      // prefer structured refs (import / call / attribute) for Jump quality.
      if (kind === "mention" && /^\s*#/.test(line)) {
        continue;
      }

      references.push(
        createSourceReference(
          file,
          lineNumber,
          redactSecrets(buildExcerpt(lines, lineNumber)),
          kind,
          scoreReference(kind, file === originFile)
        )
      );
    }
  }

  const deduped = dedupeReferences(references).sort(
    (left, right) => (right.score ?? 0) - (left.score ?? 0)
  );
  const strong = deduped.filter(
    (item) => item.kind === "call" || item.kind === "import" || item.kind === "attribute"
  );
  // Prefer import/call/attribute. Fall back to a few mentions only if nothing stronger exists.
  if (strong.length > 0) {
    return strong.slice(0, limit);
  }
  return deduped.filter((item) => item.kind === "mention").slice(0, Math.min(3, limit));
}

function dedupeReferences(references: SourceReference[]): SourceReference[] {
  const seen = new Set<string>();

  return references.filter((reference) => {
    const key = `${reference.file}:${reference.line}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function detectStatementBlock(lines: string[], lineNumber: number): { startLine: number; endLine: number; excerpt: string } {
  const current = getLine(lines, lineNumber);
  const indentMatch = current.match(/^(\s*)/);
  const indent = indentMatch?.[1]?.length ?? 0;
  let startLine = lineNumber;
  let endLine = lineNumber;

  for (let index = lineNumber - 1; index >= 1; index -= 1) {
    const line = getLine(lines, index);

    if (!line.trim()) {
      continue;
    }

    const lineIndent = (line.match(/^(\s*)/)?.[1] ?? "").length;

    if (lineIndent < indent) {
      break;
    }

    if (lineIndent === indent) {
      startLine = index;
    }
  }

  for (let index = lineNumber + 1; index <= lines.length; index += 1) {
    const line = getLine(lines, index);

    if (!line.trim()) {
      endLine = index;
      continue;
    }

    const lineIndent = (line.match(/^(\s*)/)?.[1] ?? "").length;

    if (lineIndent < indent) {
      break;
    }

    endLine = index;
  }

  return {
    startLine,
    endLine,
    excerpt: redactSecrets(lines.slice(startLine - 1, endLine).join("\n"))
  };
}

function truncateBlock(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildNearbySourceWindow(lines: string[], lineNumber: number, radius = 12): string {
  const index = Math.max(0, lineNumber - 1);
  const start = Math.max(0, index - radius);
  const end = Math.min(lines.length, index + radius + 1);
  return lines
    .slice(start, end)
    .map((line, offset) => `${start + offset + 1}| ${line}`)
    .join("\n");
}

/**
 * Deterministic layer is context-only.
 * Narrative tutoring fields stay empty so LLM/Agent must produce the final explanation.
 * No AST/LSP structure dumps — only a short source window + file:line locations.
 */
function buildExplanation(
  file: string,
  line: number,
  symbolName: string | undefined,
  primary: PythonSymbol | undefined,
  definitions: SourceReference[],
  references: SourceReference[],
  sourceLines: string[]
): Explanation {
  const shortName = symbolName ?? primary?.name;
  const definitionText = definitions[0] ? `${definitions[0].file}:${definitions[0].line}` : `${file}:${line}`;

  return {
    summary: shortName ? `${shortName} @ ${definitionText}` : `${file}:${line}`,
    whatItDoes: "",
    howItWorks: buildNearbySourceWindow(sourceLines, primary?.line ?? line),
    whyItExists: "",
    codebaseUsage: references
      .slice(0, 12)
      .map((reference) => `- ${reference.file}:${reference.line}`)
      .join("\n"),
    caveats: [],
    confidence: primary || definitions.length > 0 ? (references.length > 0 ? "high" : "medium") : "low",
    sources: dedupeReferences([...definitions, ...references])
      .slice(0, 12)
      .map((item) => ({
        file: item.file,
        line: item.line,
        kind: item.kind,
        score: item.score,
        excerpt: item.excerpt ? truncateBlock(item.excerpt, 120) : undefined
      })),
    relatedCode: references.slice(0, 8).map((item) => ({
      file: item.file,
      line: item.line,
      kind: item.kind,
      score: item.score
    })),
    inferredClaims: []
  };
}

function resolvePrimaryDefinition(
  selectedSymbol: string | undefined,
  definitions: PythonSymbol[],
  containingScopes: PythonSymbol[],
  file: string,
  line: number
): PythonSymbol | undefined {
  if (!selectedSymbol) {
    return containingScopes[containingScopes.length - 1];
  }

  const onHeader = containingScopes.find(
    (scope) => scope.name === selectedSymbol && scope.file === file && scope.line === line
  );
  if (onHeader) {
    return onHeader;
  }

  const localMatch = definitions.find((symbol) => symbol.file === file && symbol.name === selectedSymbol);
  if (localMatch) {
    return localMatch;
  }

  return definitions[0] ?? containingScopes.find((scope) => scope.name === selectedSymbol);
}

async function analyzeSelection(request: ExplainSelectionRequest): Promise<SelectionAnalysis> {
  const workspace = createWorkspaceSummary(request.rootPath);
  const contained = await readContainedFile(workspace.rootPath, request.filePath);
  const file = contained.relativePath;
  const content = contained.content;
  const lines = content.split(/\r?\n/);
  const selectedSymbol = detectSelectedSymbol(lines, request.line, request.selectedText);
  const indexUpdate = await ensureWorkspaceIndex(workspace.rootPath);
  const index: WorkspaceIndex = indexUpdate.index;
  const indexedFile = index.files[file.replace(/\\/g, "/")];
  const usedAst = Boolean(indexedFile);
  const localIndexedSymbols = indexedFile?.symbols ?? [];
  const localSymbols: PythonSymbol[] = localIndexedSymbols.map((symbol: IndexedSymbol) => ({
    name: symbol.name,
    kind: symbol.kind,
    file,
    line: symbol.line,
    endLine: symbol.endLine,
    indent: 0,
    excerpt: redactSecrets(buildSpanExcerpt(lines, symbol.line, symbol.endLine)),
    bases: symbol.bases,
    decorators: [],
    members: []
  }));
  const containingScopes = findContainingPythonScopes(localSymbols, request.line, file);

  const preferred = selectedSymbol
    ? preferImportedDefinitions(index, file, selectedSymbol)
    : [];
  let definitionSymbols: PythonSymbol[] = preferred.map((item) => ({
    name: item.name,
    kind: item.kind === "class" ? "class" : "function",
    file: item.file,
    line: item.line,
    endLine: item.endLine,
    indent: 0,
    excerpt: "",
    bases: [],
    decorators: [],
    members: []
  }));

  if (definitionSymbols.length === 0 && containingScopes.length > 0) {
    const innermost = containingScopes[containingScopes.length - 1];
    if (innermost) {
      definitionSymbols = [innermost];
    }
  }

  const primaryDefinition = resolvePrimaryDefinition(
    selectedSymbol,
    definitionSymbols,
    containingScopes,
    file,
    request.line
  );

  if (
    primaryDefinition &&
    !definitionSymbols.some(
      (symbol) => symbol.file === primaryDefinition.file && symbol.line === primaryDefinition.line
    )
  ) {
    definitionSymbols = [primaryDefinition, ...definitionSymbols];
  }

  const definitions =
    definitionSymbols.length > 0
      ? definitionSymbols.map((symbol) =>
          createSourceReference(symbol.file, symbol.line, symbol.excerpt, "definition", 100)
        )
      : [
          createSourceReference(
            file,
            request.line,
            redactSecrets(buildExcerpt(lines, request.line, 4)),
            "mention",
            20
          )
        ];

  const effectiveSymbol = selectedSymbol ?? primaryDefinition?.name;
  const definitionFiles = definitions.map((item) => item.file);
  const references = effectiveSymbol
    ? await collectImportScopedUsages(
        workspace.rootPath,
        index,
        effectiveSymbol,
        definitionFiles,
        file
      )
    : [];
  const relatedFiles = rankRelatedFiles(definitions, references);

  const resolvedDefinition = Boolean(primaryDefinition) || definitionSymbols.length > 0;
  const metadata: ResolutionMetadata = {
    source: usedAst ? "ast" : "text",
    capabilityTier: usedAst ? 2 : 1,
    confidence: effectiveSymbol
      ? resolvedDefinition
        ? references.length > 0
          ? 0.92
          : 0.84
        : 0.46
      : 0.35
  };

  if (effectiveSymbol) {
    void persistUnderstandingSession({
      rootPath: workspace.rootPath,
      filePath: file,
      line: request.line,
      selectedText: request.selectedText,
      symbol: effectiveSymbol,
      definitionFiles,
      usageFiles: references.map((item) => item.file)
    });
  }

  return {
    workspace,
    file,
    lines,
    selectedSymbol: effectiveSymbol,
    primaryDefinition,
    workspacePythonFiles: [],
    workspaceAnalysis: { symbols: localSymbols, usedAst },
    localSymbols,
    containingScopes,
    definitions,
    references,
    relatedFiles,
    metadata
  };
}

export async function findDefinition(request: ExplainSelectionRequest): Promise<SourceReference[]> {
  const analysis = await analyzeSelection(request);

  return analysis.definitions;
}

export async function findUsages(request: ExplainSelectionRequest): Promise<SourceReference[]> {
  const analysis = await analyzeSelection(request);

  return analysis.references;
}

export async function getLogicalSection(request: ExplainSelectionRequest): Promise<LogicalSectionResult> {
  const analysis = await analyzeSelection(request);
  const depth: LogicalSectionDepth = request.depth ?? "auto";
  const scopes = analysis.containingScopes;
  const functionScope = [...scopes].reverse().find((scope) => scope.kind === "function");
  const classScope = [...scopes].reverse().find((scope) => scope.kind === "class");
  const narrowestScope = scopes[scopes.length - 1];

  if (depth === "statement" || (depth === "auto" && !narrowestScope)) {
    const statement = detectStatementBlock(analysis.lines, request.line);

    return {
      file: analysis.file,
      kind: "statement",
      depth,
      startLine: statement.startLine,
      endLine: statement.endLine,
      excerpt: statement.excerpt,
      confidence: 0.55
    };
  }

  if (depth === "function" && functionScope) {
    return {
      file: analysis.file,
      symbolName: functionScope.name,
      kind: functionScope.kind,
      depth,
      startLine: functionScope.line,
      endLine: functionScope.endLine,
      excerpt: functionScope.excerpt,
      confidence: 0.9
    };
  }

  if (depth === "class" && classScope) {
    return {
      file: analysis.file,
      symbolName: classScope.name,
      kind: classScope.kind,
      depth,
      startLine: classScope.line,
      endLine: classScope.endLine,
      excerpt: classScope.excerpt,
      confidence: 0.88
    };
  }

  if (narrowestScope) {
    return {
      file: analysis.file,
      symbolName: narrowestScope.name,
      kind: narrowestScope.kind,
      depth,
      startLine: narrowestScope.line,
      endLine: narrowestScope.endLine,
      excerpt: narrowestScope.excerpt,
      confidence: 0.86
    };
  }

  const statement = detectStatementBlock(analysis.lines, request.line);

  return {
    file: analysis.file,
    kind: "text",
    depth,
    startLine: statement.startLine,
    endLine: statement.endLine,
    excerpt: statement.excerpt,
    confidence: 0.4
  };
}

export async function buildSelectionContext(request: ExplainSelectionRequest): Promise<SelectionContextResult> {
  const analysis = await analyzeSelection(request);

  const target: TargetContext = {
    workspaceId: analysis.workspace.id,
    file: analysis.file,
    line: request.line,
    selectedText: analysis.selectedSymbol ?? request.selectedText
  };
  const explanation = buildExplanation(
    analysis.file,
    request.line,
    analysis.selectedSymbol,
    analysis.primaryDefinition,
    analysis.definitions,
    analysis.references,
    analysis.lines
  );

  return {
    workspace: analysis.workspace,
    context: {
      workspace: analysis.workspace,
      target,
      definitions: analysis.definitions,
      references: analysis.references,
      relatedFiles: analysis.relatedFiles,
      documentation: [],
      configuration: []
    },
    metadata: analysis.metadata,
    explanation
  };
}

export interface RepoBriefSymbol {
  file: string;
  line: number;
  name: string;
  kind: string;
}

export interface RepoBrief {
  rootPath: string;
  pythonFileCount: number;
  topLevelPackages: string[];
  entrypoints: string[];
  notableSymbols: RepoBriefSymbol[];
  summaryLines: string[];
}

/**
 * Lightweight first-look map of a Python workspace (no narrative dump).
 */
export async function buildRepoBrief(rootPath: string): Promise<RepoBrief> {
  const workspace = createWorkspaceSummary(rootPath);
  const { index } = await ensureWorkspaceIndex(workspace.rootPath);
  const overview = buildProjectOverview(index);

  const summaryLines = [
    `Python files indexed: ${overview.pythonFileCount}`,
    `Symbols: ${overview.symbolCount} (${overview.classCount} classes, ${overview.functionCount} functions)`,
    overview.topLevelPackages.length
      ? `Top-level packages/dirs: ${overview.topLevelPackages.join(", ")}`
      : "Top-level packages/dirs: (flat layout)",
    overview.entrypoints.length ? `Entrypoints: ${overview.entrypoints.join(", ")}` : "Entrypoints: (none obvious)",
    overview.notableSymbols.length
      ? `Notable symbols: ${overview.notableSymbols
          .slice(0, 8)
          .map((item) => `${item.name} (${item.kind})`)
          .join(", ")}`
      : "Notable symbols: (none resolved)"
  ];

  return {
    rootPath: workspace.rootPath,
    pythonFileCount: overview.pythonFileCount,
    topLevelPackages: overview.topLevelPackages,
    entrypoints: overview.entrypoints,
    notableSymbols: overview.notableSymbols,
    summaryLines
  };
}
