import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { FileTooLargeError, readContainedFile } from "./index";
import { normalizeWorkspacePath } from "@codegraph/workspace";

describe("containment", () => {
  it("rejects paths that escape the workspace root", () => {
    assert.throws(() => normalizeWorkspacePath("/tmp/workspace", "../secret"), /Path escapes/);
  });

  it("stats before reading when maxBytes is set", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-contained-"));
    const filePath = path.join(root, "big.py");
    await fs.writeFile(filePath, "print('hello')\n", "utf8");
    await assert.rejects(
      () => readContainedFile(root, "big.py", { maxBytes: 1 }),
      (error: unknown) => error instanceof FileTooLargeError
    );
  });
});
