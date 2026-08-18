import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeWorkspacePath } from "./index";

describe("normalizeWorkspacePath", () => {
  it("rejects parent traversal", () => {
    assert.throws(() => normalizeWorkspacePath("/workspace", "../etc/passwd"), /Path escapes workspace root/);
  });

  it("accepts a nested relative file", () => {
    const resolved = normalizeWorkspacePath("/workspace", "examples/demo.py");
    assert.equal(resolved, "/workspace/examples/demo.py");
  });
});
