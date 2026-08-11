"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSelectionContext = buildSelectionContext;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const security_1 = require("@codegraph/security");
const workspace_1 = require("@codegraph/workspace");
function languageFromFile(filePath) {
    if (filePath.endsWith(".py")) {
        return "python";
    }
    if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
        return "typescript";
    }
    if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) {
        return "javascript";
    }
    return undefined;
}
function buildExcerpt(lines, lineNumber) {
    const startLine = Math.max(0, lineNumber - 3);
    const endLine = Math.min(lines.length, lineNumber + 2);
    return lines.slice(startLine, endLine).join("\n");
}
function createSourceReference(file, line, excerpt) {
    return { file, line, excerpt };
}
async function buildSelectionContext(request) {
    const workspace = (0, workspace_1.createWorkspaceSummary)(request.rootPath);
    const absoluteFilePath = (0, workspace_1.normalizeWorkspacePath)(workspace.rootPath, request.filePath);
    const file = node_path_1.default.relative(workspace.rootPath, absoluteFilePath);
    const content = await promises_1.default.readFile(absoluteFilePath, "utf8");
    const lines = content.split(/\r?\n/);
    const excerpt = (0, security_1.redactSecrets)(buildExcerpt(lines, request.line));
    const target = {
        workspaceId: workspace.id,
        file,
        line: request.line,
        selectedText: request.selectedText
    };
    return {
        workspace,
        context: {
            workspace,
            target,
            definitions: [createSourceReference(file, request.line, excerpt)],
            references: [],
            relatedFiles: [],
            documentation: [],
            configuration: []
        },
        metadata: {
            source: "text",
            capabilityTier: languageFromFile(file) === "python" ? 1 : 0,
            confidence: request.selectedText ? 0.55 : 0.35
        }
    };
}
//# sourceMappingURL=index.js.map