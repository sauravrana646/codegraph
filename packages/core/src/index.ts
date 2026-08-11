import fs from "node:fs/promises";
import path from "node:path";

import { parsePythonFile } from "@codegraph/language-intelligence";
import type {
  ContextBundle,
  Explanation,
  InferredClaim,
  ResolutionMetadata,
  SourceReference,
  TargetContext,
  WorkspaceSummary
} from "@codegraph/protocol";
import { redactSecrets } from "@codegraph/security";
import { createWorkspaceSummary, normalizeWorkspacePath } from "@codegraph/workspace";

export interface ExplainSelectionRequest {
  rootPath: string;
  filePath: string;
  line: number;
  selectedText?: string;
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
  kind: PythonSymbolKind | "text";
  startLine: number;
  endLine: number;
  excerpt: string;
}

interface SelectionAnalysis {
  workspace: WorkspaceSummary;
  file: string;
  lines: string[];
  selectedSymbol?: string;
  workspacePythonFiles: Array<{ file: string; absolutePath: string; content: string }>;
  workspaceAnalysis: WorkspacePythonAnalysis;
  localSymbols: PythonSymbol[];
  containingScopes: PythonSymbol[];
  definitions: SourceReference[];
  references: SourceReference[];
  relatedFiles: SourceReference[];
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

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getLine(lines: string[], lineNumber: number): string {
  return lines[Math.max(0, lineNumber - 1)] ?? "";
}

function extractSymbolFromLine(line: string): string | undefined {
  const tokens = line.match(/[A-Za-z_][A-Za-z0-9_]*/g);

  return tokens?.[0];
}

function detectSelectedSymbol(lines: string[], lineNumber: number, selectedText?: string): string | undefined {
  if (selectedText) {
    const exactTokenMatch = selectedText.match(/[A-Za-z_][A-Za-z0-9_]*/);

    return exactTokenMatch?.[0];
  }

  return extractSymbolFromLine(getLine(lines, lineNumber));
}

function hydratePythonSymbols(
  file: string,
  content: string,
  symbols: Array<{ name: string; kind: PythonSymbolKind; line: number; endLine: number; indent: number }>
): PythonSymbol[] {
  const lines = content.split(/\r?\n/);

  return symbols.map((symbol) => ({
    ...symbol,
    file,
    excerpt: redactSecrets(buildExcerpt(lines, symbol.line))
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

    const absolutePath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkWorkspaceFiles(rootPath, absolutePath)));
      continue;
    }

    files.push(path.relative(rootPath, absolutePath));
  }

  return files;
}

async function readWorkspacePythonFiles(rootPath: string): Promise<Array<{ file: string; absolutePath: string; content: string }>> {
  const files = await walkWorkspaceFiles(rootPath);
  const pythonFiles = files.filter((file) => file.endsWith(".py")).slice(0, 200);

  return Promise.all(
    pythonFiles.map(async (file) => ({
      file,
      absolutePath: path.join(rootPath, file),
      content: await fs.readFile(path.join(rootPath, file), "utf8")
    }))
  );
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

function findSymbolDefinitions(symbols: PythonSymbol[], symbolName: string): PythonSymbol[] {
  return symbols.filter((symbol) => symbol.name === symbolName);
}

function findSymbolReferences(
  files: Array<{ file: string; content: string }>,
  symbolName: string,
  limit = 8
): SourceReference[] {
  const pattern = new RegExp(`\\b${escapeForRegex(symbolName)}\\b`);
  const references: SourceReference[] = [];

  for (const { file, content } of files) {
    const lines = content.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";

      if (!pattern.test(line)) {
        continue;
      }

      references.push({
        file,
        line: index + 1,
        excerpt: redactSecrets(buildExcerpt(lines, index + 1))
      });

      if (references.length >= limit) {
        return references;
      }
    }
  }

  return references;
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

function buildInferredClaims(
  symbolName: string,
  definitions: SourceReference[],
  references: SourceReference[]
): InferredClaim[] {
  if (definitions.length === 0 || references.length === 0) {
    return [];
  }

  return [
    {
      claim: `${symbolName} appears to be actively used in the current repository.`,
      confidence: references.length > 2 ? "high" : "medium",
      evidence: [...definitions.slice(0, 1), ...references.slice(0, 2)]
    }
  ];
}

function buildExplanation(
  file: string,
  line: number,
  symbolName: string | undefined,
  definitions: SourceReference[],
  references: SourceReference[],
  containingScopes: PythonSymbol[]
): Explanation {
  const scopeText = containingScopes.length > 0
    ? ` inside ${containingScopes.map((scope) => `${scope.kind} \`${scope.name}\``).join(" > ")}`
    : "";
  const definitionText = definitions[0]
    ? `${definitions[0].file}:${definitions[0].line}`
    : `${file}:${line}`;
  const referenceCount = references.length;

  return {
    summary: symbolName
      ? `Codegraph identified \`${symbolName}\`${scopeText} and found its best local definition at ${definitionText}.`
      : `Codegraph assembled bounded local context for ${file}:${line}.`,
    whatItDoes: symbolName
      ? `This explanation focuses on the Python symbol \`${symbolName}\` and the nearest relevant scope around the cursor.`
      : "This explanation focuses on the nearest code section around the cursor.",
    howItWorks: definitions[0]?.excerpt
      ? `Codegraph captured the local definition excerpt and bounded surrounding lines for analysis.\n\n${definitions[0].excerpt}`
      : "Codegraph used local file context because no better definition was found yet.",
    whyItExists: referenceCount > 0
      ? `The symbol is referenced ${referenceCount} time(s) in the scanned Python workspace files, which suggests it participates in the current repository flow.`
      : "No additional references were found in the scanned Python files, so this first explanation is based mostly on local context.",
    codebaseUsage: referenceCount > 0
      ? references
          .slice(0, 3)
          .map((reference) => `- ${reference.file}:${reference.line}`)
          .join("\n")
      : "No repository-wide references were found in the current bounded scan.",
    caveats: [
      "This MVP uses deterministic local analysis with an AST-backed Python parser when python3 is available.",
      "Repository-wide reference search is bounded and may miss dynamically generated usages."
    ],
    confidence: definitions.length > 0 ? "medium" : "low",
    sources: dedupeReferences([...definitions, ...references]).slice(0, 8),
    relatedCode: references.slice(0, 5),
    inferredClaims: symbolName ? buildInferredClaims(symbolName, definitions, references) : []
  };
}

async function analyzeSelection(request: ExplainSelectionRequest): Promise<SelectionAnalysis> {
  const workspace = createWorkspaceSummary(request.rootPath);
  const absoluteFilePath = normalizeWorkspacePath(workspace.rootPath, request.filePath);
  const file = path.relative(workspace.rootPath, absoluteFilePath);
  const content = await fs.readFile(absoluteFilePath, "utf8");
  const lines = content.split(/\r?\n/);
  const workspacePythonFiles = await readWorkspacePythonFiles(workspace.rootPath);
  const selectedSymbol = detectSelectedSymbol(lines, request.line, request.selectedText);
  const workspaceAnalysis = await collectWorkspacePythonSymbols(workspacePythonFiles);
  const workspaceSymbols = workspaceAnalysis.symbols;
  const localSymbols = workspaceSymbols.filter((symbol) => symbol.file === file);
  const containingScopes = languageFromFile(file) === "python" ? findContainingPythonScopes(localSymbols, request.line, file) : [];
  const definitions = selectedSymbol
    ? findSymbolDefinitions(workspaceSymbols, selectedSymbol).map((symbol) =>
        createSourceReference(symbol.file, symbol.line, symbol.excerpt)
      )
    : [createSourceReference(file, request.line, redactSecrets(buildExcerpt(lines, request.line)))];
  const references = selectedSymbol ? findSymbolReferences(workspacePythonFiles, selectedSymbol) : [];
  const relatedFiles = dedupeReferences(references).map((reference) => ({
    file: reference.file,
    line: reference.line,
    excerpt: reference.excerpt
  }));
  const metadata: ResolutionMetadata = {
    source: languageFromFile(file) === "python" && workspaceAnalysis.usedAst ? "ast" : "text",
    capabilityTier: languageFromFile(file) === "python" ? 2 : 0,
    confidence: selectedSymbol
      ? definitions.length > 0
        ? 0.82
        : 0.46
      : 0.35
  };

  return {
    workspace,
    file,
    lines,
    selectedSymbol,
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
  const narrowestScope = analysis.containingScopes[analysis.containingScopes.length - 1];

  if (narrowestScope) {
    return {
      file: analysis.file,
      symbolName: narrowestScope.name,
      kind: narrowestScope.kind,
      startLine: narrowestScope.line,
      endLine: narrowestScope.endLine,
      excerpt: narrowestScope.excerpt
    };
  }

  return {
    file: analysis.file,
    kind: "text",
    startLine: Math.max(1, request.line - 2),
    endLine: Math.min(analysis.lines.length, request.line + 2),
    excerpt: redactSecrets(buildExcerpt(analysis.lines, request.line))
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
