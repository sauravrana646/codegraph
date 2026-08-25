import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

import {
  attachCallGraph,
  findIndexedDefinitions,
  lookupNeighborhood,
  resolveGoPackageFiles,
  resolvePythonModuleFiles
} from "./graph";
import { INDEX_VERSION, type IndexedFile, type IndexedSymbol, type WorkspaceIndex } from "./types";

function symbol(partial: Partial<IndexedSymbol> & Pick<IndexedSymbol, "name" | "kind" | "line">): IndexedSymbol {
  return {
    endLine: partial.endLine ?? partial.line + 4,
    bases: [],
    members: [],
    calls: [],
    callees: [],
    callers: [],
    ...partial
  };
}

function file(
  relativePath: string,
  symbols: IndexedSymbol[],
  imports: IndexedFile["imports"] = [],
  language: IndexedFile["language"] = relativePath.endsWith(".go") ? "go" : "python"
): IndexedFile {
  return {
    relativePath,
    contentHash: "x",
    mtimeMs: 1,
    size: 1,
    language,
    parseSource: language === "go" ? "go_ast" : "python_ast",
    symbols,
    imports
  };
}

function index(files: Record<string, IndexedFile>): WorkspaceIndex {
  return {
    version: INDEX_VERSION,
    workspaceId: "test",
    rootPath: "/repo",
    updatedAt: 1,
    files
  };
}

describe("resolvePythonModuleFiles", () => {
  it("resolves a relative import to an indexed file", () => {
    const graph = index({
      "pkg/a.py": file("pkg/a.py", []),
      "pkg/b.py": file("pkg/b.py", [])
    });
    assert.deepEqual(resolvePythonModuleFiles(graph, "pkg/a.py", ".b"), ["pkg/b.py"]);
  });

  it("resolves an absolute module path when present", () => {
    const graph = index({
      "payments.py": file("payments.py", [])
    });
    assert.deepEqual(resolvePythonModuleFiles(graph, "app.py", "payments"), ["payments.py"]);
  });
});

describe("call resolution", () => {
  it("resolves same-file unique names at high confidence", () => {
    const graph = index({
      "mod.py": file("mod.py", [
        symbol({
          name: "helper",
          kind: "function",
          line: 1
        }),
        symbol({
          name: "run",
          kind: "function",
          line: 10,
          calls: [{ name: "helper", line: 11 }]
        })
      ])
    });
    attachCallGraph(graph);
    const run = graph.files["mod.py"]?.symbols.find((item) => item.name === "run");
    assert.equal(run?.callees[0]?.name, "helper");
    assert.equal(run?.callees[0]?.via, "same-file");
    assert.equal(run?.callees[0]?.confidence, 0.95);
  });

  it("resolves import-scoped names", () => {
    const graph = index({
      "app.py": file(
        "app.py",
        [
          symbol({
            name: "main",
            kind: "function",
            line: 3,
            calls: [{ name: "charge", line: 4 }]
          })
        ],
        [{ kind: "from", module: "payments", names: ["charge"], line: 1 }]
      ),
      "payments.py": file("payments.py", [symbol({ name: "charge", kind: "function", line: 1 })])
    });
    attachCallGraph(graph);
    const main = graph.files["app.py"]?.symbols.find((item) => item.name === "main");
    assert.equal(main?.callees[0]?.file, "payments.py");
    assert.equal(main?.callees[0]?.via, "import");
  });

  it("uses unique-name only when a single top-level definition exists", () => {
    const graph = index({
      "a.py": file("a.py", [
        symbol({ name: "unique_fn", kind: "function", line: 1 }),
        symbol({ name: "caller", kind: "function", line: 8, calls: [{ name: "unique_fn", line: 9 }] })
      ]),
      "b.py": file("b.py", [symbol({ name: "other", kind: "function", line: 1 })])
    });
    attachCallGraph(graph);
    const caller = graph.files["a.py"]?.symbols.find((item) => item.name === "caller");
    assert.equal(caller?.callees[0]?.via, "same-file");
  });

  it("skips builtins", () => {
    const graph = index({
      "mod.py": file("mod.py", [
        symbol({ name: "run", kind: "function", line: 1, calls: [{ name: "print", line: 2 }, { name: "len", line: 3 }] })
      ])
    });
    attachCallGraph(graph);
    assert.equal(graph.files["mod.py"]?.symbols[0]?.callees.length, 0);
  });

  it("binds self.save to the enclosing class method", () => {
    const graph = index({
      "svc.py": file("svc.py", [
        symbol({ name: "RetryPolicy", kind: "class", line: 1, endLine: 8 }),
        symbol({
          name: "save",
          kind: "function",
          line: 4,
          endLine: 6,
          parentName: "RetryPolicy",
          calls: [{ name: "_flush", line: 5, receiver: "self" }]
        }),
        symbol({ name: "_flush", kind: "function", line: 7, endLine: 8, parentName: "RetryPolicy" }),
        symbol({ name: "PaymentService", kind: "class", line: 11, endLine: 20 }),
        symbol({
          name: "save",
          kind: "function",
          line: 14,
          endLine: 17,
          parentName: "PaymentService",
          calls: [{ name: "_send", line: 15, receiver: "self" }]
        }),
        symbol({ name: "_send", kind: "function", line: 18, endLine: 20, parentName: "PaymentService" })
      ])
    });
    attachCallGraph(graph);
    const policySave = graph.files["svc.py"]?.symbols.find(
      (item) => item.name === "save" && item.parentName === "RetryPolicy"
    );
    const paymentSave = graph.files["svc.py"]?.symbols.find(
      (item) => item.name === "save" && item.parentName === "PaymentService"
    );
    assert.equal(policySave?.callees[0]?.name, "RetryPolicy._flush");
    assert.equal(paymentSave?.callees[0]?.name, "PaymentService._send");
  });

  it("does not treat two __init__ methods as a unique-name hit", () => {
    const defs = findIndexedDefinitions(
      index({
        "svc.py": file("svc.py", [
          symbol({ name: "__init__", kind: "function", line: 2, parentName: "RetryPolicy" }),
          symbol({ name: "__init__", kind: "function", line: 8, parentName: "PaymentService" })
        ])
      }),
      "__init__"
    );
    assert.equal(defs.length, 0);
  });
});

describe("lookupNeighborhood", () => {
  it("returns callees for a method pointer", () => {
    const graph = index({
      "svc.py": file("svc.py", [
        symbol({
          name: "save",
          kind: "function",
          line: 14,
          endLine: 17,
          parentName: "PaymentService",
          callees: [
            {
              file: "svc.py",
              line: 18,
              name: "PaymentService._send",
              kind: "function",
              confidence: 0.95,
              via: "same-file"
            }
          ]
        }),
        symbol({ name: "_send", kind: "function", line: 18, endLine: 20, parentName: "PaymentService" })
      ])
    });
    const neighborhood = lookupNeighborhood(graph, "svc.py", 15, "save");
    assert.equal(neighborhood?.callees[0]?.name, "PaymentService._send");
  });
});

describe("resolveGoPackageFiles", () => {
  it("maps module import paths to package files using go.mod", () => {
    const root = "/tmp/codegraph-go-resolve-test";
    fs.mkdirSync(`${root}/cmd/app`, { recursive: true });
    fs.mkdirSync(`${root}/internal/util`, { recursive: true });
    fs.writeFileSync(`${root}/go.mod`, "module example.com/demo\n\ngo 1.22\n");
    fs.writeFileSync(`${root}/internal/util/helper.go`, "package util\n");
    fs.writeFileSync(`${root}/cmd/app/main.go`, "package main\n");

    const graph = index({
      "cmd/app/main.go": file("cmd/app/main.go", []),
      "internal/util/helper.go": file("internal/util/helper.go", [
        symbol({ name: "Helper", kind: "function", line: 3 })
      ])
    });
    graph.rootPath = root;

    assert.deepEqual(resolveGoPackageFiles(graph, "cmd/app/main.go", "example.com/demo/internal/util"), [
      "internal/util/helper.go"
    ]);
  });
});

describe("go call resolution", () => {
  it("binds method receivers on the enclosing type", () => {
    const graph = index({
      "server.go": file("server.go", [
        symbol({ name: "Server", kind: "class", line: 1, endLine: 20 }),
        symbol({
          name: "Handle",
          kind: "function",
          line: 5,
          endLine: 10,
          parentName: "Server",
          calls: [{ name: "log", line: 6, receiver: "s" }]
        }),
        symbol({ name: "log", kind: "function", line: 12, endLine: 14, parentName: "Server" })
      ])
    });
    attachCallGraph(graph);
    const handle = graph.files["server.go"]?.symbols.find((item) => item.name === "Handle");
    assert.equal(handle?.callees[0]?.name, "Server.log");
    assert.equal(handle?.callees[0]?.via, "same-file");
  });

  it("resolves import-scoped package functions", () => {
    const root = "/tmp/codegraph-go-import-test";
    fs.mkdirSync(`${root}/internal/util`, { recursive: true });
    fs.writeFileSync(`${root}/go.mod`, "module example.com/demo\n\ngo 1.22\n");

    const graph = index({
      "cmd/app/main.go": file(
        "cmd/app/main.go",
        [
          symbol({
            name: "main",
            kind: "function",
            line: 8,
            calls: [{ name: "Helper", line: 9, receiver: "util" }]
          })
        ],
        [{ kind: "import", module: "example.com/demo/internal/util", names: ["util"], alias: null, line: 3 }]
      ),
      "internal/util/helper.go": file("internal/util/helper.go", [
        symbol({ name: "Helper", kind: "function", line: 3 })
      ])
    });
    graph.rootPath = root;
    attachCallGraph(graph);
    const main = graph.files["cmd/app/main.go"]?.symbols.find((item) => item.name === "main");
    assert.equal(main?.callees[0]?.file, "internal/util/helper.go");
    assert.equal(main?.callees[0]?.via, "import");
  });
});
