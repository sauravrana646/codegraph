import fs from "node:fs/promises";
import path from "node:path";

import { parsePythonFile, type PythonAstMember, type PythonAstSymbol } from "@codegraph/language-intelligence";
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

function findSymbolReferences(
  files: Array<{ file: string; content: string }>,
  symbolName: string,
  definitions: SourceReference[],
  originFile: string,
  limit = 8
): SourceReference[] {
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

  return dedupeReferences(references)
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .slice(0, limit);
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

function fieldMembers(symbol: PythonSymbol): PythonAstMember[] {
  return symbol.members.filter((member) => member.kind === "field");
}

function methodMembers(symbol: PythonSymbol): PythonAstMember[] {
  return symbol.members.filter((member) => member.kind === "method");
}

function validatorMethods(symbol: PythonSymbol): PythonAstMember[] {
  return methodMembers(symbol).filter((member) =>
    (member.decorators ?? []).some((decorator) =>
      /field_validator|model_validator|validator|root_validator|field_serializer|model_serializer/.test(decorator)
    )
  );
}

function formatMethod(member: PythonAstMember): string {
  const decorators = (member.decorators ?? []).length > 0 ? `@${(member.decorators ?? []).join(", @")} ` : "";
  return `${decorators}${member.name}()`;
}

function excerptFocusLine(excerpt: string | undefined, symbolHint?: string): string {
  if (!excerpt) {
    return "";
  }

  const lines = excerpt.split("\n");
  if (symbolHint) {
    const hit = lines.find((line) => line.includes(symbolHint));
    if (hit) {
      return hit.trim();
    }
  }

  return (lines[Math.floor(lines.length / 2)] ?? lines[0] ?? "").trim();
}

function buildAstFactBlock(primary: PythonSymbol | undefined): string {
  if (!primary) {
    return "AST: no symbol structure resolved.";
  }

  const lines = [
    `AST symbol: ${primary.name}`,
    `kind: ${primary.kind}`,
    `span: ${primary.file}:${primary.line}-${primary.endLine}`,
    `bases: ${primary.bases.join(", ") || "(none)"}`,
    `decorators: ${primary.decorators.join(", ") || "(none)"}`,
    `docstring: ${primary.docstring || "(none)"}`
  ];

  const fields = fieldMembers(primary);
  if (fields.length > 0) {
    lines.push("fields:");
    for (const field of fields.slice(0, 20)) {
      lines.push(
        `- ${field.name}${field.annotation ? `: ${field.annotation}` : ""}${field.value ? ` = ${field.value}` : ""}`
      );
    }
  }

  const validators = validatorMethods(primary);
  if (validators.length > 0) {
    lines.push("validators:");
    for (const method of validators.slice(0, 12)) {
      lines.push(`- ${formatMethod(method)}`);
    }
  }

  const methods = methodMembers(primary).filter(
    (member) => !validators.some((validator) => validator.name === member.name)
  );
  if (methods.length > 0) {
    lines.push("methods:");
    for (const method of methods.slice(0, 12)) {
      lines.push(`- ${formatMethod(method)}`);
    }
  }

  lines.push("definition_excerpt:");
  lines.push(primary.excerpt);
  return lines.join("\n");
}

/**
 * Deterministic layer is context-only.
 * Narrative tutoring fields stay empty so LLM/Agent must produce the final explanation.
 */
function buildExplanation(
  file: string,
  line: number,
  symbolName: string | undefined,
  primary: PythonSymbol | undefined,
  definitions: SourceReference[],
  references: SourceReference[],
  _containingScopes: PythonSymbol[]
): Explanation {
  const shortName = symbolName ?? primary?.name;
  const definitionText = definitions[0] ? `${definitions[0].file}:${definitions[0].line}` : `${file}:${line}`;

  return {
    summary: shortName ? `${shortName} @ ${definitionText}` : `${file}:${line}`,
    whatItDoes: "",
    howItWorks: buildAstFactBlock(primary),
    whyItExists: "",
    codebaseUsage: references
      .slice(0, 12)
      .map((reference) => {
        const focus = excerptFocusLine(reference.excerpt, shortName);
        return `- [${reference.kind ?? "mention"}] ${reference.file}:${reference.line}${focus ? `\n  ${focus}` : ""}`;
      })
      .join("\n"),
    caveats: [],
    confidence: primary || definitions.length > 0 ? (references.length > 0 ? "high" : "medium") : "low",
    sources: dedupeReferences([...definitions, ...references]).slice(0, 12),
    relatedCode: references.slice(0, 8),
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
  const workspacePythonFiles = await readWorkspacePythonFiles(workspace.rootPath, file);
  const selectedSymbol = detectSelectedSymbol(lines, request.line, request.selectedText);
  const workspaceAnalysis = await collectWorkspacePythonSymbols(workspacePythonFiles);
  const workspaceSymbols = workspaceAnalysis.symbols;
  const localSymbols = workspaceSymbols.filter((symbol) => symbol.file === file);
  const containingScopes =
    languageFromFile(file) === "python" ? findContainingPythonScopes(localSymbols, request.line, file) : [];

  let definitionSymbols = selectedSymbol
    ? findSymbolDefinitions(workspaceSymbols, selectedSymbol, file)
    : [];

  // If name lookup failed but we are inside a Python scope, prefer that scope.
  if (definitionSymbols.length === 0 && containingScopes.length > 0) {
    const innermost = containingScopes[containingScopes.length - 1];
    if (innermost && (!selectedSymbol || innermost.name === selectedSymbol || selectedSymbol === innermost.name)) {
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

  if (primaryDefinition && !definitionSymbols.some((symbol) => symbol.file === primaryDefinition.file && symbol.line === primaryDefinition.line)) {
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
  const references = effectiveSymbol
    ? findSymbolReferences(workspacePythonFiles, effectiveSymbol, definitions, file)
    : [];
  const relatedFiles = dedupeReferences(references).map((reference) => ({
    file: reference.file,
    line: reference.line,
    excerpt: reference.excerpt,
    kind: reference.kind,
    score: reference.score
  }));

  const resolvedDefinition = Boolean(primaryDefinition) || definitionSymbols.length > 0;
  const metadata: ResolutionMetadata = {
    source: languageFromFile(file) === "python" && workspaceAnalysis.usedAst ? "ast" : "text",
    capabilityTier: languageFromFile(file) === "python" ? 2 : 0,
    confidence: effectiveSymbol
      ? resolvedDefinition
        ? references.length > 0
          ? 0.9
          : 0.82
        : 0.46
      : 0.35
  };

  return {
    workspace,
    file,
    lines,
    selectedSymbol: effectiveSymbol,
    primaryDefinition,
    workspacePythonFiles,
    workspaceAnalysis,
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
    analysis.containingScopes
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
