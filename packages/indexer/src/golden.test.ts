import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { parseGoFile, parsePythonFile } from "@codegraph/language-intelligence";

import { attachCallGraph, lookupNeighborhood } from "./graph";
import { ensureWorkspaceIndex } from "./index";
import { INDEX_VERSION, type IndexedSymbol, type WorkspaceIndex } from "./types";

describe("golden examples/two_classes.py", () => {
  it("qualifies methods and binds self receivers", async () => {
    const filePath = path.resolve(__dirname, "../../../examples/two_classes.py");
    const parsed = await parsePythonFile(filePath);
    assert.equal(parsed.source, "python_ast");

    const symbols: IndexedSymbol[] = parsed.symbols.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.line,
      endLine: symbol.endLine,
      bases: symbol.bases ?? [],
      members: (symbol.members ?? []).map((member) => member.name),
      parentName: symbol.parentName ?? undefined,
      signature: symbol.signature,
      docstring: symbol.docstring ?? undefined,
      calls: (symbol.calls ?? []).map((call) => ({
        name: call.name,
        line: call.line,
        ...(call.receiver ? { receiver: call.receiver } : {})
      })),
      callees: [],
      callers: []
    }));

    const index: WorkspaceIndex = {
      version: INDEX_VERSION,
      workspaceId: "golden",
      rootPath: path.dirname(filePath),
      updatedAt: 1,
      files: {
        "two_classes.py": {
          relativePath: "two_classes.py",
          contentHash: "golden",
          mtimeMs: 1,
          size: 1,
          language: "python",
          parseSource: parsed.source,
          symbols,
          imports: []
        }
      }
    };

    attachCallGraph(index);
    const neighborhood = lookupNeighborhood(index, "two_classes.py", 18, "save");
    assert.ok(neighborhood);
    assert.match(neighborhood.symbol, /PaymentService\.save|save/);
    assert.ok(
      neighborhood.callees.some((edge) => edge.name.includes("_send")),
      JSON.stringify(neighborhood.callees)
    );

    const policySave = symbols.find((item) => item.name === "save" && item.parentName === "RetryPolicy");
    assert.ok(policySave?.parentName === "RetryPolicy");
    const nested = symbols.find((item) => item.name === "nested");
    assert.ok(nested, "nested function should be indexed with its own calls");
  });
});

describe("golden examples/go-mini", () => {
  it("parses Go methods and resolves package imports", async () => {
    const root = path.resolve(__dirname, "../../../examples/go-mini");
    const serverPath = path.join(root, "internal/server/server.go");
    const parsed = await parseGoFile(serverPath);
    assert.equal(parsed.source, "go_ast");

    const handle = parsed.symbols.find((item) => item.name === "Handle" && item.parentName === "Server");
    assert.ok(handle, "Server.Handle should be indexed with parentName");
    assert.ok(handle.calls?.some((call) => call.name === "Helper" && call.receiver === "util"));
    assert.ok(handle.calls?.some((call) => call.name === "log" && call.receiver === "s"));

    const result = await ensureWorkspaceIndex(root, { force: true });
    assert.ok(result.total >= 3);
    assert.equal(result.index.version, INDEX_VERSION);

    const neighborhood = lookupNeighborhood(
      result.index,
      "internal/server/server.go",
      (handle.line ?? 1) + 1,
      "Handle"
    );
    assert.ok(neighborhood);
    assert.match(neighborhood.symbol, /Server\.Handle|Handle/);
    assert.ok(
      neighborhood.callees.some((edge) => edge.name.includes("Helper") || edge.name.includes("log")),
      JSON.stringify(neighborhood.callees)
    );
  });
});
