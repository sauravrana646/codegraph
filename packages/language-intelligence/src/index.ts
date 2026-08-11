import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PythonAstSymbolKind = "function" | "class";

export interface PythonAstSymbol {
  name: string;
  kind: PythonAstSymbolKind;
  line: number;
  endLine: number;
  indent: number;
}

export interface PythonAstParseResult {
  symbols: PythonAstSymbol[];
  source: "python_ast" | "regex_fallback";
}

interface PythonParserJson {
  symbols?: PythonAstSymbol[];
}

const parserScriptPath = path.resolve(__dirname, "..", "python_symbol_parser.py");

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
      indent: (match[1] ?? "").length
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
    source: "regex_fallback"
  };
}

export async function parsePythonFile(filePath: string, content?: string): Promise<PythonAstParseResult> {
  const fileContent = content ?? (await fs.readFile(filePath, "utf8"));

  try {
    const { stdout } = await execFileAsync("python3", [parserScriptPath, filePath], {
      maxBuffer: 1024 * 1024
    });
    const parsed = JSON.parse(stdout) as PythonParserJson;

    return {
      symbols: parsed.symbols ?? [],
      source: "python_ast"
    };
  } catch {
    return regexFallback(fileContent);
  }
}
