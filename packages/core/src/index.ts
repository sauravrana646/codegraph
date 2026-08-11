import fs from "node:fs/promises";
import path from "node:path";

import { parsePythonFile, type PythonAstMember, type PythonAstSymbol } from "@codegraph/language-intelligence";
import type {
  ContextBundle,
  Explanation,
  InferredClaim,
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

function isPydanticLike(symbol: PythonSymbol): boolean {
  return symbol.bases.some((base) => /BaseModel\b|BaseSettings\b|BaseConfig\b/.test(base));
}

function isDataclassLike(symbol: PythonSymbol): boolean {
  return symbol.decorators.some((decorator) => /dataclass\b/.test(decorator));
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

function describeSymbolRole(symbol: PythonSymbol): string {
  if (symbol.kind === "class") {
    if (isPydanticLike(symbol)) {
      return "Pydantic model class";
    }
    if (isDataclassLike(symbol)) {
      return "dataclass";
    }
    return "Python class";
  }

  return "Python function";
}

function formatField(member: PythonAstMember): string {
  const annotation = member.annotation ? `: ${member.annotation}` : "";
  const value = member.value ? ` = ${member.value}` : "";
  return `${member.name}${annotation}${value}`;
}

function formatMethod(member: PythonAstMember): string {
  const decorators = (member.decorators ?? []).length > 0 ? `@${(member.decorators ?? []).join(", @")} ` : "";
  return `${decorators}${member.name}()`;
}

function buildStructuralHowItWorks(symbol: PythonSymbol): string {
  const lines: string[] = [];

  if (symbol.kind === "class") {
    const bases = symbol.bases.length > 0 ? symbol.bases.join(", ") : "(no explicit bases)";
    lines.push(`${symbol.name} is a ${describeSymbolRole(symbol)} inheriting from ${bases}.`);

    if (symbol.docstring) {
      lines.push(`Docstring: ${symbol.docstring}`);
    }

    const fields = fieldMembers(symbol);
    if (fields.length > 0) {
      lines.push("Fields:");
      for (const field of fields.slice(0, 12)) {
        lines.push(`- ${formatField(field)}`);
      }
    }

    const validators = validatorMethods(symbol);
    if (validators.length > 0) {
      lines.push("Validators / serializers:");
      for (const method of validators.slice(0, 8)) {
        lines.push(`- ${formatMethod(method)}`);
      }
    }

    const methods = methodMembers(symbol).filter(
      (member) => !validatorMethods(symbol).some((validator) => validator.name === member.name)
    );
    if (methods.length > 0) {
      lines.push("Methods:");
      for (const method of methods.slice(0, 8)) {
        lines.push(`- ${formatMethod(method)}`);
      }
    }
  } else {
    lines.push(`${symbol.name} is a ${describeSymbolRole(symbol)} defined at this location.`);
    if (symbol.docstring) {
      lines.push(`Docstring: ${symbol.docstring}`);
    }
    if (symbol.decorators.length > 0) {
      lines.push(`Decorators: ${symbol.decorators.join(", ")}`);
    }
  }

  lines.push("", "Definition excerpt:", symbol.excerpt);
  return lines.join("\n");
}

function buildWhatItDoes(symbolName: string | undefined, primary?: PythonSymbol): string {
  if (!symbolName) {
    return "This explanation focuses on the nearest code section around the cursor.";
  }

  if (!primary) {
    return `This explanation focuses on the Python symbol \`${symbolName}\` and the nearest relevant scope around the cursor.`;
  }

  if (primary.kind === "class") {
    const fields = fieldMembers(primary);
    const role = describeSymbolRole(primary);
    if (fields.length > 0) {
      const fieldNames = fields.map((field) => `\`${field.name}\``).join(", ");
      return `\`${primary.name}\` is a ${role} with ${fields.length} field(s): ${fieldNames}.`;
    }
    return `\`${primary.name}\` is a ${role}${primary.bases.length ? ` (${primary.bases.join(", ")})` : ""}.`;
  }

  if (primary.docstring) {
    return `\`${primary.name}\` is a function: ${primary.docstring}`;
  }

  return `\`${primary.name}\` is a Python function defined in this file.`;
}

function buildWhyItExists(
  symbolName: string | undefined,
  primary: PythonSymbol | undefined,
  references: SourceReference[]
): string {
  const referenceCount = references.length;
  const callCount = references.filter((reference) => reference.kind === "call").length;
  const mentionCount = references.filter((reference) => reference.kind === "mention").length;

  if (referenceCount > 0) {
    const parts = [`Found ${referenceCount} non-definition reference(s)`];
    if (callCount > 0) {
      parts.push(`${callCount} call site(s)`);
    }
    if (mentionCount > 0) {
      parts.push(`${mentionCount} type/mention site(s)`);
    }
    return `${parts.join(", ")}. This suggests \`${symbolName}\` participates in the current repository flow.`;
  }

  if (primary?.kind === "class" && isPydanticLike(primary)) {
    return `\`${primary.name}\` looks like a local contract/model (Pydantic). No external call sites were found in the bounded scan; it may be used via type annotations, dynamic construction, or neighboring symbols in the same module.`;
  }

  if (primary) {
    return `No additional non-definition references were found for \`${primary.name}\` in the scanned Python files; explanation is based on the local definition structure.`;
  }

  return "No additional non-definition references were found in the scanned Python files, so this explanation is based mostly on local context.";
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

function buildCodebaseUsage(references: SourceReference[], primary?: PythonSymbol): string {
  if (references.length > 0) {
    return references
      .slice(0, 5)
      .map((reference) => {
        const focus = excerptFocusLine(reference.excerpt, primary?.name);
        return `- [${reference.kind ?? "mention"}] ${reference.file}:${reference.line}${focus ? `\n  ${focus}` : ""}`;
      })
      .join("\n");
  }

  if (primary) {
    return `No repository-wide references beyond the definition of \`${primary.name}\` were found in the current bounded scan. Local definition: ${primary.file}:${primary.line}-${primary.endLine}.`;
  }

  return "No repository-wide references were found in the current bounded scan.";
}

function buildInferredClaims(
  symbolName: string,
  primary: PythonSymbol | undefined,
  definitions: SourceReference[],
  references: SourceReference[]
): InferredClaim[] {
  const claims: InferredClaim[] = [];

  if (primary?.kind === "class" && isPydanticLike(primary)) {
    const fields = fieldMembers(primary);
    const validators = validatorMethods(primary);
    claims.push({
      claim: `${symbolName} is a Pydantic BaseModel${fields.length ? ` with ${fields.length} declared field(s)` : ""}${validators.length ? ` and ${validators.length} validator(s)` : ""}.`,
      confidence: "high",
      evidence: definitions.slice(0, 1)
    });
  }

  if (definitions.length > 0 && references.length > 0) {
    const callCount = references.filter((reference) => reference.kind === "call").length;
    claims.push({
      claim:
        callCount > 0
          ? `${symbolName} appears to be actively called in the current repository.`
          : `${symbolName} appears to be referenced in the current repository.`,
      confidence: references.length > 2 ? "high" : "medium",
      evidence: [...definitions.slice(0, 1), ...references.slice(0, 2)]
    });
  }

  return claims;
}

function buildExplanation(
  file: string,
  line: number,
  symbolName: string | undefined,
  primary: PythonSymbol | undefined,
  definitions: SourceReference[],
  references: SourceReference[],
  containingScopes: PythonSymbol[]
): Explanation {
  const scopeText =
    containingScopes.length > 0
      ? ` inside ${containingScopes.map((scope) => `${scope.kind} \`${scope.name}\``).join(" > ")}`
      : "";
  const definitionText = definitions[0] ? `${definitions[0].file}:${definitions[0].line}` : `${file}:${line}`;

  const summary = symbolName
    ? primary
      ? `Codegraph identified \`${symbolName}\` as a ${describeSymbolRole(primary)} at ${definitionText}.`
      : `Codegraph identified \`${symbolName}\`${scopeText} and found its best local definition at ${definitionText}.`
    : `Codegraph assembled bounded local context for ${file}:${line}.`;

  const howItWorks = primary
    ? buildStructuralHowItWorks(primary)
    : definitions[0]?.excerpt
      ? `Codegraph captured the local definition excerpt and bounded surrounding lines for analysis.\n\n${definitions[0].excerpt}`
      : "Codegraph used local file context because no better definition was found yet.";

  return {
    summary,
    whatItDoes: buildWhatItDoes(symbolName, primary),
    howItWorks,
    whyItExists: buildWhyItExists(symbolName, primary, references),
    codebaseUsage: buildCodebaseUsage(references, primary),
    caveats: [
      "This MVP uses deterministic local analysis with an AST-backed Python parser when python3 is available.",
      "Repository-wide reference search is bounded and may miss dynamically generated usages."
    ],
    confidence: primary || definitions.length > 0 ? (references.length > 0 ? "high" : "medium") : "low",
    sources: dedupeReferences([...definitions, ...references]).slice(0, 8),
    relatedCode: references.slice(0, 5),
    inferredClaims: symbolName ? buildInferredClaims(symbolName, primary, definitions, references) : []
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
