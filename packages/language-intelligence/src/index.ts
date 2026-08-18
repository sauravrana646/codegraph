import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PythonAstSymbolKind = "function" | "class";
export type PythonAstMemberKind = "field" | "method";

export interface PythonCallSite {
  name: string;
  line: number;
  receiver?: string;
}

export interface PythonAstMember {
  kind: PythonAstMemberKind;
  name: string;
  line: number;
  endLine?: number;
  annotation?: string | null;
  value?: string | null;
  decorators?: string[];
  docstring?: string | null;
  signature?: string;
  calls?: PythonCallSite[];
}

export interface PythonAstSymbol {
  name: string;
  kind: PythonAstSymbolKind;
  line: number;
  endLine: number;
  indent: number;
  bases?: string[];
  decorators?: string[];
  docstring?: string | null;
  members?: PythonAstMember[];
  signature?: string;
  calls?: PythonCallSite[];
  parentName?: string | null;
}

export interface PythonAstImport {
  kind: "import" | "from";
  module: string;
  names: string[];
  alias?: string | null;
  line: number;
}

export interface PythonAstParseResult {
  symbols: PythonAstSymbol[];
  imports: PythonAstImport[];
  source: "python_ast" | "regex_fallback";
}

interface PythonParserJson {
  symbols?: PythonAstSymbol[];
  imports?: PythonAstImport[];
}

function resolveParserScriptPath(): string {
  const fromEnv = process.env.CODEGRAPH_PYTHON_PARSER?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  const candidates = [
    path.resolve(__dirname, "python_symbol_parser.py"),
    path.resolve(__dirname, "..", "python_symbol_parser.py"),
    path.resolve(__dirname, "..", "..", "language-intelligence", "python_symbol_parser.py")
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[1] ?? candidates[0]!;
}

function regexFallback(content: string): PythonAstParseResult {
  const lines = content.split(/\r?\n/);
  const symbols: PythonAstSymbol[] = [];

  lines.forEach((line, index) => {
    const match = line.match(/^(\s*)(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);

    if (!match) {
      return;
    }

    symbols.push({
      name: match[3] ?? "unknown",
      kind: match[2] === "class" ? "class" : "function",
      line: index + 1,
      endLine: lines.length,
      indent: (match[1] ?? "").length,
      bases: [],
      decorators: [],
      docstring: null,
      members: [],
      signature: `${match[2]} ${match[3]}`,
      calls: []
    });
  });

  for (let index = 0; index < symbols.length; index += 1) {
    const current = symbols[index];

    if (!current) {
      continue;
    }

    for (let nextIndex = index + 1; nextIndex < symbols.length; nextIndex += 1) {
      const next = symbols[nextIndex];

      if (!next) {
        continue;
      }

      if (next.indent <= current.indent) {
        current.endLine = next.line - 1;
        break;
      }
    }
  }

  return {
    symbols,
    imports: regexImports(content),
    source: "regex_fallback"
  };
}

function regexImports(content: string): PythonAstImport[] {
  const imports: PythonAstImport[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const fromMatch = line.match(/^\s*from\s+(\S+)\s+import\s+(.+)$/);
    if (fromMatch?.[1] && fromMatch[2]) {
      const names = fromMatch[2]
        .split(",")
        .map((part) => part.trim().split(/\s+as\s+/)[0]?.trim())
        .filter((name): name is string => Boolean(name) && name !== "(");
      imports.push({
        kind: "from",
        module: fromMatch[1],
        names: names.length ? names : ["*"],
        line: index + 1
      });
      return;
    }
    const importMatch = line.match(/^\s*import\s+(.+)$/);
    if (importMatch?.[1]) {
      for (const part of importMatch[1].split(",")) {
        const [module, alias] = part.trim().split(/\s+as\s+/);
        if (!module) {
          continue;
        }
        imports.push({
          kind: "import",
          module,
          names: [alias?.trim() || module.split(".").pop() || module],
          alias: alias?.trim() ?? null,
          line: index + 1
        });
      }
    }
  });
  return imports;
}

const PYTHON_LAUNCHERS = ["python3", "python", "py"];
const PARSER_MAX_BUFFER = 16 * 1024 * 1024;

let cachedPythonLauncher: string | undefined;
let pythonLauncherUnavailable = false;
let lastParserFailure: string | undefined;

export function pythonParserUnavailable(): boolean {
  return pythonLauncherUnavailable;
}

export function consumePythonParserFailure(): string | undefined {
  const message = lastParserFailure;
  lastParserFailure = undefined;
  return message;
}

async function resolvePythonLauncher(): Promise<string | undefined> {
  if (cachedPythonLauncher) {
    return cachedPythonLauncher;
  }
  if (pythonLauncherUnavailable) {
    return undefined;
  }

  for (const command of PYTHON_LAUNCHERS) {
    try {
      await execFileAsync(command, ["-c", "import ast"], { timeout: 8000 });
      cachedPythonLauncher = command;
      return command;
    } catch {
      // try next launcher
    }
  }

  pythonLauncherUnavailable = true;
  lastParserFailure = "No Python launcher found (tried python3, python, py)";
  return undefined;
}

export async function parsePythonFile(filePath: string, content?: string): Promise<PythonAstParseResult> {
  const fileContent = content ?? (await fs.readFile(filePath, "utf8"));
  const launcher = await resolvePythonLauncher();

  if (!launcher) {
    return regexFallback(fileContent);
  }

  try {
    const { stdout } = await execFileAsync(launcher, [resolveParserScriptPath(), filePath], {
      maxBuffer: PARSER_MAX_BUFFER
    });
    const parsed = JSON.parse(stdout) as PythonParserJson;

    return {
      symbols: parsed.symbols ?? [],
      imports: parsed.imports ?? [],
      source: "python_ast"
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    lastParserFailure = detail;
    if (/maxBuffer/i.test(detail)) {
      console.error(`Codegraph parser maxBuffer exceeded for ${filePath}: ${detail}`);
    }
    return regexFallback(fileContent);
  }
}
