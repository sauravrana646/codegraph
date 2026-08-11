import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

import { buildSelectionContext, findDefinition, findUsages } from "@codegraph/core";
import {
  applyEnrichmentText,
  buildAgentHandoffPrompt,
  buildHostEnrichmentPrompt,
  enrichSelectionContext,
  type EnrichmentMetadata,
  type EnrichedSelectionContext as GatewayEnrichedSelectionContext
} from "@codegraph/model-gateway";
import { redactSecrets } from "@codegraph/security";
import { normalizeWorkspacePath } from "@codegraph/workspace";

type SelectionContext = Awaited<ReturnType<typeof buildSelectionContext>>;
type EnrichedSelectionContext = GatewayEnrichedSelectionContext;

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

  const askAgentCommand = vscode.commands.registerCommand("codegraph.askCursorAgent", async () => {
    const request = getActiveRequest() ?? currentSession?.request;

    if (!request) {
      void vscode.window.showWarningMessage("Codegraph needs an active editor or an existing explanation session.");
      return;
    }

    await runAskCursorAgent(context, request);
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

  context.subscriptions.push(explainCommand, askAgentCommand, definitionCommand, usagesCommand, getOutputChannel());
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

function modelAccessConfig(): {
  useBuiltInAgent: boolean;
  useApiKeyProvider: boolean;
  preferIdeHost: boolean;
  apiKey?: string;
  baseUrl: string;
  model: string;
} {
  const access = vscode.workspace.getConfiguration("codegraph.modelAccess");
  const enrichment = vscode.workspace.getConfiguration("codegraph.enrichment");
  const apiKey =
    enrichment.get<string>("apiKey")?.trim() || process.env.OPENAI_API_KEY || process.env.CODEGRAPH_API_KEY;
  const legacyEnabled = Boolean(enrichment.get<boolean>("enabled"));

  return {
    useBuiltInAgent: access.get<boolean>("useBuiltInAgent") !== false,
    // New checkbox wins; legacy enrichment.enabled still turns API mode on if set.
    useApiKeyProvider: Boolean(access.get<boolean>("useApiKeyProvider")) || legacyEnabled,
    preferIdeHost: enrichment.get<boolean>("preferIdeHost") !== false,
    apiKey: apiKey || undefined,
    baseUrl: String(enrichment.get<string>("baseUrl") ?? "https://api.openai.com/v1"),
    model: String(enrichment.get<string>("model") ?? "gpt-4o-mini")
  };
}

function enrichmentStatusLabel(enrichment?: EnrichmentMetadata): string {
  if (!enrichment) {
    return "off";
  }

  if (enrichment.used) {
    return enrichment.model ? `ok:${enrichment.model}` : "ok";
  }

  if (enrichment.error?.includes("not requested") || enrichment.error?.includes("agent mode")) {
    return "agent";
  }

  if (enrichment.error?.includes("cursor-agent") || enrichment.error?.includes("Ask Cursor")) {
    return "agent";
  }

  if (enrichment.error?.includes("not configured") || enrichment.error?.includes("API_KEY")) {
    return "api_key_missing";
  }

  return enrichment.error ? "failed" : "skipped";
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }

  return text.trim();
}

async function enrichWithIdeHost(result: SelectionContext): Promise<EnrichedSelectionContext | undefined> {
  if (!vscode.lm?.selectChatModels) {
    return undefined;
  }

  const models = await vscode.lm.selectChatModels({});
  const model = models[0];

  if (!model) {
    return undefined;
  }

  const prompt = buildHostEnrichmentPrompt(result);
  const messages = [vscode.LanguageModelChatMessage.User(`${prompt.system}\n\n${prompt.user}`)];
  const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
  let text = "";

  for await (const chunk of response.text) {
    text += chunk;
  }

  return applyEnrichmentText(result, extractJsonObject(text), {
    provider: "ide-host",
    model: model.name || model.id
  });
}

async function maybeEnrichSelection(deterministic: SelectionContext): Promise<EnrichedSelectionContext> {
  const access = modelAccessConfig();

  // API key provider mode: enrich in-panel via IDE host models and/or API key.
  if (access.useApiKeyProvider) {
    if (access.preferIdeHost) {
      try {
        const hostEnriched = await enrichWithIdeHost(deterministic);
        if (hostEnriched?.enrichment.used) {
          return hostEnriched;
        }
      } catch {
        // Fall through to API key provider.
      }
    }

    if (!access.apiKey) {
      return {
        ...deterministic,
        enrichment: {
          used: false,
          error: "API key provider enabled but no API key is configured."
        }
      };
    }

    return enrichSelectionContext(deterministic, {
      enabled: true,
      trustProviderConfig: true,
      provider: {
        apiKey: access.apiKey,
        baseUrl: access.baseUrl,
        model: access.model
      }
    });
  }

  // Built-in agent mode (default): deterministic panel only; narrative via Cursor/Claude agent.
  return {
    ...deterministic,
    enrichment: {
      used: false,
      error: access.useBuiltInAgent
        ? "Built-in agent mode. Use Ask Cursor/Claude Agent for narrative (no API key)."
        : "Model access disabled. Enable Built-in Agent or API Key Provider in Codegraph settings."
    }
  };
}

function buildAskAgentQuery(result: EnrichedSelectionContext): string {
  return [
    "Use the Codegraph skill if available. Explain this selection using only the grounded facts below.",
    "Do not ask for API keys.",
    "",
    buildAgentHandoffPrompt(result)
  ].join("\n");
}

async function handOffToCursorAgent(prompt: string): Promise<void> {
  const candidates: Array<{ command: string; args?: unknown }> = [
    { command: "workbench.action.chat.open", args: { query: prompt } },
    { command: "workbench.action.chat.open", args: prompt },
    { command: "aichat.newchataction" },
    { command: "composer.newAgentChat" }
  ];

  for (const candidate of candidates) {
    try {
      await vscode.commands.executeCommand(candidate.command, candidate.args);
      await vscode.env.clipboard.writeText(prompt);
      void vscode.window.showInformationMessage(
        "Opened Cursor chat/agent. Grounded Codegraph context is also on your clipboard if you need to paste it."
      );
      return;
    } catch {
      // try next command
    }
  }

  await vscode.env.clipboard.writeText(prompt);
  void vscode.window.showInformationMessage(
    "Codegraph context copied. Paste it into Cursor Chat/Agent (no API key needed)."
  );
}

async function runAskCursorAgent(
  context: vscode.ExtensionContext,
  request: { rootPath: string; filePath: string; line: number; selectedText?: string }
): Promise<void> {
  const access = modelAccessConfig();
  if (!access.useBuiltInAgent) {
    void vscode.window.showWarningMessage(
      "Built-in agent access is disabled. Enable the checkbox “Use built-in Cursor/Claude agent” in the Codegraph panel or settings."
    );
    return;
  }

  let result = currentSession?.result;
  const sameTarget =
    currentSession &&
    currentSession.request.rootPath === request.rootPath &&
    currentSession.request.filePath === request.filePath &&
    currentSession.request.line === request.line;

  if (!result || !sameTarget) {
    const deterministic = await buildSelectionContext(request);
    result = await maybeEnrichSelection(deterministic);
  }

  currentSession = { request, result };
  ensurePanel(context);

  if (panel) {
    panel.title = `Codegraph Agent: ${request.selectedText ?? `${request.filePath}:${request.line}`}`;
    panel.webview.html = renderExplanationHtml(request.filePath, request.line, result);
    panel.reveal(vscode.ViewColumn.Beside, true);
  }

  await handOffToCursorAgent(buildAskAgentQuery(result));
}

async function runExplainSelection(
  context: vscode.ExtensionContext,
  request: { rootPath: string; filePath: string; line: number; selectedText?: string }
): Promise<void> {
  const deterministic = await buildSelectionContext(request);
  const result = await maybeEnrichSelection(deterministic);

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

  const parsed = message as {
    type?: string;
    file?: string;
    line?: number;
    useBuiltInAgent?: boolean;
    useApiKeyProvider?: boolean;
  };

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
    return;
  }

  if (parsed.type === "askCursorAgent") {
    await vscode.commands.executeCommand("codegraph.askCursorAgent");
    return;
  }

  if (parsed.type === "setModelAccess") {
    const config = vscode.workspace.getConfiguration("codegraph.modelAccess");
    if (typeof parsed.useBuiltInAgent === "boolean") {
      await config.update("useBuiltInAgent", parsed.useBuiltInAgent, vscode.ConfigurationTarget.Workspace);
    }
    if (typeof parsed.useApiKeyProvider === "boolean") {
      await config.update("useApiKeyProvider", parsed.useApiKeyProvider, vscode.ConfigurationTarget.Workspace);
      // Keep legacy flag aligned so older docs/settings stay consistent.
      await vscode.workspace
        .getConfiguration("codegraph.enrichment")
        .update("enabled", parsed.useApiKeyProvider, vscode.ConfigurationTarget.Workspace);
    }

    if (panel && currentSession) {
      panel.webview.html = renderExplanationHtml(
        currentSession.request.filePath,
        currentSession.request.line,
        currentSession.result
      );
    }

    const access = modelAccessConfig();
    void vscode.window.showInformationMessage(
      `Codegraph model access: agent=${access.useBuiltInAgent ? "on" : "off"}, apiKey=${access.useApiKeyProvider ? "on" : "off"}`
    );
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
  const access = modelAccessConfig();
  const enrichmentLabel = enrichmentStatusLabel(result.enrichment);
  const modeNote = access.useApiKeyProvider
    ? access.apiKey
      ? "API key provider enabled for in-panel enrichment."
      : "API key provider enabled, but no API key is configured yet."
    : access.useBuiltInAgent
      ? "Built-in Cursor/Claude agent mode (no API key). Use Ask Cursor/Claude Agent for narrative."
      : "Both model access options are off. Deterministic results only.";

  const enrichmentNote = result.enrichment?.used
    ? `<p class="muted">Model enrichment applied (${escapeHtml(result.enrichment.provider ?? "provider")} / ${escapeHtml(result.enrichment.model ?? "model")}). Sources remain deterministic.</p>`
    : `<p class="muted">${escapeHtml(modeNote)}</p>`;

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
          flex-wrap: wrap;
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
        .mode-box {
          margin-top: 12px;
          padding: 10px 12px;
          border: 1px solid var(--vscode-input-border, transparent);
          background: var(--vscode-textCodeBlock-background);
          border-radius: 6px;
        }
        .mode-box label {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          margin: 6px 0;
          cursor: pointer;
        }
        .mode-box input {
          margin-top: 3px;
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
        <span class="pill">Mode ${escapeHtml(access.useApiKeyProvider ? "api-key" : access.useBuiltInAgent ? "agent" : "off")}</span>
        <span class="pill">Enrichment ${escapeHtml(enrichmentLabel)}</span>
      </p>

      <div class="mode-box">
        <strong>Model access</strong>
        <label>
          <input id="useBuiltInAgent" type="checkbox" ${access.useBuiltInAgent ? "checked" : ""} />
          <span>Use built-in Cursor/Claude agent <span class="muted">(no API key — Cursor plan)</span></span>
        </label>
        <label>
          <input id="useApiKeyProvider" type="checkbox" ${access.useApiKeyProvider ? "checked" : ""} />
          <span>Use API key provider <span class="muted">(OpenAI-compatible enrichment)</span></span>
        </label>
      </div>

      ${enrichmentNote}
      <div class="actions">
        <button class="action-button" data-action="askCursorAgent">Ask Cursor/Claude Agent</button>
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
        const agentBox = document.getElementById("useBuiltInAgent");
        const apiBox = document.getElementById("useApiKeyProvider");
        function emitAccess() {
          vscode.postMessage({
            type: "setModelAccess",
            useBuiltInAgent: Boolean(agentBox && agentBox.checked),
            useApiKeyProvider: Boolean(apiBox && apiBox.checked)
          });
        }
        if (agentBox) agentBox.addEventListener("change", emitAccess);
        if (apiBox) apiBox.addEventListener("change", emitAccess);
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
