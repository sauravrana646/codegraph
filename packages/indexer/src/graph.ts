import type {
  GraphEdge,
  IndexedCallSite,
  IndexedSymbol,
  SymbolNeighborhood,
  WorkspaceIndex
} from "./types";

const PYTHON_SKIP_CALLS = new Set([
  "print",
  "len",
  "str",
  "int",
  "float",
  "list",
  "dict",
  "set",
  "tuple",
  "range",
  "enumerate",
  "zip",
  "map",
  "filter",
  "open",
  "isinstance",
  "issubclass",
  "hasattr",
  "getattr",
  "setattr",
  "delattr",
  "super",
  "type",
  "id",
  "min",
  "max",
  "sum",
  "any",
  "all",
  "sorted",
  "reversed",
  "iter",
  "next",
  "format",
  "abs",
  "round",
  "bool",
  "bytes",
  "bytearray",
  "object",
  "repr",
  "hash",
  "hex",
  "oct",
  "bin",
  "chr",
  "ord",
  "ascii",
  "input",
  "vars",
  "dir",
  "locals",
  "globals",
  "callable",
  "classmethod",
  "staticmethod",
  "property",
  "Exception",
  "ValueError",
  "TypeError",
  "KeyError",
  "IndexError",
  "AttributeError",
  "RuntimeError",
  "NotImplementedError",
  "StopIteration",
  "AssertionError",
  "True",
  "False",
  "None"
]);

const COMMON_METHOD_NAMES = new Set([
  "get",
  "set",
  "add",
  "append",
  "extend",
  "update",
  "pop",
  "remove",
  "clear",
  "copy",
  "items",
  "keys",
  "values",
  "join",
  "split",
  "strip",
  "replace",
  "format",
  "read",
  "write",
  "close",
  "load",
  "loads",
  "dump",
  "dumps"
]);

interface SymbolRef {
  file: string;
  symbol: IndexedSymbol;
}

interface ResolverMaps {
  globalByName: Map<string, SymbolRef[]>;
  perFileByName: Map<string, Map<string, IndexedSymbol[]>>;
  methodsByQualName: Map<string, SymbolRef>;
}

function normalizeRel(file: string): string {
  return file.replace(/\\/g, "/");
}

function methodQualKey(file: string, parentName: string, methodName: string): string {
  return `${normalizeRel(file)}::${parentName}::${methodName}`;
}

export function displaySymbolName(symbol: IndexedSymbol, file: string): string {
  if (symbol.name === "<module>") {
    const base = normalizeRel(file).split("/").pop() ?? "module";
    return base.replace(/\.py$/, "") || "module";
  }
  if (symbol.parentName) {
    return `${symbol.parentName}.${symbol.name}`;
  }
  return symbol.name;
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.file}:${edge.line}:${edge.name}`;
}

function dedupeEdges(edges: GraphEdge[], limit = 16): GraphEdge[] {
  const seen = new Set<string>();
  const out: GraphEdge[] = [];
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(edge);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

function shouldSkipCallName(name: string, uniqueNameTier: boolean): boolean {
  if (!name || name.length < 2) {
    return true;
  }
  if (PYTHON_SKIP_CALLS.has(name)) {
    return true;
  }
  if (name.startsWith("__") && name.endsWith("__")) {
    return true;
  }
  if (uniqueNameTier && (name.length < 3 || COMMON_METHOD_NAMES.has(name))) {
    return true;
  }
  return false;
}

export function resolvePythonModuleFiles(
  index: WorkspaceIndex,
  fromFile: string,
  module: string
): string[] {
  const fromDir = pathPosixDirname(normalizeRel(fromFile));
  const candidates: string[] = [];

  if (module.startsWith(".")) {
    let dots = 0;
    while (module[dots] === ".") {
      dots += 1;
    }
    let dir = fromDir;
    for (let step = 1; step < dots; step += 1) {
      dir = pathPosixDirname(dir);
    }
    const rest = module.slice(dots).replace(/\./g, "/");
    const base = rest ? posixJoin(dir === "." ? "" : dir, rest) : dir;
    candidates.push(`${base}.py`, posixJoin(base, "__init__.py"));
  } else {
    const rel = module.replace(/\./g, "/");
    for (const prefix of ["", "src/"]) {
      const base = `${prefix}${rel}`.replace(/^\/+/, "");
      candidates.push(`${base}.py`, posixJoin(base, "__init__.py"));
    }
  }

  return [...new Set(candidates.map(normalizeRel))].filter((file) => Boolean(index.files[file]));
}

function pathPosixDirname(file: string): string {
  const idx = file.lastIndexOf("/");
  if (idx <= 0) {
    return ".";
  }
  return file.slice(0, idx);
}

function posixJoin(...parts: string[]): string {
  return parts
    .filter((part) => part && part !== ".")
    .join("/")
    .replace(/\/+/g, "/");
}

export function findIndexedDefinitions(
  index: WorkspaceIndex,
  symbolName: string,
  preferFile?: string,
  options?: { includeMethods?: boolean }
): Array<IndexedSymbol & { file: string }> {
  const matches: Array<IndexedSymbol & { file: string }> = [];
  for (const file of Object.values(index.files)) {
    for (const symbol of file.symbols) {
      if (symbol.name !== symbolName) {
        continue;
      }
      if (!options?.includeMethods && symbol.parentName) {
        continue;
      }
      matches.push({ ...symbol, file: normalizeRel(file.relativePath) });
    }
  }
  if (!preferFile) {
    return matches;
  }
  const preferred = normalizeRel(preferFile);
  return [
    ...matches.filter((item) => item.file === preferred),
    ...matches.filter((item) => item.file !== preferred)
  ];
}

function toEdge(
  file: string,
  symbol: IndexedSymbol,
  confidence: number,
  via: GraphEdge["via"]
): GraphEdge {
  return {
    file: normalizeRel(file),
    line: symbol.line,
    name: displaySymbolName(symbol, file),
    kind: symbol.kind,
    confidence,
    via
  };
}

function buildResolverMaps(index: WorkspaceIndex): ResolverMaps {
  const globalByName = new Map<string, SymbolRef[]>();
  const perFileByName = new Map<string, Map<string, IndexedSymbol[]>>();
  const methodsByQualName = new Map<string, SymbolRef>();

  for (const file of Object.values(index.files)) {
    const fromFile = normalizeRel(file.relativePath);
    const byName = new Map<string, IndexedSymbol[]>();
    for (const symbol of file.symbols) {
      const list = byName.get(symbol.name) ?? [];
      list.push(symbol);
      byName.set(symbol.name, list);

      const global = globalByName.get(symbol.name) ?? [];
      global.push({ file: fromFile, symbol });
      globalByName.set(symbol.name, global);

      if (symbol.parentName) {
        methodsByQualName.set(methodQualKey(fromFile, symbol.parentName, symbol.name), {
          file: fromFile,
          symbol
        });
      }
    }
    perFileByName.set(fromFile, byName);
  }

  return { globalByName, perFileByName, methodsByQualName };
}

function lookupFileSymbols(
  maps: ResolverMaps,
  file: string,
  name: string
): IndexedSymbol[] {
  return maps.perFileByName.get(normalizeRel(file))?.get(name) ?? [];
}

function pickLocalSymbol(
  named: IndexedSymbol[],
  call: IndexedCallSite,
  enclosing: IndexedSymbol
): IndexedSymbol | undefined {
  if (named.length === 0) {
    return undefined;
  }

  const receiver = call.receiver;
  if (receiver === "self" || receiver === "cls") {
    if (enclosing.parentName) {
      const methods = named.filter((symbol) => symbol.parentName === enclosing.parentName);
      if (methods[0]) {
        return methods[0];
      }
    }
  }

  const topLevel = named.filter((symbol) => !symbol.parentName && symbol.name !== "<module>");
  if (topLevel.length === 1 && topLevel[0]) {
    return topLevel[0];
  }
  if (named.length === 1 && named[0]) {
    return named[0];
  }
  if (topLevel[0] && !receiver) {
    return topLevel[0];
  }
  return undefined;
}

function resolveImportedSymbol(
  index: WorkspaceIndex,
  maps: ResolverMaps,
  fromFile: string,
  call: IndexedCallSite
): GraphEdge | undefined {
  const origin = index.files[normalizeRel(fromFile)];
  if (!origin) {
    return undefined;
  }

  const imported: SymbolRef[] = [];
  const receiver = call.receiver;

  for (const item of origin.imports) {
    const nameMatches =
      item.names.includes(call.name) ||
      item.alias === call.name ||
      item.names.includes("*") ||
      (item.kind === "import" && (item.names.includes(receiver ?? "") || item.alias === receiver));

    if (!nameMatches) {
      continue;
    }

    for (const moduleFile of resolvePythonModuleFiles(index, fromFile, item.module)) {
      if (receiver && (item.kind === "import" ? item.alias === receiver || item.names.includes(receiver) : false)) {
        const methods = lookupFileSymbols(maps, moduleFile, call.name).filter((symbol) => Boolean(symbol.parentName));
        for (const symbol of methods) {
          imported.push({ file: moduleFile, symbol });
        }
        continue;
      }

      const symbols = lookupFileSymbols(maps, moduleFile, call.name);
      for (const symbol of symbols) {
        imported.push({ file: moduleFile, symbol });
      }
    }
  }

  const uniqueImported = dedupeEdges(
    imported.map((item) => toEdge(item.file, item.symbol, 0.9, "import")),
    8
  );
  if (uniqueImported.length === 1) {
    return uniqueImported[0];
  }
  return undefined;
}

function resolveCallSite(
  index: WorkspaceIndex,
  maps: ResolverMaps,
  fromFile: string,
  enclosing: IndexedSymbol,
  call: IndexedCallSite
): GraphEdge | undefined {
  if (shouldSkipCallName(call.name, false)) {
    return undefined;
  }

  const receiver = call.receiver;
  if ((receiver === "self" || receiver === "cls") && enclosing.parentName) {
    const method = maps.methodsByQualName.get(methodQualKey(fromFile, enclosing.parentName, call.name));
    if (method) {
      return toEdge(method.file, method.symbol, 0.95, "same-file");
    }
  }

  const local = pickLocalSymbol(lookupFileSymbols(maps, fromFile, call.name), call, enclosing);
  if (local) {
    return toEdge(fromFile, local, 0.95, "same-file");
  }

  const imported = resolveImportedSymbol(index, maps, fromFile, call);
  if (imported) {
    return imported;
  }

  if (shouldSkipCallName(call.name, true)) {
    return undefined;
  }

  const all = (maps.globalByName.get(call.name) ?? []).filter(
    (item) => !item.symbol.parentName && item.symbol.name !== "<module>"
  );
  if (all.length === 1 && all[0]) {
    return toEdge(all[0].file, all[0].symbol, 0.5, "unique-name");
  }
  return undefined;
}

export function attachCallGraph(index: WorkspaceIndex): void {
  const maps = buildResolverMaps(index);

  for (const file of Object.values(index.files)) {
    for (const symbol of file.symbols) {
      symbol.callees = [];
      symbol.callers = [];
    }
  }

  for (const file of Object.values(index.files)) {
    const fromFile = normalizeRel(file.relativePath);
    for (const symbol of file.symbols) {
      const callees: GraphEdge[] = [];
      for (const call of symbol.calls ?? []) {
        const resolved = resolveCallSite(index, maps, fromFile, symbol, call);
        if (!resolved) {
          continue;
        }
        if (resolved.file === fromFile && resolved.line === symbol.line) {
          continue;
        }
        callees.push(resolved);
        const targetFile = index.files[resolved.file];
        const target = targetFile?.symbols.find((item) => item.line === resolved.line);
        if (target) {
          target.callers.push({
            file: fromFile,
            line: call.line || symbol.line,
            name: displaySymbolName(symbol, fromFile),
            kind: symbol.kind,
            confidence: resolved.confidence,
            via: resolved.via
          });
        }
      }
      symbol.callees = dedupeEdges(callees);
    }
  }

  for (const file of Object.values(index.files)) {
    for (const symbol of file.symbols) {
      symbol.callers = dedupeEdges(symbol.callers);
    }
  }
}

function innermostSymbol(symbols: IndexedSymbol[], line: number): IndexedSymbol | undefined {
  const containing = symbols.filter((symbol) => symbol.line <= line && symbol.endLine >= line);
  if (containing.length === 0) {
    return undefined;
  }
  return containing.sort((left, right) => {
    const leftSpan = left.endLine - left.line;
    const rightSpan = right.endLine - right.line;
    if (leftSpan !== rightSpan) {
      return leftSpan - rightSpan;
    }
    return right.line - left.line;
  })[0];
}

function firstIdentifier(text: string | undefined): string | undefined {
  const match = text?.trim().match(/[A-Za-z_][A-Za-z0-9_]*/);
  return match?.[0];
}

export function lookupNeighborhood(
  index: WorkspaceIndex,
  filePath: string,
  line: number,
  selectedText?: string
): SymbolNeighborhood | undefined {
  const rel = normalizeRel(filePath);
  const file = index.files[rel];
  const selected = firstIdentifier(selectedText);

  let target: (IndexedSymbol & { file: string }) | undefined;

  if (file && selected) {
    const namedHere = file.symbols.filter(
      (symbol) => symbol.name === selected && symbol.line <= line && symbol.endLine >= line
    );
    const local = innermostSymbol(namedHere, line) ?? file.symbols.find((symbol) => symbol.name === selected);
    if (local) {
      target = { ...local, file: rel };
    }
  }

  if (!target && file) {
    const inner = innermostSymbol(file.symbols, line);
    if (inner) {
      target = { ...inner, file: rel };
    }
  }

  if (!target && selected) {
    const defs = findIndexedDefinitions(index, selected, rel, { includeMethods: true });
    if (defs[0]) {
      target = defs[0];
    }
  }

  if (!target) {
    return undefined;
  }

  const definitions = findIndexedDefinitions(index, target.name, target.file, {
    includeMethods: Boolean(target.parentName)
  })
    .filter((item) => !target.parentName || item.parentName === target.parentName)
    .slice(0, 6)
    .map((item) => toEdge(item.file, item, item.file === target.file ? 1 : 0.8, "same-file"));

  const relatedMap = new Map<string, GraphEdge>();
  for (const edge of [...definitions, ...target.callees, ...target.callers]) {
    if (edge.file === target.file) {
      continue;
    }
    if (!relatedMap.has(edge.file)) {
      relatedMap.set(edge.file, edge);
    }
  }

  return {
    symbol: displaySymbolName(target, target.file),
    kind: target.kind,
    file: target.file,
    line: target.line,
    endLine: target.endLine,
    signature: target.signature,
    docstring: target.docstring,
    definitions,
    callees: target.callees.slice(0, 8),
    callers: target.callers.slice(0, 8),
    related: [...relatedMap.values()].slice(0, 8)
  };
}

export function formatNeighborhoodLines(neighborhood: SymbolNeighborhood): string[] {
  const lines: string[] = [
    `symbol: ${neighborhood.kind} ${neighborhood.symbol} @ ${neighborhood.file}:${neighborhood.line}`
  ];
  if (neighborhood.signature) {
    lines.push(`signature: ${neighborhood.signature}`);
  }
  if (neighborhood.docstring) {
    lines.push(`docstring: ${neighborhood.docstring}`);
  }

  const formatEdge = (edge: GraphEdge): string =>
    `- ${edge.name} @ ${edge.file}:${edge.line} (${edge.confidence.toFixed(2)} ${edge.via})`;

  lines.push("defs:");
  if (neighborhood.definitions.length === 0) {
    lines.push("- (none)");
  } else {
    lines.push(...neighborhood.definitions.slice(0, 6).map(formatEdge));
  }

  lines.push("callees:");
  if (neighborhood.callees.length === 0) {
    lines.push("- (none)");
  } else {
    lines.push(...neighborhood.callees.map(formatEdge));
  }

  lines.push("callers:");
  if (neighborhood.callers.length === 0) {
    lines.push("- (none)");
  } else {
    lines.push(...neighborhood.callers.map(formatEdge));
  }

  lines.push("related:");
  if (neighborhood.related.length === 0) {
    lines.push("- (none)");
  } else {
    lines.push(
      ...neighborhood.related.map((edge) => `- ${edge.file}:${edge.line} (${edge.name})`)
    );
  }

  return lines;
}

export function neighborhoodLinesForPointer(
  index: WorkspaceIndex | undefined,
  filePath: string,
  line: number,
  selectedText?: string
): string[] {
  if (!index) {
    return [];
  }
  const neighborhood = lookupNeighborhood(index, filePath, line, selectedText);
  return neighborhood ? formatNeighborhoodLines(neighborhood) : [];
}
