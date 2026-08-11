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

import { captureEditorState, setLiveBridgeEnabled } from "./liveBridge";

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
let liveExplainEnabled = false;
let liveExplainStatusBar: vscode.StatusBarItem | undefined;
let liveExplainTimer: NodeJS.Timeout | undefined;
let liveExplainGeneration = 0;
let extensionContext: vscode.ExtensionContext | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Codegraph");
  }

  return outputChannel;
}

function liveExplainConfig(): { debounceMs: number; pythonOnly: boolean } {
  const cfg = vscode.workspace.getConfiguration("codegraph.liveExplain");
  const debounceMs = Number(cfg.get<number>("debounceMs") ?? 450);
  return {
    debounceMs: Number.isFinite(debounceMs) ? Math.min(5000, Math.max(100, debounceMs)) : 450,
    pythonOnly: cfg.get<boolean>("pythonOnly") !== false
  };
}

function updateLiveExplainStatusBar(): void {
  if (!liveExplainStatusBar) {
    return;
  }

  liveExplainStatusBar.text = liveExplainEnabled ? "$(eye) Codegraph Live: ON" : "$(eye-closed) Codegraph Live: OFF";
  liveExplainStatusBar.tooltip = liveExplainEnabled
    ? "Live Explain is on — explanations update as you move the cursor. Click to turn off."
    : "Live Explain is off. Click to turn on continuous explanations.";
  liveExplainStatusBar.backgroundColor = liveExplainEnabled
    ? new vscode.ThemeColor("statusBarItem.warningBackground")
    : undefined;
}

async function setLiveExplainEnabled(enabled: boolean, announce = true): Promise<void> {
  liveExplainEnabled = enabled;
  await vscode.workspace
    .getConfiguration("codegraph.liveExplain")
    .update("enabled", enabled, vscode.ConfigurationTarget.Workspace);
  if (extensionContext) {
    await extensionContext.workspaceState.update("codegraph.liveExplain.enabled", enabled);
  }
  updateLiveExplainStatusBar();
  setLiveBridgeEnabled(enabled);

  if (announce) {
    void vscode.window.showInformationMessage(
      enabled
        ? "Codegraph Live Explain ON — panel updates as you move; agent bridge writes ~/.cursor/codegraph (and learn-codebase compat). Run skills/codegraph/scripts/watch-cursor.sh for agent tutoring."
        : "Codegraph Live Explain OFF."
    );
  }

  if (enabled) {
    const request = getActiveRequest({ quiet: true });
    const editor = vscode.window.activeTextEditor;
    if (request && editor) {
      captureEditorState(editor, request);
    }
    if (request && extensionContext) {
      void runExplainSelection(extensionContext, request, { live: true, handOffAgent: false });
    }
  } else if (panel && currentSession) {
    panel.webview.html = renderExplanationHtml(
      currentSession.request.filePath,
      currentSession.request.line,
      currentSession.result
    );
  }
}

function scheduleLiveExplain(): void {
  if (!liveExplainEnabled || !extensionContext) {
    return;
  }

  const { debounceMs, pythonOnly } = liveExplainConfig();
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    return;
  }

  if (pythonOnly && editor.document.languageId !== "python") {
    return;
  }

  if (liveExplainTimer) {
    clearTimeout(liveExplainTimer);
  }

  const generation = ++liveExplainGeneration;
  liveExplainTimer = setTimeout(() => {
    const request = getActiveRequest({ quiet: true });
    const editor = vscode.window.activeTextEditor;
    if (!request || generation !== liveExplainGeneration || !extensionContext || !editor) {
      return;
    }

    if (
      currentSession &&
      currentSession.request.rootPath === request.rootPath &&
      currentSession.request.filePath === request.filePath &&
      currentSession.request.line === request.line &&
      (currentSession.request.selectedText ?? "") === (request.selectedText ?? "")
    ) {
      return;
    }

    // learn-codebase-compatible agent bridge is refreshed inside runExplainSelection
    // after deterministic facts are ready (so pending-prompt includes all sections).
    void runExplainSelection(extensionContext, request, { live: true, handOffAgent: false });
  }, debounceMs);
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
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

  liveExplainStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  liveExplainStatusBar.command = "codegraph.toggleLiveExplain";
  liveExplainStatusBar.show();

  const saved =
    context.workspaceState.get<boolean>("codegraph.liveExplain.enabled") ??
    vscode.workspace.getConfiguration("codegraph.liveExplain").get<boolean>("enabled") ??
    false;
  liveExplainEnabled = Boolean(saved);
  updateLiveExplainStatusBar();
  setLiveBridgeEnabled(liveExplainEnabled);

  const toggleLiveCommand = vscode.commands.registerCommand("codegraph.toggleLiveExplain", async () => {
    await setLiveExplainEnabled(!liveExplainEnabled);
  });

  const explainCommand = vscode.commands.registerCommand("codegraph.explainSelection", async () => {
    const request = getActiveRequest();

    if (!request) {
      return;
    }

    await runExplainSelection(context, request, { live: false });
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

  const selectionListener = vscode.window.onDidChangeTextEditorSelection((event) => {
    if (!liveExplainEnabled) {
      return;
    }
    // Ignore programmatic selection changes (e.g. jumping to a source from the panel).
    if (event.kind === vscode.TextEditorSelectionChangeKind.Command) {
      return;
    }
    scheduleLiveExplain();
  });
  const editorListener = vscode.window.onDidChangeActiveTextEditor(() => {
    scheduleLiveExplain();
  });

  context.subscriptions.push(
    toggleLiveCommand,
    explainCommand,
    askAgentCommand,
    definitionCommand,
    usagesCommand,
    selectionListener,
    editorListener,
    liveExplainStatusBar,
    getOutputChannel(),
    {
      dispose: () => {
        if (liveExplainTimer) {
          clearTimeout(liveExplainTimer);
          liveExplainTimer = undefined;
        }
      }
    }
  );

  if (liveExplainEnabled) {
    scheduleLiveExplain();
  }
}

export function deactivate(): void {
  if (liveExplainTimer) {
    clearTimeout(liveExplainTimer);
    liveExplainTimer = undefined;
  }
  outputChannel?.dispose();
  outputChannel = undefined;
  panel?.dispose();
  panel = undefined;
  currentSession = undefined;
  panelMessageHooked = false;
  liveExplainStatusBar?.dispose();
  liveExplainStatusBar = undefined;
  extensionContext = undefined;
}

function getActiveRequest(options?: { quiet?: boolean }):
  | {
      rootPath: string;
      filePath: string;
      line: number;
      selectedText?: string;
    }
  | undefined {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    if (!options?.quiet) {
      void vscode.window.showWarningMessage("Codegraph needs an active editor.");
    }
    return undefined;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);

  if (!workspaceFolder) {
    if (!options?.quiet) {
      void vscode.window.showWarningMessage("Codegraph could not determine the current workspace folder.");
    }
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
  autoEnrichOnExplain: boolean;
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

  let useApiKeyProvider = Boolean(access.get<boolean>("useApiKeyProvider")) || legacyEnabled;
  let useBuiltInAgent = access.get<boolean>("useBuiltInAgent") !== false;

  // Prefer a single active LLM path: API key wins if explicitly enabled.
  if (useApiKeyProvider) {
    useBuiltInAgent = false;
  } else if (!useBuiltInAgent && !useApiKeyProvider) {
    useBuiltInAgent = true;
  }

  return {
    useBuiltInAgent,
    useApiKeyProvider,
    autoEnrichOnExplain: Boolean(access.get<boolean>("autoEnrichOnExplain")),
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
    return enrichment.provider === "cursor-agent" || enrichment.provider === "agent"
      ? `agent:${enrichment.model ?? "plan"}`
      : enrichment.model
        ? `ok:${enrichment.model}`
        : "ok";
  }

  if (
    enrichment.error?.includes("Live Explain") ||
    enrichment.error?.includes("deterministic") ||
    enrichment.error?.includes("agent bridge") ||
    enrichment.error?.includes("on-demand")
  ) {
    return enrichment.error.includes("Enriching") ? "enriching" : "deterministic";
  }

  if (enrichment.error?.includes("Enriching narrative")) {
    return "enriching";
  }

  if (enrichment.error?.includes("handed off") || enrichment.error?.includes("agent")) {
    return "agent_enrichment";
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

async function enrichViaApiKey(deterministic: SelectionContext): Promise<EnrichedSelectionContext> {
  const access = modelAccessConfig();

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

async function enrichViaAgent(
  deterministic: SelectionContext,
  options?: { handOff?: boolean }
): Promise<EnrichedSelectionContext> {
  const enriched: EnrichedSelectionContext = {
    ...deterministic,
    enrichment: {
      used: false,
      provider: "cursor-agent",
      model: "subscription",
      error: "Enrichment handed off to Cursor/Claude agent (subscription model)."
    }
  };

  if (options?.handOff !== false) {
    await handOffToCursorAgent(buildAskAgentQuery(enriched));
  }

  return enriched;
}

async function maybeEnrichSelection(
  deterministic: SelectionContext,
  options?: { handOffAgent?: boolean; live?: boolean }
): Promise<EnrichedSelectionContext> {
  const access = modelAccessConfig();

  // Live mode must stay in-panel. Never open Agent chat on every cursor move.
  if (options?.live) {
    if (access.useApiKeyProvider) {
      return enrichViaApiKey(deterministic);
    }

    return {
      ...deterministic,
      enrichment: {
        used: false,
        provider: access.useBuiltInAgent ? "cursor-agent" : undefined,
        error: access.useBuiltInAgent
          ? "Live Explain shows deterministic facts in-panel and writes the agent bridge (~/.cursor/codegraph). Run watch-cursor.sh for live Agent tutoring."
          : "Live Explain shows deterministic facts only."
      }
    };
  }

  if (access.useApiKeyProvider) {
    return enrichViaApiKey(deterministic);
  }

  if (access.useBuiltInAgent) {
    return enrichViaAgent(deterministic, {
      handOff: options?.handOffAgent ?? access.autoEnrichOnExplain
    });
  }

  return {
    ...deterministic,
    enrichment: {
      used: false,
      error: "Model access disabled. Enable Built-in Agent or API Key Provider."
    }
  };
}

function buildAskAgentQuery(result: EnrichedSelectionContext): string {
  return [
    "Use the Codegraph skill if available.",
    "You are performing Codegraph enrichment AND explanation via the Cursor/Claude subscription model.",
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
      "Built-in agent access is disabled. Enable “Built-in Cursor/Claude agent” (and turn off API key provider)."
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
    result = await maybeEnrichSelection(deterministic, { handOffAgent: false });
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
  request: { rootPath: string; filePath: string; line: number; selectedText?: string },
  options?: { live?: boolean; handOffAgent?: boolean }
): Promise<void> {
  const live = Boolean(options?.live);
  const access = modelAccessConfig();
  const generation = liveExplainGeneration;
  const deterministic = await buildSelectionContext(request);

  const grounded = {
    summary: deterministic.explanation.summary,
    whatItDoes: deterministic.explanation.whatItDoes,
    whyItExists: deterministic.explanation.whyItExists,
    howItWorks: deterministic.explanation.howItWorks,
    codebaseUsage: deterministic.explanation.codebaseUsage,
    sources: (deterministic.explanation.sources ?? []).map(
      (source) => `${source.file}:${source.line}`
    )
  };

  // Refresh agent bridge with grounded facts so BOTH agent and API-key paths
  // share the same section-complete context.
  const editor = vscode.window.activeTextEditor;
  if (live && editor) {
    captureEditorState(editor, request, grounded);
  }

  const pendingEnrichment: EnrichedSelectionContext = {
    ...deterministic,
    enrichment: {
      used: false,
      provider: access.useApiKeyProvider ? "openai-compatible" : access.useBuiltInAgent ? "cursor-agent" : undefined,
      error: access.useApiKeyProvider
        ? "Enriching narrative sections via API key provider…"
        : access.useBuiltInAgent
          ? "Deterministic sections ready. Agent bridge updated for live tutoring (all sections required)."
          : "Deterministic sections only."
    }
  };

  // Show deterministic panel immediately (all structural sections already filled).
  currentSession = { request, result: pendingEnrichment };
  renderExplainPanel(context, request, pendingEnrichment, { live, announce: false });

  // API key path: enrich in-panel for BOTH live and one-shot explains.
  // Agent path: live stays in-panel + bridge; one-shot may hand off.
  let result: EnrichedSelectionContext;
  if (access.useApiKeyProvider) {
    result = await enrichViaApiKey(deterministic);
  } else if (live) {
    result = {
      ...deterministic,
      enrichment: {
        used: false,
        provider: "cursor-agent",
        error:
          "Live Explain: panel shows full deterministic sections; agent bridge/pending-prompt asks Agent for the same sections (purpose/use, what it does, how, usages)."
      }
    };
  } else {
    result = await maybeEnrichSelection(deterministic, {
      live: false,
      handOffAgent: options?.handOffAgent
    });
  }

  if (live && generation !== liveExplainGeneration) {
    return;
  }

  currentSession = { request, result };
  renderExplainPanel(context, request, result, {
    live,
    announce: !live
  });
}

function renderExplainPanel(
  context: vscode.ExtensionContext,
  request: { rootPath: string; filePath: string; line: number; selectedText?: string },
  result: EnrichedSelectionContext,
  options: { live: boolean; announce: boolean }
): void {
  const channel = getOutputChannel();
  if (!options.live) {
    channel.clear();
  }
  channel.appendLine(options.live ? "Codegraph live explain" : "Codegraph selection context");
  channel.appendLine(
    redactSecrets(
      JSON.stringify(
        {
          live: options.live,
          target: `${request.filePath}:${request.line}`,
          metadata: result.metadata,
          enrichment: result.enrichment,
          explanation: {
            summary: result.explanation.summary,
            whatItDoes: result.explanation.whatItDoes,
            whyItExists: result.explanation.whyItExists,
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

  const label = request.selectedText
    ? request.selectedText.slice(0, 48)
    : `${request.filePath}:${request.line}`;
  panel.title = options.live ? `Codegraph Live: ${label}` : `Codegraph: ${label}`;
  panel.webview.html = renderExplanationHtml(request.filePath, request.line, result);
  panel.reveal(vscode.ViewColumn.Beside, true);

  if (options.announce) {
    const enrichmentLabel = enrichmentStatusLabel(result.enrichment);
    const summaryText = request.selectedText
      ? `Prepared local context for "${request.selectedText}" (tier ${result.metadata.capabilityTier}, enrichment ${enrichmentLabel}).`
      : `Prepared local context for ${request.filePath}:${request.line} (tier ${result.metadata.capabilityTier}, enrichment ${enrichmentLabel}).`;

    void vscode.window.showInformationMessage(summaryText);
  }
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

  if (parsed.type === "toggleLiveExplain") {
    await vscode.commands.executeCommand("codegraph.toggleLiveExplain");
    return;
  }

  if (parsed.type === "setModelAccess") {
    const config = vscode.workspace.getConfiguration("codegraph.modelAccess");
    let useBuiltInAgent = Boolean(parsed.useBuiltInAgent);
    let useApiKeyProvider = Boolean(parsed.useApiKeyProvider);

    // Mutual exclusion: one generative path at a time.
    if (useApiKeyProvider && useBuiltInAgent) {
      // Prefer whichever checkbox the user just enabled if we can detect it;
      // otherwise prefer API key when both true from the message.
      useBuiltInAgent = false;
    }
    if (!useApiKeyProvider && !useBuiltInAgent) {
      useBuiltInAgent = true;
    }

    await config.update("useBuiltInAgent", useBuiltInAgent, vscode.ConfigurationTarget.Workspace);
    await config.update("useApiKeyProvider", useApiKeyProvider, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace
      .getConfiguration("codegraph.enrichment")
      .update("enabled", useApiKeyProvider, vscode.ConfigurationTarget.Workspace);

    if (panel && currentSession) {
      // Re-run enrichment for the current session under the new mode.
      const deterministic: SelectionContext = {
        workspace: currentSession.result.workspace,
        context: currentSession.result.context,
        metadata: currentSession.result.metadata,
        explanation: currentSession.result.explanation
      };
      const refreshed = await maybeEnrichSelection(deterministic, {
        handOffAgent: useBuiltInAgent && modelAccessConfig().autoEnrichOnExplain
      });
      currentSession = { request: currentSession.request, result: refreshed };
      panel.webview.html = renderExplanationHtml(
        currentSession.request.filePath,
        currentSession.request.line,
        refreshed
      );
    }

    void vscode.window.showInformationMessage(
      useApiKeyProvider
        ? "Codegraph will use API key provider for enrichment."
        : "Codegraph will use Cursor/Claude agent for enrichment + explanation."
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

function renderMarkdownLite(text: string | undefined): string {
  if (!text?.trim()) {
    return "<p class=\"muted\">—</p>";
  }

  const escaped = escapeHtml(text);
  const lines = escaped.split("\n");
  const tableLines = lines.filter((line) => line.trim().startsWith("|"));
  if (tableLines.length >= 2) {
    const rows = tableLines
      .filter((line) => !/^\|\s*-+/.test(line.trim()))
      .map((line) =>
        line
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((cell) => cell.trim())
      );
    if (rows.length > 0) {
      const [header, ...body] = rows;
      return `
        <table>
          <thead><tr>${(header ?? []).map((cell) => `<th>${cell}</th>`).join("")}</tr></thead>
          <tbody>
            ${body.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}
          </tbody>
        </table>
      `;
    }
  }

  const blocks = escaped.split(/\n\n+/);
  return blocks
    .map((block) => {
      if (block.split("\n").every((line) => line.trim().startsWith("- ") || line.trim() === "")) {
        const items = block
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("- "))
          .map((line) => `<li>${line.slice(2)}</li>`)
          .join("");
        return `<ul>${items}</ul>`;
      }
      return `<p>${block.replaceAll("\n", "<br/>")}</p>`;
    })
    .join("");
}

function shortFileLabel(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  if (parts.length <= 2) {
    return filePath;
  }
  return parts.slice(-2).join("/");
}

function renderExplanationHtml(
  filePath: string,
  line: number,
  result: EnrichedSelectionContext
): string {
  const definition = result.explanation.sources.find((source) => source.kind === "definition") ?? result.explanation.sources[0];
  const endLineGuess =
    definition?.excerpt && definition.line
      ? definition.line + Math.max(0, definition.excerpt.split("\n").length - 1)
      : line;
  const locationLabel = `${shortFileLabel(filePath)} line ${line}`;
  const continueText =
    result.explanation.codebaseUsage?.split("\n").filter(Boolean).at(-1)?.includes("keep moving")
      ? result.explanation.codebaseUsage.split("\n").filter(Boolean).at(-1)
      : "Ask about that, or keep moving.";
  const usageBody = (result.explanation.codebaseUsage ?? "")
    .split("\n")
    .filter((entry) => entry.trim() && !entry.includes("keep moving"))
    .join("\n");

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <style>
        body {
          font-family: var(--vscode-font-family);
          color: var(--vscode-editor-foreground);
          padding: 18px 18px 28px;
          line-height: 1.55;
          max-width: 720px;
        }
        h1 {
          font-size: 1.05rem;
          font-weight: 600;
          margin: 0 0 4px;
        }
        h2 {
          font-size: 0.95rem;
          font-weight: 600;
          margin: 18px 0 8px;
        }
        .muted {
          color: var(--vscode-descriptionForeground);
        }
        .location {
          margin: 0 0 14px;
          color: var(--vscode-descriptionForeground);
          font-size: 0.92rem;
        }
        .code-card {
          margin: 0 0 14px;
          border: 1px solid var(--vscode-input-border, transparent);
          background: var(--vscode-textCodeBlock-background);
          border-radius: 6px;
          overflow: hidden;
        }
        .code-card .meta {
          display: flex;
          justify-content: space-between;
          gap: 8px;
          padding: 8px 10px;
          font-size: 0.85rem;
          color: var(--vscode-descriptionForeground);
          border-bottom: 1px solid var(--vscode-input-border, transparent);
        }
        .code-card pre {
          margin: 0;
          padding: 10px;
          white-space: pre-wrap;
          overflow-x: auto;
          font-size: 0.86rem;
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
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.9rem;
        }
        th, td {
          text-align: left;
          padding: 6px 8px;
          border-bottom: 1px solid var(--vscode-input-border, transparent);
          vertical-align: top;
        }
        th {
          color: var(--vscode-descriptionForeground);
          font-weight: 600;
        }
        ul {
          margin: 0;
          padding-left: 1.2rem;
        }
        p {
          margin: 0 0 8px;
        }
        .continue {
          margin-top: 22px;
          color: var(--vscode-descriptionForeground);
          font-style: italic;
        }
        .footer {
          margin-top: 18px;
          font-size: 0.8rem;
          color: var(--vscode-descriptionForeground);
        }
        .footer button {
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
      <h1>${escapeHtml(result.context.target.selectedText || result.explanation.summary.split("—")[0]?.trim() || "Codegraph")}</h1>
      <p class="location">${escapeHtml(locationLabel)}</p>

      ${
        definition?.excerpt
          ? `<div class="code-card">
              <div class="meta">
                <span>${escapeHtml(shortFileLabel(definition.file))}</span>
                <button class="source-link" data-file="${escapeAttribute(definition.file)}" data-line="${definition.line}">
                  Lines ${definition.line}-${endLineGuess}
                </button>
              </div>
              <pre>${escapeHtml(definition.excerpt)}</pre>
            </div>`
          : ""
      }

      <h2>Purpose</h2>
      ${renderMarkdownLite(result.explanation.whyItExists)}

      <h2>Fields</h2>
      ${renderMarkdownLite(result.explanation.whatItDoes)}

      <h2>Notes</h2>
      ${renderMarkdownLite(result.explanation.howItWorks)}

      ${
        usageBody.trim()
          ? `<h2>In this codebase</h2>${renderMarkdownLite(usageBody)}`
          : ""
      }

      <p class="continue">${escapeHtml(continueText ?? "Ask about that, or keep moving.")}</p>
      <p class="footer">
        Live ${liveExplainEnabled ? "on" : "off"} ·
        <button data-action="toggleLiveExplain">${liveExplainEnabled ? "turn off" : "turn on"}</button>
      </p>

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
        document.querySelectorAll("[data-action]").forEach((node) => {
          node.addEventListener("click", () => {
            vscode.postMessage({ type: node.getAttribute("data-action") });
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
