export const INDEX_VERSION = 2;

export type CallResolveVia = "same-file" | "import" | "unique-name";

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
}

export interface IndexedSymbol {
  name: string;
  kind: "function" | "class";
  line: number;
  endLine: number;
  bases: string[];
  members: string[];
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
