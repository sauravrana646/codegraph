export const INDEX_VERSION = 4;

export type CallResolveVia = "same-file" | "import" | "unique-name";
export type ParseSource = "python_ast" | "regex_fallback" | "go_ast" | "go_regex_fallback";
export type IndexedLanguage = "python" | "go";

export interface GraphEdge {
  file: string;
  line: number;
  name: string;
  kind: "function" | "class";
  confidence: number;
  via: CallResolveVia;
}

export interface IndexedImport {
  kind: "import" | "from";
  module: string;
  names: string[];
  alias?: string | null;
  line: number;
}

export interface IndexedCallSite {
  name: string;
  line: number;
  receiver?: string;
}

export interface IndexedSymbol {
  name: string;
  kind: "function" | "class";
  line: number;
  endLine: number;
  bases: string[];
  members: string[];
  parentName?: string;
  signature?: string;
  docstring?: string;
  calls: IndexedCallSite[];
  callees: GraphEdge[];
  callers: GraphEdge[];
}

export interface IndexedFile {
  relativePath: string;
  contentHash: string;
  mtimeMs: number;
  size: number;
  language: IndexedLanguage;
  parseSource: ParseSource;
  symbols: IndexedSymbol[];
  imports: IndexedImport[];
}

export interface WorkspaceIndex {
  version: number;
  workspaceId: string;
  rootPath: string;
  updatedAt: number;
  files: Record<string, IndexedFile>;
}

export interface SymbolNeighborhood {
  symbol: string;
  kind: "function" | "class";
  file: string;
  line: number;
  endLine: number;
  signature?: string;
  docstring?: string;
  definitions: GraphEdge[];
  callees: GraphEdge[];
  callers: GraphEdge[];
  related: GraphEdge[];
}
