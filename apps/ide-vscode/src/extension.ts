import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

import { buildSelectionContext, findDefinition, findUsages } from "@codegraph/core";
import { enrichSelectionContext, type EnrichmentMetadata } from "@codegraph/model-gateway";
import { redactSecrets } from "@codegraph/security";
import { normalizeWorkspacePath } from "@codegraph/workspace";

type SelectionContext = Awaited<ReturnType<typeof buildSelectionContext>>;
type EnrichedSelectionContext = SelectionContext & { enrichment?: EnrichmentMetadata };

interface CodeUnderstandingSession {
  request: {
    rootPath: string;
    filePath: string;
    line: number;
    selectedText?: string;
  };
  result: EnrichedSelectionContext;
}

type SourceLike = { file: string; line: number; excerpt?: string };

let outputChannel: vscode.OutputChannel | undefined;
let panel: vscode.WebviewPanel | undefined;
let currentSession: CodeUnderstandingSession | undefined;
let panelMessageHooked = false;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Codegraph");
  }

  return outputChannel;
}

export function activate(context: vscode.ExtensionContext): void {
  const bundledParser = path.join(context.extensionPath, "python_symbol_parser.py");
  const monorepoParser = path.join(
    context.extensionPath,
    "..",
    "..",
    "packages",
    "language-intelligence",
    "python_symbol_parser.py"
  );
  process.env.CODEGRAPH_PYTHON_PARSER = fs.existsSync(bundledParser)
    ? bundledParser
    : monorepoParser;

  const explainCommand = vscode.commands.registerCommand("codegraph.explainSelection", async () => {
    const request = getActiveRequest();

    if (!request) {
      return;
    }

    await runExplainSelection(context, request);
  });

  const definitionCommand = vscode.commands.registerCommand("codegraph.findDefinition", async () => {
    const request = getActiveRequest() ?? currentSession?.request;

    if (!request) {
      void vscode.window.showWarningMessage("Codegraph needs an active editor or an existing session.");
      return;
    }

    const definitions = await findDefinition(request);

    if (definitions.length === 0) {
      void vscode.window.showInformationMessage("Codegraph did not find a matching definition.");
      return;
    }

    await openFromCandidates(request.rootPath, definitions, "definition");
  });

  const usagesCommand = vscode.commands.registerCommand("codegraph.findUsages", async () => {
    const request = getActiveRequest() ?? currentSession?.request;

    if (!request) {
      void vscode.window.showWarningMessage("Codegraph needs an active editor or an existing session.");
      return;
    }

    const usages = await findUsages(request);

    if (usages.length === 0) {
      void vscode.window.showInformationMessage("Codegraph did not find any usages.");
      return;
    }

    await openFromCandidates(request.rootPath, usages, "usage");
  });

  context.subscriptions.push(explainCommand, definitionCommand, usagesCommand, getOutputChannel());
}

export function deactivate(): void {
  outputChannel?.dispose();
  outputChannel = undefined;
  panel?.dispose();
  panel = undefined;
  currentSession = undefined;
  panelMessageHooked = false;
}

function getActiveRequest():
  | {
      rootPath: string;
      filePath: string;
      line: number;
      selectedText?: string;
    }
  | undefined {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    void vscode.window.showWarningMessage("Codegraph needs an active editor.");
    return undefined;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);

  if (!workspaceFolder) {
    void vscode.window.showWarningMessage("Codegraph could not determine the current workspace folder.");
    return undefined;
  }

  const selection = editor.selection;

  return {
    rootPath: workspaceFolder.uri.fsPath,
    filePath: vscode.workspace.asRelativePath(editor.document.uri, false),
    line: selection.active.line + 1,
    selectedText: editor.document.getText(selection).trim() || undefined
  };
}

function enrichmentConfig(): {
  enabled: boolean;
  apiKey?: string;
  baseUrl: string;
  model: string;
} {
  const cfg = vscode.workspace.getConfiguration("codegraph.enrichment");
  const apiKey = cfg.get<string>("apiKey")?.trim() || process.env.OPENAI_API_KEY || process.env.CODEGRAPH_API_KEY;

  return {
    enabled: Boolean(cfg.get<boolean>("enabled")),
    apiKey: apiKey || undefined,
    baseUrl: String(cfg.get<string>("baseUrl") ?? "https://api.openai.com/v1"),
    model: String(cfg.get<string>("model") ?? "gpt-4o-mini")
  };
}

function enrichmentStatusLabel(enrichment?: EnrichmentMetadata): string {
  if (!enrichment) {
    return "off";
  }

  if (enrichment.used) {
    return enrichment.model ? `ok:${enrichment.model}` : "ok";
  }

  if (enrichment.error?.includes("not requested")) {
    return "off";
  }

  if (enrichment.error?.includes("not configured") || enrichment.error?.includes("API_KEY")) {
    return "missing_api_key";
  }

  return enrichment.error ? "failed" : "skipped";
}

async function runExplainSelection(
  context: vscode.ExtensionContext,
  request: { rootPath: string; filePath: string; line: number; selectedText?: string }
): Promise<void> {
  const deterministic = await buildSelectionContext(request);
  const enrichCfg = enrichmentConfig();

  if (enrichCfg.enabled && !enrichCfg.apiKey) {
    void vscode.window.showWarningMessage(
      "Codegraph enrichment is enabled but no API key is configured (codegraph.enrichment.apiKey or OPENAI_API_KEY)."
    );
  }

  const result = await enrichSelectionContext(deterministic, {
    enabled: enrichCfg.enabled,
    trustProviderConfig: true,
    provider: {
      apiKey: enrichCfg.apiKey,
      baseUrl: enrichCfg.baseUrl,
      model: enrichCfg.model
    }
  });

  currentSession = { request, result };

  const channel = getOutputChannel();
  channel.clear();
  channel.appendLine("Codegraph selection context");
  channel.appendLine(
    redactSecrets(
      JSON.stringify(
        {
          metadata: result.metadata,
          enrichment: result.enrichment,
          explanation: {
            summary: result.explanation.summary,
            confidence: result.explanation.confidence,
            sources: result.explanation.sources
          }
        },
        null,
        2
      )
    )
  );
  channel.appendLine(`enrichment=${enrichmentStatusLabel(result.enrichment)}`);

  ensurePanel(context);

  if (!panel) {
    return;
  }

  panel.title = request.selectedText ? `Codegraph: ${request.selectedText}` : `Codegraph: ${request.filePath}:${request.line}`;
  panel.webview.html = renderExplanationHtml(request.filePath, request.line, result);
  panel.reveal(vscode.ViewColumn.Beside, true);

  const enrichmentLabel = enrichmentStatusLabel(result.enrichment);
  const summaryText = request.selectedText
    ? `Prepared local context for "${request.selectedText}" (tier ${result.metadata.capabilityTier}, enrichment ${enrichmentLabel}).`
    : `Prepared local context for ${request.filePath}:${request.line} (tier ${result.metadata.capabilityTier}, enrichment ${enrichmentLabel}).`;

  void vscode.window.showInformationMessage(summaryText);
}

function ensurePanel(context: vscode.ExtensionContext): void {
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      "codegraph.explanation",
      "Codegraph Explanation",
      vscode.ViewColumn.Beside,
      {
        enableFindWidget: true,
        enableScripts: true
      }
    );
    panel.onDidDispose(() => {
      panel = undefined;
      panelMessageHooked = false;
    }, undefined, context.subscriptions);
  }

  if (!panelMessageHooked) {
    panel.webview.onDidReceiveMessage((message) => {
      void handlePanelMessage(message);
    }, undefined, context.subscriptions);
    panelMessageHooked = true;
  }
}

async function handlePanelMessage(message: unknown): Promise<void> {
  if (!message || typeof message !== "object") {
    return;
  }

  const parsed = message as { type?: string; file?: string; line?: number };

  if (parsed.type === "openSource" && parsed.file && currentSession) {
    await openSourceLocation(currentSession.request.rootPath, parsed.file, parsed.line ?? 1);
    return;
  }

  if (parsed.type === "findDefinition") {
    await vscode.commands.executeCommand("codegraph.findDefinition");
    return;
  }

  if (parsed.type === "findUsages") {
    await vscode.commands.executeCommand("codegraph.findUsages");
  }
}

function escapeHtml(value: string | undefined): string {
  return (value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value: string | undefined): string {
  return escapeHtml(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function renderList(items: string[]): string {
  return items.length > 0
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "<p>None.</p>";
}

function renderSourceList(items: SourceLike[]): string {
  if (items.length === 0) {
    return "<p>No source locations available.</p>";
  }

  return `
    <ul>
      ${items
        .map(
          (item) => `
            <li>
              <button class="source-link" data-file="${escapeAttribute(item.file)}" data-line="${item.line}">
                ${escapeHtml(item.file)}:${item.line}
              </button>
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
  result: EnrichedSelectionContext
): string {
  const inferredClaims = result.explanation.inferredClaims ?? [];
  const enrichmentLabel = enrichmentStatusLabel(result.enrichment);
  const enrichmentNote = result.enrichment?.used
    ? `<p class="muted">Model enrichment applied (${escapeHtml(result.enrichment.provider ?? "provider")} / ${escapeHtml(result.enrichment.model ?? "model")}). Sources remain deterministic.</p>`
    : result.enrichment?.error && enrichmentLabel !== "off"
      ? `<p class="muted">Enrichment ${escapeHtml(enrichmentLabel)}: ${escapeHtml(result.enrichment.error)}</p>`
      : `<p class="muted">Enrichment ${escapeHtml(enrichmentLabel)}. Enable via Codegraph settings when desired.</p>`;

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
        .actions {
          display: flex;
          gap: 8px;
          margin-top: 12px;
        }
        .action-button {
          border: 1px solid var(--vscode-button-border, transparent);
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border-radius: 6px;
          padding: 6px 10px;
          cursor: pointer;
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
        .source-link {
          border: none;
          background: transparent;
          color: var(--vscode-textLink-foreground);
          cursor: pointer;
          padding: 0;
          font: inherit;
          text-decoration: underline;
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
        <span class="pill">Enrichment ${escapeHtml(enrichmentLabel)}</span>
      </p>
      ${enrichmentNote}
      <div class="actions">
        <button class="action-button" data-action="findDefinition">Find Definition</button>
        <button class="action-button" data-action="findUsages">Find Usages</button>
      </div>

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
      <script>
        const vscode = acquireVsCodeApi();
        document.querySelectorAll(".source-link").forEach((node) => {
          node.addEventListener("click", () => {
            vscode.postMessage({
              type: "openSource",
              file: node.getAttribute("data-file"),
              line: Number(node.getAttribute("data-line") || "1")
            });
          });
        });
        document.querySelectorAll(".action-button").forEach((node) => {
          node.addEventListener("click", () => {
            vscode.postMessage({
              type: node.getAttribute("data-action")
            });
          });
        });
      </script>
    </body>
  </html>`;
}

async function openSourceLocation(rootPath: string, relativeFilePath: string, line: number): Promise<void> {
  let absolutePath: string;

  try {
    absolutePath = normalizeWorkspacePath(rootPath, relativeFilePath);
  } catch {
    void vscode.window.showWarningMessage("Codegraph refused to open a path outside the workspace.");
    return;
  }

  const uri = vscode.Uri.file(absolutePath);
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false
  });
  const targetLine = Math.max(0, line - 1);
  const position = new vscode.Position(targetLine, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

async function openFromCandidates(rootPath: string, items: SourceLike[], noun: string): Promise<void> {
  if (items.length === 1) {
    const item = items[0];

    if (item) {
      await openSourceLocation(rootPath, item.file, item.line);
    }

    return;
  }

  const picked = await vscode.window.showQuickPick(
    items.map((item) => ({
      label: `${item.file}:${item.line}`,
      description: noun,
      detail: item.excerpt,
      item
    })),
    {
      placeHolder: `Select a ${noun} to open`
    }
  );

  if (picked) {
    await openSourceLocation(rootPath, picked.item.file, picked.item.line);
  }
}
