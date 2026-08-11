import * as vscode from "vscode";

import { buildSelectionContext } from "@codegraph/core";

let outputChannel: vscode.OutputChannel | undefined;
let panel: vscode.WebviewPanel | undefined;

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

    const summaryText = selectedText
      ? `Prepared local context for "${selectedText}" (tier ${result.metadata.capabilityTier}).`
      : `Prepared local context for ${filePath}:${line} (tier ${result.metadata.capabilityTier}).`;

    panel ??= vscode.window.createWebviewPanel(
      "codegraph.explanation",
      "Codegraph Explanation",
      vscode.ViewColumn.Beside,
      {
        enableFindWidget: true
      }
    );
    panel.title = selectedText ? `Codegraph: ${selectedText}` : `Codegraph: ${filePath}:${line}`;
    panel.webview.html = renderExplanationHtml(filePath, line, result);
    panel.reveal(vscode.ViewColumn.Beside, true);

    void vscode.window.showInformationMessage(summaryText);
  });

  context.subscriptions.push(disposable, getOutputChannel());
}

export function deactivate(): void {
  outputChannel?.dispose();
  outputChannel = undefined;
  panel?.dispose();
  panel = undefined;
}

function escapeHtml(value: string | undefined): string {
  return (value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderList(items: string[]): string {
  return items.length > 0
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "<p>None.</p>";
}

function renderSourceList(
  items: Array<{ file: string; line: number; excerpt?: string }>
): string {
  if (items.length === 0) {
    return "<p>No source locations available.</p>";
  }

  return `
    <ul>
      ${items
        .map(
          (item) => `
            <li>
              <strong>${escapeHtml(item.file)}:${item.line}</strong>
              ${item.excerpt ? `<pre>${escapeHtml(item.excerpt)}</pre>` : ""}
            </li>
          `
        )
        .join("")}
    </ul>
  `;
}

function renderExplanationHtml(
  filePath: string,
  line: number,
  result: Awaited<ReturnType<typeof buildSelectionContext>>
): string {
  const inferredClaims = result.explanation.inferredClaims ?? [];

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <style>
        body {
          font-family: var(--vscode-font-family);
          color: var(--vscode-editor-foreground);
          padding: 16px;
          line-height: 1.5;
        }
        h1, h2, h3 {
          line-height: 1.2;
        }
        .muted {
          color: var(--vscode-descriptionForeground);
        }
        .pill {
          display: inline-block;
          padding: 2px 8px;
          margin-right: 8px;
          border-radius: 999px;
          background: var(--vscode-badge-background);
          color: var(--vscode-badge-foreground);
        }
        pre {
          white-space: pre-wrap;
          background: var(--vscode-textCodeBlock-background);
          padding: 10px;
          border-radius: 6px;
          overflow-x: auto;
        }
        section {
          margin-top: 20px;
        }
      </style>
    </head>
    <body>
      <h1>Codegraph Explanation</h1>
      <p class="muted">${escapeHtml(filePath)}:${line}</p>
      <p>
        <span class="pill">Tier ${result.metadata.capabilityTier}</span>
        <span class="pill">Confidence ${result.metadata.confidence.toFixed(2)}</span>
        <span class="pill">Source ${escapeHtml(result.metadata.source)}</span>
      </p>

      <section>
        <h2>Summary</h2>
        <p>${escapeHtml(result.explanation.summary)}</p>
      </section>

      <section>
        <h2>What it does</h2>
        <p>${escapeHtml(result.explanation.whatItDoes)}</p>
      </section>

      <section>
        <h2>How it works</h2>
        <pre>${escapeHtml(result.explanation.howItWorks)}</pre>
      </section>

      <section>
        <h2>Why it exists</h2>
        <p>${escapeHtml(result.explanation.whyItExists)}</p>
      </section>

      <section>
        <h2>In this codebase</h2>
        <pre>${escapeHtml(result.explanation.codebaseUsage)}</pre>
      </section>

      <section>
        <h2>Sources</h2>
        ${renderSourceList(result.explanation.sources)}
      </section>

      <section>
        <h2>Inferred claims</h2>
        ${
          inferredClaims.length > 0
            ? inferredClaims
                .map(
                  (claim) => `
                    <div>
                      <p><strong>${escapeHtml(claim.claim)}</strong> (${escapeHtml(claim.confidence)})</p>
                      ${renderSourceList(claim.evidence)}
                    </div>
                  `
                )
                .join("")
            : "<p>No inferred claims.</p>"
        }
      </section>

      <section>
        <h2>Caveats</h2>
        ${renderList(result.explanation.caveats ?? [])}
      </section>
    </body>
  </html>`;
}
