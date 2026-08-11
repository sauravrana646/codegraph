import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildSelectionContext, findDefinition, findUsages } from "@codegraph/core";
import {
  applyEnrichmentText,
  buildPointerAgentHandoffPrompt,
  buildHostEnrichmentPrompt,
  enrichSelectionContext,
  SLIM_HANDOFF_MARKER,
  type EnrichmentMetadata,
  type EnrichedSelectionContext as GatewayEnrichedSelectionContext
} from "@codegraph/model-gateway";
import { redactSecrets } from "@codegraph/security";
import { normalizeWorkspacePath } from "@codegraph/workspace";

import { captureEditorState, setLiveBridgeEnabled } from "./liveBridge";
import { autoSendToCursorAgent } from "./agentHandoff";

type SelectionContext = Awaited<ReturnType<typeof buildSelectionContext>>;
type EnrichedSelectionContext = GatewayEnrichedSelectionContext;
type SourceLike = { file: string; line: number; excerpt?: string; kind?: string; score?: number };

interface CodeUnderstandingSession {
  request: {
    rootPath: string;
    filePath: string;
    line: number;
    selectedText?: string;
  };
  result: EnrichedSelectionContext;
}

let outputChannel: vscode.OutputChannel | undefined;
let panel: vscode.WebviewPanel | undefined;
let currentSession: CodeUnderstandingSession | undefined;
let panelMessageHooked = false;
let liveExplainEnabled = false;
let liveExplainStatusBar: vscode.StatusBarItem | undefined;
let liveExplainTimer: NodeJS.Timeout | undefined;
let liveExplainGeneration = 0;
let extensionContext: vscode.ExtensionContext | undefined;
let lastAgentHandOffMs = 0;
let agentChatOpened = false;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Codegraph");
  }

  return outputChannel;
}

function liveExplainConfig(): { debounceMs: number; pythonOnly: boolean } {
  const cfg = vscode.workspace.getConfiguration("codegraph.liveExplain");
  const access = modelAccessConfig();
  const agentMode = access.useBuiltInAgent && !access.useApiKeyProvider;
  const configured = Number(cfg.get<number>("debounceMs") ?? (agentMode ? 900 : 450));
  const fallback = agentMode ? 900 : 450;
  const debounceMs = Number.isFinite(configured) ? configured : fallback;
  return {
    // Agent auto-submit needs a bit more settle time between cursor moves.
    debounceMs: Math.min(5000, Math.max(agentMode ? 700 : 100, debounceMs)),
    pythonOnly: cfg.get<boolean>("pythonOnly") !== false
  };
}

function updateLiveExplainStatusBar(): void {
  if (!liveExplainStatusBar) {
    return;
  }

  liveExplainStatusBar.text = liveExplainEnabled ? "$(eye) Codegraph Live: ON" : "$(eye-closed) Codegraph Live: OFF";
  liveExplainStatusBar.tooltip = liveExplainEnabled
    ? "Live Explain ON — move cursor; Agent answers automatically in Agent chat."
    : "Live Explain OFF. Click to turn on automatic explanations.";
  liveExplainStatusBar.backgroundColor = liveExplainEnabled
    ? new vscode.ThemeColor("statusBarItem.warningBackground")
    : undefined;
}

function logCodegraph(message: string, show = false): void {
  const channel = getOutputChannel();
  channel.appendLine(`[${new Date().toISOString()}] ${message}`);
  if (show) {
    channel.show(true);
  }
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
  logCodegraph(`Live Explain -> ${enabled ? "ON" : "OFF"}`, true);

  if (announce) {
    const access = modelAccessConfig();
    const agentMode = access.useBuiltInAgent && !access.useApiKeyProvider;
    void vscode.window.showInformationMessage(
      enabled
        ? agentMode
          ? "Codegraph Live ON — move your cursor in a Python file. Watch Agent chat + Output → Codegraph."
          : "Codegraph Live ON — cursor moves enrich in-panel via API key."
        : "Codegraph Live Explain OFF."
    );
  }

  if (enabled) {
    const request = getActiveRequest({ quiet: true });
    const editor = vscode.window.activeTextEditor;
    if (!request) {
      logCodegraph("Live ON but no active workspace editor — open a Python file in a folder workspace.", true);
      void vscode.window.showWarningMessage(
        "Codegraph Live is ON, but no workspace file is active. Open a .py file inside a project folder."
      );
      return;
    }
    if (editor && liveExplainConfig().pythonOnly && editor.document.languageId !== "python") {
      logCodegraph(`Live ON but language is '${editor.document.languageId}' (pythonOnly=true).`, true);
      void vscode.window.showWarningMessage(
        "Codegraph Live is ON, but the active file is not Python. Open a .py file."
      );
      return;
    }
    if (editor) {
      captureEditorState(editor, request);
    }
    if (extensionContext) {
      // Always hand off in agent mode — this was previously false and blocked all Live Agent sends.
      void runExplainSelection(extensionContext, request, { live: true, handOffAgent: true });
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
    const activeEditor = vscode.window.activeTextEditor;
    if (!request || generation !== liveExplainGeneration || !extensionContext || !activeEditor) {
      logCodegraph("Live tick skipped (no request/editor or superseded).");
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

    logCodegraph(`Live tick → ${request.filePath}:${request.line}`);
    void runExplainSelection(extensionContext, request, { live: true, handOffAgent: true });
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

  logCodegraph(`Activated. parser=${process.env.CODEGRAPH_PYTHON_PARSER}`, true);

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

  const diagnoseCommand = vscode.commands.registerCommand("codegraph.diagnoseLiveExplain", async () => {
    const channel = getOutputChannel();
    channel.show(true);
    const editor = vscode.window.activeTextEditor;
    const access = modelAccessConfig();
    const request = getActiveRequest({ quiet: true });
    const bridgeDir = path.join(os.homedir(), ".cursor", "codegraph");
    const enabledPath = path.join(bridgeDir, "enabled");
    const pendingPath = path.join(bridgeDir, "pending-prompt.md");
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(context.extensionPath, "package.json"), "utf8")
    ) as { version?: string };

    logCodegraph("=== Codegraph diagnose ===", true);
    logCodegraph(`extensionVersion=${packageJson.version ?? "unknown"} marker=${SLIM_HANDOFF_MARKER}`);
    logCodegraph(`liveEnabled=${liveExplainEnabled}`);
    logCodegraph(
      `agent=${access.useBuiltInAgent} apiKey=${access.useApiKeyProvider} autoSubmit=${vscode.workspace
        .getConfiguration("codegraph.liveExplain")
        .get("autoSubmitAgent")}`
    );
    logCodegraph(
      `editor=${editor?.document.uri.fsPath ?? "(none)"} language=${editor?.document.languageId ?? "(none)"}`
    );
    logCodegraph(`workspaceRequest=${request ? `${request.filePath}:${request.line}` : "(none)"}`);
    logCodegraph(`parser=${process.env.CODEGRAPH_PYTHON_PARSER ?? "(unset)"}`);
    logCodegraph(`bridgeEnabled exists=${fs.existsSync(enabledPath)}`);

    if (request) {
      const expected = buildPointerAgentHandoffPrompt(request);
      logCodegraph(`expectedHandoffChars=${expected.length}`);
      logCodegraph("--- expected slim prompt ---");
      logCodegraph(expected);
      logCodegraph("--- end expected ---");
      if (!expected.startsWith(SLIM_HANDOFF_MARKER) || expected.includes("AST facts") || expected.includes("AST symbol")) {
        logCodegraph("ERROR: expected prompt is not slim — extension build is wrong.", true);
      }
    }

    if (fs.existsSync(pendingPath)) {
      const pending = fs.readFileSync(pendingPath, "utf8");
      logCodegraph(`pending-prompt.md chars=${pending.length}`);
      logCodegraph("--- pending-prompt.md ---");
      logCodegraph(pending.slice(0, 1200));
      logCodegraph("--- end pending ---");
      if (
        pending.includes("AST facts") ||
        pending.includes("AST symbol") ||
        pending.includes("Deterministic Codegraph facts") ||
        !pending.includes(SLIM_HANDOFF_MARKER)
      ) {
        logCodegraph(
          "WARNING: pending-prompt.md looks OLD/fat. Reinstall VSIX from latest mvp, Reload Window, toggle Live Explain OFF→ON.",
          true
        );
        void vscode.window.showWarningMessage(
          "Codegraph: pending-prompt.md is still fat/old. Reinstall the new VSIX (0.1.1+), Reload Window, toggle Live OFF→ON."
        );
      }
    } else {
      logCodegraph("pending-prompt.md missing (will be written on next Live tick)");
    }

    if (request && extensionContext) {
      void vscode.window.showInformationMessage(
        `Codegraph diagnose ${SLIM_HANDOFF_MARKER}: forcing one Live explain. Watch Output → Codegraph; Agent prompt must start with ${SLIM_HANDOFF_MARKER}.`
      );
      await runExplainSelection(extensionContext, request, { live: true, handOffAgent: true });
    } else {
      void vscode.window.showWarningMessage("Open a Python file in a workspace folder, then run diagnose again.");
    }
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
    diagnoseCommand,
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
  request: { rootPath: string; filePath: string; line: number; selectedText?: string },
  options?: { handOff?: boolean; forceNewChat?: boolean }
): Promise<EnrichedSelectionContext> {
  const prompt = buildPointerAgentHandoffPrompt(request);
  logCodegraph(`Agent prompt ${SLIM_HANDOFF_MARKER} chars=${prompt.length}`);
  logCodegraph(prompt);

  const handedOff =
    options?.handOff === false
      ? false
      : await handOffToCursorAgent(prompt, {
          forceNew: options?.forceNewChat
        });

  return {
    ...pointerContext(request),
    enrichment: {
      used: handedOff,
      provider: "cursor-agent",
      model: "subscription",
      error: handedOff
        ? `Slim ${SLIM_HANDOFF_MARKER} auto-sent (${prompt.length} chars). Answer appears in Agent chat.`
        : "Auto-send to Agent failed. On macOS, allow Accessibility for Cursor/osascript, then retry."
    }
  };
}

/**
 * Fully automatic: open/focus Agent, insert prompt, submit. No manual Enter.
 */
async function handOffToCursorAgent(
  prompt: string,
  options?: { forceNew?: boolean }
): Promise<boolean> {
  if (!prompt.startsWith(SLIM_HANDOFF_MARKER)) {
    logCodegraph("Refusing handoff: prompt missing slim marker", true);
    return false;
  }
  if (
    /AST facts|AST symbol|AST_FACTS|LSP hover|Deterministic Codegraph facts/i.test(prompt)
  ) {
    logCodegraph("Refusing handoff: prompt still contains AST/LSP dump markers", true);
    return false;
  }

  const ok = await autoSendToCursorAgent(prompt, {
    forceNew: options?.forceNew,
    log: (message) => getOutputChannel().appendLine(message)
  });
  if (ok) {
    agentChatOpened = true;
  }
  return ok;
}

/** Minimal session envelope — no AST/LSP payloads. */
function pointerContext(request: {
  rootPath: string;
  filePath: string;
  line: number;
  selectedText?: string;
}): SelectionContext {
  const workspace = {
    id: request.rootPath,
    rootPath: request.rootPath,
    name: path.basename(request.rootPath) || "workspace"
  };
  const target = {
    workspaceId: workspace.id,
    file: request.filePath,
    line: request.line,
    selectedText: request.selectedText
  };
  return {
    workspace,
    context: {
      workspace,
      target,
      definitions: [],
      references: [],
      relatedFiles: [],
      documentation: [],
      configuration: []
    },
    metadata: {
      source: "text",
      capabilityTier: 1,
      confidence: 0.5
    },
    explanation: {
      summary: request.selectedText
        ? `${request.selectedText} @ ${request.filePath}:${request.line}`
        : `${request.filePath}:${request.line}`,
      whatItDoes: "",
      howItWorks: "",
      whyItExists: "",
      codebaseUsage: "",
      caveats: [],
      confidence: "low",
      sources: [],
      relatedCode: [],
      inferredClaims: []
    }
  };
}

/** Source-window context for API key enrichment only (no IDE LSP). */
async function gatherSourceWindowContext(
  request: { rootPath: string; filePath: string; line: number; selectedText?: string }
): Promise<SelectionContext> {
  return buildSelectionContext(request);
}

async function enrichGroundedContext(
  request: { rootPath: string; filePath: string; line: number; selectedText?: string },
  grounded: SelectionContext,
  options?: { live?: boolean; handOffAgent?: boolean }
): Promise<EnrichedSelectionContext> {
  const access = modelAccessConfig();

  if (access.useApiKeyProvider) {
    return enrichViaApiKey(grounded);
  }

  if (access.useBuiltInAgent) {
    const now = Date.now();
    const autoSubmit =
      vscode.workspace.getConfiguration("codegraph.liveExplain").get<boolean>("autoSubmitAgent") !== false;
    if (options?.live && now - lastAgentHandOffMs < 4500) {
      return {
        ...pointerContext(request),
        enrichment: {
          used: false,
          provider: "cursor-agent",
          model: "subscription",
          error: "Live agent handoff throttled — waiting for the current Agent reply."
        }
      };
    }

    const shouldHandOff = autoSubmit && (options?.handOffAgent ?? true);
    if (shouldHandOff) {
      lastAgentHandOffMs = now;
    }

    return enrichViaAgent(request, {
      handOff: shouldHandOff,
      forceNewChat: !agentChatOpened
    });
  }

  return {
    ...pointerContext(request),
    enrichment: {
      used: false,
      error: "Enable Built-in Agent or API Key Provider — pointer alone is not the final explanation."
    }
  };
}

async function runAskCursorAgent(
  _context: vscode.ExtensionContext,
  request: { rootPath: string; filePath: string; line: number; selectedText?: string }
): Promise<void> {
  const access = modelAccessConfig();
  if (!access.useBuiltInAgent) {
    void vscode.window.showWarningMessage(
      "Built-in agent access is disabled. Enable “Built-in Cursor/Claude agent” (and turn off API key provider)."
    );
    return;
  }

  currentSession = {
    request,
    result: {
      ...pointerContext(request),
      enrichment: {
        used: false,
        provider: "cursor-agent",
        error: "Sending slim pointer to Agent chat…"
      }
    }
  };

  lastAgentHandOffMs = Date.now();
  const result = await enrichViaAgent(request, { handOff: true, forceNewChat: true });
  currentSession = { request, result };
}

async function runExplainSelection(
  context: vscode.ExtensionContext,
  request: { rootPath: string; filePath: string; line: number; selectedText?: string },
  options?: { live?: boolean; handOffAgent?: boolean }
): Promise<void> {
  const live = Boolean(options?.live);
  const access = modelAccessConfig();
  const generation = liveExplainGeneration;
  const agentMode = access.useBuiltInAgent && !access.useApiKeyProvider;

  const editor = vscode.window.activeTextEditor;
  if (live && editor) {
    captureEditorState(editor, request);
  }

  // Agent mode: pointer only — no AST/LSP gather.
  if (agentMode) {
    logCodegraph(`Agent mode explain for ${request.filePath}:${request.line} (live=${live})`, true);
    const result = await enrichGroundedContext(request, pointerContext(request), {
      live,
      handOffAgent: options?.handOffAgent ?? true
    });
    if (live && generation !== liveExplainGeneration) {
      return;
    }
    currentSession = { request, result };
    logCodegraph(
      `Agent handoff ${result.enrichment.used ? "OK" : "FAILED"} — ${result.enrichment.error ?? ""}`,
      true
    );
    if (!result.enrichment.used) {
      void vscode.window.showWarningMessage(
        `Codegraph could not auto-send to Agent. ${result.enrichment.error ?? ""} Check Output → Codegraph.`
      );
    }
    return;
  }

  // API key mode: source window only (no IDE LSP), then HTTP enrichment.
  const grounded = await gatherSourceWindowContext(request);
  const pending: EnrichedSelectionContext = {
    ...grounded,
    enrichment: {
      used: false,
      provider: "openai-compatible",
      error: "Source window ready — enriching via API key…"
    }
  };

  currentSession = { request, result: pending };
  renderExplainPanel(context, request, pending, { live, announce: false });

  const result = await enrichGroundedContext(request, grounded, { live, handOffAgent: false });
  if (live && generation !== liveExplainGeneration) {
    return;
  }

  currentSession = { request, result };
  renderExplainPanel(context, request, result, { live, announce: false });
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

    if (useApiKeyProvider && useBuiltInAgent) {
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

    if (panel && currentSession && extensionContext) {
      await runExplainSelection(extensionContext, currentSession.request, {
        live: liveExplainEnabled,
        handOffAgent: false
      });
    }

    void vscode.window.showInformationMessage(
      useApiKeyProvider
        ? "API key mode: enriched answers show in the Codegraph panel."
        : "Agent mode: answers show in Cursor Agent chat (no side panel)."
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
  const enriched = Boolean(result.enrichment?.used);
  const title =
    (enriched ? result.explanation.summary : result.context.target.selectedText) ||
    result.explanation.summary ||
    "Codegraph";
  const continueText =
    result.explanation.codebaseUsage?.split("\n").filter(Boolean).at(-1)?.includes("keep moving")
      ? result.explanation.codebaseUsage.split("\n").filter(Boolean).at(-1)
      : "Ask about that, or keep moving.";
  const usageBody = (result.explanation.codebaseUsage ?? "")
    .split("\n")
    .filter((entry) => entry.trim() && !entry.includes("keep moving") && !entry.startsWith("- [lsp]"))
    .join("\n");
  const resolution = `${result.metadata.source} · tier ${result.metadata.capabilityTier}`;

  const body = enriched
    ? `
      <h2>Purpose</h2>
      ${renderMarkdownLite(result.explanation.whyItExists)}

      <h2>Fields</h2>
      ${renderMarkdownLite(result.explanation.whatItDoes)}

      <h2>Notes</h2>
      ${renderMarkdownLite(result.explanation.howItWorks)}

      ${usageBody.trim() ? `<h2>In this codebase</h2>${renderMarkdownLite(usageBody)}` : ""}

      <p class="continue">${escapeHtml(continueText ?? "Ask about that, or keep moving.")}</p>
    `
    : `
      <p class="pending">Source window ready. Waiting for ${
        result.enrichment?.provider === "openai-compatible" ? "API enrichment" : "Agent enrichment"
      } — that model writes the final tutoring explanation.</p>
      <p class="muted">${escapeHtml(result.enrichment?.error || "")}</p>
      <details>
        <summary class="muted">Raw grounded context</summary>
        <pre>${escapeHtml(result.explanation.howItWorks || "")}</pre>
      </details>
    `;

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
        .pending {
          margin: 12px 0;
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
        .code-card pre, details pre {
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
        p { margin: 0 0 8px; }
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
        details {
          margin-top: 12px;
        }
      </style>
    </head>
    <body>
      <h1>${escapeHtml(title)}</h1>
      <p class="location">${escapeHtml(locationLabel)} · ${escapeHtml(resolution)}</p>

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

      ${body}

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
