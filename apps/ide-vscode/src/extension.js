"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const core_1 = require("@codegraph/core");
let outputChannel;
function getOutputChannel() {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel("Codegraph");
    }
    return outputChannel;
}
function activate(context) {
    const disposable = vscode.commands.registerCommand("codegraph.explainSelection", async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            void vscode.window.showWarningMessage("Codegraph needs an active editor to explain a selection.");
            return;
        }
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (!workspaceFolder) {
            void vscode.window.showWarningMessage("Codegraph could not determine the current workspace folder.");
            return;
        }
        const selection = editor.selection;
        const selectedText = editor.document.getText(selection).trim() || undefined;
        const filePath = vscode.workspace.asRelativePath(editor.document.uri, false);
        const line = selection.active.line + 1;
        const result = await (0, core_1.buildSelectionContext)({
            rootPath: workspaceFolder.uri.fsPath,
            filePath,
            line,
            selectedText
        });
        const channel = getOutputChannel();
        channel.clear();
        channel.appendLine("Codegraph selection context");
        channel.appendLine(JSON.stringify(result, null, 2));
        channel.show(true);
        const summaryText = selectedText
            ? `Prepared local context for "${selectedText}" (tier ${result.metadata.capabilityTier}).`
            : `Prepared local context for ${filePath}:${line} (tier ${result.metadata.capabilityTier}).`;
        void vscode.window.showInformationMessage(summaryText);
    });
    context.subscriptions.push(disposable, getOutputChannel());
}
function deactivate() {
    outputChannel?.dispose();
    outputChannel = undefined;
}
//# sourceMappingURL=extension.js.map