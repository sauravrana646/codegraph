"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWorkspaceId = createWorkspaceId;
exports.createWorkspaceSummary = createWorkspaceSummary;
exports.normalizeWorkspacePath = normalizeWorkspacePath;
exports.toWorkspaceRelativePath = toWorkspaceRelativePath;
const node_crypto_1 = require("node:crypto");
const node_path_1 = __importDefault(require("node:path"));
function createWorkspaceId(rootPath) {
    return (0, node_crypto_1.createHash)("sha256").update(node_path_1.default.resolve(rootPath)).digest("hex").slice(0, 16);
}
function createWorkspaceSummary(rootPath) {
    const normalizedRoot = node_path_1.default.resolve(rootPath);
    return {
        id: createWorkspaceId(normalizedRoot),
        rootPath: normalizedRoot,
        name: node_path_1.default.basename(normalizedRoot)
    };
}
function normalizeWorkspacePath(rootPath, inputPath) {
    const normalizedRoot = node_path_1.default.resolve(rootPath);
    const resolvedPath = node_path_1.default.resolve(normalizedRoot, inputPath);
    const relativePath = node_path_1.default.relative(normalizedRoot, resolvedPath);
    if (relativePath === "" || (!relativePath.startsWith("..") && !node_path_1.default.isAbsolute(relativePath))) {
        return resolvedPath;
    }
    throw new Error(`Path escapes workspace root: ${inputPath}`);
}
function toWorkspaceRelativePath(rootPath, inputPath) {
    const normalizedRoot = node_path_1.default.resolve(rootPath);
    const resolvedPath = normalizeWorkspacePath(normalizedRoot, inputPath);
    return node_path_1.default.relative(normalizedRoot, resolvedPath) || ".";
}
//# sourceMappingURL=index.js.map