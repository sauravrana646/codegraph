#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@codegraph/core");
async function main() {
    const [, , rootPath, filePath, lineArg, ...selectedTextParts] = process.argv;
    if (!rootPath || !filePath || !lineArg) {
        console.error("Usage: codegraph-runtime <workspace-root> <file-path> <line> [selectedText]");
        process.exitCode = 1;
        return;
    }
    const line = Number.parseInt(lineArg, 10);
    if (!Number.isInteger(line) || line < 1) {
        console.error(`Invalid line number: ${lineArg}`);
        process.exitCode = 1;
        return;
    }
    const result = await (0, core_1.buildSelectionContext)({
        rootPath,
        filePath,
        line,
        selectedText: selectedTextParts.join(" ") || undefined
    });
    console.log(JSON.stringify(result, null, 2));
}
void main();
//# sourceMappingURL=index.js.map