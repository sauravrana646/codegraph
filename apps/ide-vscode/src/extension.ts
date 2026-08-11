import * as vscode from "vscode";

import { buildSelectionContext } from "@codegraph/core";

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Codegraph");
  }

  return outputChannel;
}

export function activate(context: vscode.ExtensionContext): void {
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

    const result = await buildSelectionContext({
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

export function deactivate(): void {
  outputChannel?.dispose();
  outputChannel = undefined;
}
