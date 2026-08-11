"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanForSecrets = scanForSecrets;
exports.redactSecrets = redactSecrets;
exports.assertSymlinkContained = assertSymlinkContained;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const workspace_1 = require("@codegraph/workspace");
const SECRET_PATTERNS = [
    { kind: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
    { kind: "token", pattern: /\b(?:ghp|sk|api[_-]?key)[a-z0-9_\-]{8,}\b/gi },
    { kind: "password", pattern: /\bpassword\s*=\s*["'][^"']+["']/gi },
    { kind: "connection_string", pattern: /\b(?:postgres|mysql|mongodb):\/\/[^\s"'`]+/gi }
];
function scanForSecrets(content) {
    const matches = [];
    for (const { kind, pattern } of SECRET_PATTERNS) {
        for (const match of content.matchAll(pattern)) {
            if (match.index === undefined) {
                continue;
            }
            matches.push({
                kind,
                match: match[0],
                start: match.index,
                end: match.index + match[0].length
            });
        }
    }
    return matches.sort((left, right) => left.start - right.start);
}
function redactSecrets(content) {
    let redacted = content;
    for (const match of scanForSecrets(content).reverse()) {
        redacted = `${redacted.slice(0, match.start)}[REDACTED:${match.kind}]${redacted.slice(match.end)}`;
    }
    return redacted;
}
async function assertSymlinkContained(rootPath, inputPath) {
    const normalizedRoot = node_path_1.default.resolve(rootPath);
    const resolvedPath = (0, workspace_1.normalizeWorkspacePath)(normalizedRoot, inputPath);
    const realPath = await promises_1.default.realpath(resolvedPath).catch(() => resolvedPath);
    const relativeToRoot = node_path_1.default.relative(normalizedRoot, realPath);
    if (relativeToRoot.startsWith("..") || node_path_1.default.isAbsolute(relativeToRoot)) {
        throw new Error(`Symlink escapes workspace root: ${inputPath}`);
    }
    return (0, workspace_1.toWorkspaceRelativePath)(normalizedRoot, resolvedPath);
}
//# sourceMappingURL=index.js.map