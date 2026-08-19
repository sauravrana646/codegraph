import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildRepoBrief,
  buildSelectionContext,
  ensureWorkspaceIndex,
  getCachedWorkspaceIndex,
  indexStoragePath,
  neighborhoodLinesForPointer,
  readWorkspaceIndex,
  reindexPaths
} from "@codegraph/core";
import {
  applyEnrichmentText,
  buildPointerAgentHandoffPrompt,
  buildRepoBriefAgentPrompt,
  buildHostEnrichmentPrompt,
  enrichSelectionContext,
  ENRICHMENT_PROVIDER_PRESETS,
  getEnrichmentProviderPreset,
  modelPresetsForProvider,
  resolveEnrichmentBaseUrl,
  SLIM_HANDOFF_MARKER,
  testProviderConnection,
  type EnrichmentMetadata,
  type EnrichedSelectionContext as GatewayEnrichedSelectionContext,
  type ExplainDepth
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
let explainDepthStatusBar: vscode.StatusBarItem | undefined;
let liveExplainTimer: NodeJS.Timeout | undefined;
let liveExplainGeneration = 0;
let extensionContext: vscode.ExtensionContext | undefined;
let lastAgentHandOffMs = 0;
let agentChatOpened = false;
/** Same-symbol skip key: root|file|symbol (line changes within a symbol do not re-fire). */
let lastLiveExplainKey = "";
const API_KEY_SECRET = "codegraph.enrichment.apiKey";
let cachedApiKey: string | undefined;
let warnedRegexFallback = false;
const indexWatchers = new Map<string, fs.FSWatcher>();
const indexReloadTimers = new Map<string, NodeJS.Timeout>();

function folderForIndex(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (target) {
    const folder = vscode.workspace.getWorkspaceFolder(target);
    if (folder) {
      return folder;
    }
  }
  return vscode.workspace.workspaceFolders?.[0];
}

function neighborhoodForRequest(request: {
  rootPath: string;
  filePath: string;
  line: number;
  selectedText?: string;
}): string[] {
  const cached = getCachedWorkspaceIndex(request.rootPath);
  if (!cached) {
    void readWorkspaceIndex(request.rootPath);
    return [];
  }
  return neighborhoodLinesForPointer(cached, request.filePath, request.line, request.selectedText);
}

function watchIndexFile(rootPath: string): void {
  const storage = indexStoragePath(rootPath);
  if (indexWatchers.has(storage)) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(storage), { recursive: true });
    const watcher = fs.watch(path.dirname(storage), { persistent: false }, (_event, filename) => {
      if (filename && filename !== "index.json" && filename !== "index.json.tmp") {
        return;
      }
      const previous = indexReloadTimers.get(storage);
      if (previous) {
        clearTimeout(previous);
      }
      indexReloadTimers.set(
        storage,
        setTimeout(() => {
          void readWorkspaceIndex(rootPath);
        }, 250)
      );
    });
    indexWatchers.set(storage, watcher);
  } catch {
    // ignore missing dirs
  }
}

async function rememberIndexResult(
  result: Awaited<ReturnType<typeof ensureWorkspaceIndex>>
): Promise<void> {
  watchIndexFile(result.index.rootPath);
  if (!warnedRegexFallback && (result.parseRegex > 0 || result.astUnavailable)) {
    warnedRegexFallback = true;
    const detail = result.astUnavailable
      ? "Python AST parser is unavailable; falling back to regex (no call graph)."
      : `${result.parseRegex} file(s) used regex fallback instead of the Python AST parser.`;
    logCodegraph(detail, true);
    void vscode.window.showWarningMessage(`Codegraph: ${detail}`);
  }
}

async function migrateAndLoadApiKey(context: vscode.ExtensionContext): Promise<void> {
  const enrichment = vscode.workspace.getConfiguration("codegraph.enrichment");
  const inspected = enrichment.inspect<string>("apiKey");
  const fromWorkspace = inspected?.workspaceValue?.trim();
  const fromGlobal = inspected?.globalValue?.trim();
  const fromConfig = fromWorkspace || fromGlobal || enrichment.get<string>("apiKey")?.trim();
  const existing = await context.secrets.get(API_KEY_SECRET);

  if (fromConfig && !existing) {
    await context.secrets.store(API_KEY_SECRET, fromConfig);
    cachedApiKey = fromConfig;
    void vscode.window.showInformationMessage("Codegraph migrated the API key into Secret Storage.");
  } else {
    cachedApiKey = existing || undefined;
  }

  if (fromWorkspace) {
    await enrichment.update("apiKey", undefined, vscode.ConfigurationTarget.Workspace);
  }
  if (fromGlobal) {
    await enrichment.update("apiKey", undefined, vscode.ConfigurationTarget.Global);
  }
}

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Codegraph");
  }

  return outputChannel;
}

function explainDepthSetting(): ExplainDepth {
  const raw = vscode.workspace.getConfiguration("codegraph.explain").get<string>("depth") ?? "standard";
  if (raw === "short" || raw === "deep" || raw === "standard") {
    return raw;
  }
  return "standard";
}

function symbolKeyFromEditor(
  editor: vscode.TextEditor,
  request: { rootPath: string; filePath: string; line: number; selectedText?: string }
): string {
  const selected = (request.selectedText ?? "").trim();
  if (selected) {
    const ident = selected.match(/[A-Za-z_][A-Za-z0-9_]*/)?.[0] ?? selected.slice(0, 64);
    return `${request.rootPath}|${request.filePath}|${ident}`;
  }
  const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_][A-Za-z0-9_]*/);
  const word = wordRange ? editor.document.getText(wordRange).trim() : "";
  if (word) {
    return `${request.rootPath}|${request.filePath}|${word}`;
  }
  // No symbol — fall back to exact line so blank areas still can explain once.
  return `${request.rootPath}|${request.filePath}|:${request.line}`;
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

  liveExplainStatusBar.text = liveExplainEnabled
    ? "$(eye) CG Live: ON"
    : "$(eye-closed) CG Live: OFF";
  liveExplainStatusBar.tooltip = liveExplainEnabled
    ? "Codegraph Live Explain ON — click to turn OFF"
    : "Codegraph Live Explain OFF — click to turn ON";
  liveExplainStatusBar.backgroundColor = liveExplainEnabled
    ? new vscode.ThemeColor("statusBarItem.warningBackground")
    : undefined;
  liveExplainStatusBar.accessibilityInformation = {
    label: liveExplainEnabled ? "Codegraph Live Explain on" : "Codegraph Live Explain off",
    role: "button"
  };
  liveExplainStatusBar.show();
}

function updateExplainDepthStatusBar(): void {
  if (!explainDepthStatusBar) {
    return;
  }

  const depth = explainDepthSetting();
  const label = depth === "short" ? "Short" : depth === "deep" ? "Deep" : "Standard";
  explainDepthStatusBar.text = `$(list-flat) CG Depth: ${label}`;
  explainDepthStatusBar.tooltip =
    `Explain depth: ${label}. Click to change (Short / Standard / Deep).\n` +
    "Deep = use case, example, why-not-simpler alternatives, and why this design wins.";
  explainDepthStatusBar.accessibilityInformation = {
    label: `Codegraph explain depth ${label}`,
    role: "button"
  };
  explainDepthStatusBar.show();
}

function updateCodegraphStatusBars(): void {
  updateLiveExplainStatusBar();
  updateExplainDepthStatusBar();
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
    lastLiveExplainKey = "";
    const folder = folderForIndex();
    if (folder && extensionContext) {
      const briefKey = `codegraph.repoBrief.done:${folder.uri.fsPath}`;
      if (!extensionContext.workspaceState.get<boolean>(briefKey)) {
        const choice = await vscode.window.showInformationMessage(
          "First time in this workspace — run a quick repo brief?",
          "Repo brief",
          "Skip"
        );
        if (choice === "Repo brief") {
          await runRepoBrief({ force: true });
        } else if (choice === "Skip") {
          await extensionContext.workspaceState.update(briefKey, true);
        }
      }
    }
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
      captureEditorState(editor, request, undefined, neighborhoodForRequest(request));
    }
    if (extensionContext) {
      // Always hand off in agent mode — this was previously false and blocked all Live Agent sends.
      void runExplainSelection(extensionContext, request, { live: true, handOffAgent: true });
    }
  } else if (panel && currentSession) {
    panel.webview.html = renderExplanationHtml(
      currentSession.request.filePath,
      currentSession.request.line,
      currentSession.result,
      { logoUri: extensionIconWebviewUri(panel.webview), webview: panel.webview }
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

  // Do NOT bump liveExplainGeneration here. Cursor jitter on the same symbol used to
  // increment generation on every schedule and cancel the in-flight gather/handoff
  // before the panel/Agent send finished. Only bump when starting a *new* symbol.
  liveExplainTimer = setTimeout(() => {
    const request = getActiveRequest({ quiet: true });
    const activeEditor = vscode.window.activeTextEditor;
    if (!request || !extensionContext || !activeEditor) {
      logCodegraph("Live tick skipped (no request/editor).");
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

    const key = symbolKeyFromEditor(activeEditor, request);
    if (key && key === lastLiveExplainKey) {
      logCodegraph(`Live tick skipped (same symbol) ${key}`);
      return;
    }

    // New symbol (or empty key): supersede any in-flight explain for the previous symbol.
    liveExplainGeneration += 1;
    lastLiveExplainKey = key;

    logCodegraph(`Live tick → ${request.filePath}:${request.line} key=${key}`);
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
  void migrateAndLoadApiKey(context).then(() => {
    void warmWorkspaceIndex();
  });

  // Left + high priority so Cursor's crowded right status bar cannot hide these.
  liveExplainStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  liveExplainStatusBar.command = "codegraph.toggleLiveExplain";
  liveExplainStatusBar.name = "Codegraph Live Explain";
  context.subscriptions.push(liveExplainStatusBar);

  explainDepthStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 999);
  explainDepthStatusBar.command = "codegraph.setExplainDepth";
  explainDepthStatusBar.name = "Codegraph Explain Depth";
  context.subscriptions.push(explainDepthStatusBar);

  const saved =
    context.workspaceState.get<boolean>("codegraph.liveExplain.enabled") ??
    vscode.workspace.getConfiguration("codegraph.liveExplain").get<boolean>("enabled") ??
    false;
  liveExplainEnabled = Boolean(saved);
  updateCodegraphStatusBars();
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
      `agent=${access.useBuiltInAgent} apiKey=${access.useApiKeyProvider} provider=${access.providerId} model=${access.model} autoSubmit=${vscode.workspace
        .getConfiguration("codegraph.liveExplain")
        .get("autoSubmitAgent")}`
    );
    logCodegraph(
      `editor=${editor?.document.uri.fsPath ?? "(none)"} language=${editor?.document.languageId ?? "(none)"}`
    );
    logCodegraph(`workspaceRequest=${request ? `${request.filePath}:${request.line}` : "(none)"}`);
    logCodegraph(`parser=${process.env.CODEGRAPH_PYTHON_PARSER ?? "(unset)"}`);
    const folder = folderForIndex();
    if (folder) {
      try {
        const result = await ensureWorkspaceIndex(folder.uri.fsPath);
        await rememberIndexResult(result);
        logCodegraph(
          `index files=${result.total} changed=${result.changed} unchanged=${result.unchanged} skipped=${result.skipped} failed=${result.failed} ast=${result.parseAst} regex=${result.parseRegex} path=${result.storagePath}`
        );
      } catch (error) {
        logCodegraph(`index error=${error instanceof Error ? error.message : String(error)}`);
      }
    }
    logCodegraph(`bridgeEnabled exists=${fs.existsSync(enabledPath)}`);

    if (request) {
      const expected = buildPointerAgentHandoffPrompt({
        ...request,
        depth: explainDepthSetting(),
        neighborhoodLines: neighborhoodForRequest(request)
      });
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

  const configureApiCommand = vscode.commands.registerCommand("codegraph.configureApiProvider", async () => {
    await configureApiProvider({ enableApiKeyMode: true });
  });

  const testApiCommand = vscode.commands.registerCommand("codegraph.testApiConnection", async () => {
    await runTestApiConnection();
  });

  const repoBriefCommand = vscode.commands.registerCommand("codegraph.repoBrief", async () => {
    await runRepoBrief({ force: true });
  });

  const setDepthCommand = vscode.commands.registerCommand("codegraph.setExplainDepth", async () => {
    const picked = await vscode.window.showQuickPick(
      [
        { label: "Short", description: "2–4 sentence purpose", depth: "short" as const },
        { label: "Standard", description: "Purpose + fields + notes", depth: "standard" as const },
        {
          label: "Deep",
          description: "Use case, example, why-not-simpler, why this design wins",
          depth: "deep" as const
        }
      ],
      { title: "Codegraph explain depth", placeHolder: "How detailed should explanations be?" }
    );
    if (!picked) {
      return;
    }
    await vscode.workspace
      .getConfiguration("codegraph.explain")
      .update("depth", picked.depth, vscode.ConfigurationTarget.Workspace);
    lastLiveExplainKey = "";
    updateExplainDepthStatusBar();
    void vscode.window.showInformationMessage(`Explain depth: ${picked.label}`);
  });

  const rebuildIndexCommand = vscode.commands.registerCommand("codegraph.rebuildIndex", async () => {
    const folder = folderForIndex();
    if (!folder) {
      void vscode.window.showWarningMessage("Open a workspace folder to rebuild the Codegraph index.");
      return;
    }
    logCodegraph("Rebuilding local Python index…", true);
    try {
      const result = await ensureWorkspaceIndex(folder.uri.fsPath, { force: true });
      await rememberIndexResult(result);
      logCodegraph(
        `Index rebuilt: files=${result.total} changed=${result.changed} removed=${result.removed} skipped=${result.skipped} failed=${result.failed} path=${result.storagePath}`,
        true
      );
      void vscode.window.showInformationMessage(
        `Codegraph indexed ${result.total} Python files (${result.changed} parsed). Rebuild Local Index after upgrades that change the index schema.`
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logCodegraph(`Index rebuild failed: ${detail}`, true);
      void vscode.window.showErrorMessage(`Codegraph index failed: ${detail}`);
    }
  });

  const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
    if (document.languageId !== "python") {
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) {
      return;
    }
    const relative = vscode.workspace.asRelativePath(document.uri, false);
    void reindexPaths(folder.uri.fsPath, [relative]).then(async (result) => {
      await rememberIndexResult(result);
      logCodegraph(`Index updated ${relative} (files=${result.total})`);
    });
  });

  const configListener = vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (event.affectsConfiguration("codegraph.explain.depth")) {
      updateExplainDepthStatusBar();
    }
    if (!event.affectsConfiguration("codegraph.enrichment.provider")) {
      return;
    }
    const enrichment = vscode.workspace.getConfiguration("codegraph.enrichment");
    const providerId = String(enrichment.get<string>("provider") ?? "openrouter");
    const preset = getEnrichmentProviderPreset(providerId);
    if (preset.id === "custom") {
      return;
    }
    // Keep baseUrl empty for known providers — runtime resolves from preset.
    if (enrichment.get<string>("baseUrl")) {
      await enrichment.update("baseUrl", "", vscode.ConfigurationTarget.Workspace);
    }
    const currentModel = enrichment.get<string>("model")?.trim();
    const knownDefaults = new Set(ENRICHMENT_PROVIDER_PRESETS.map((item) => item.defaultModel));
    if (!currentModel || knownDefaults.has(currentModel)) {
      await enrichment.update("model", preset.defaultModel, vscode.ConfigurationTarget.Workspace);
    }
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
    configureApiCommand,
    testApiCommand,
    repoBriefCommand,
    setDepthCommand,
    rebuildIndexCommand,
    configListener,
    selectionListener,
    editorListener,
    saveListener,
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
  explainDepthStatusBar?.dispose();
  explainDepthStatusBar = undefined;
  extensionContext = undefined;
  for (const watcher of indexWatchers.values()) {
    watcher.close();
  }
  indexWatchers.clear();
  for (const timer of indexReloadTimers.values()) {
    clearTimeout(timer);
  }
  indexReloadTimers.clear();
}

async function warmWorkspaceIndex(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const preferred = folderForIndex();
  const ordered = preferred
    ? [preferred, ...folders.filter((folder) => folder.uri.fsPath !== preferred.uri.fsPath)]
    : folders;
  for (const folder of ordered) {
    try {
      const result = await ensureWorkspaceIndex(folder.uri.fsPath);
      await rememberIndexResult(result);
      logCodegraph(
        `Local index ready (${folder.name}): ${result.total} Python files (${result.changed} parsed, ${result.unchanged} cached)`
      );
    } catch (error) {
      logCodegraph(`Local index skipped (${folder.name}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
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
  const selected = editor.document.getText(selection).trim();
  // Live Explain usually has an empty selection — use the identifier under the cursor.
  const wordRange =
    selected.length === 0
      ? editor.document.getWordRangeAtPosition(selection.active, /[A-Za-z_][A-Za-z0-9_]*/)
      : undefined;
  const wordUnderCursor = wordRange ? editor.document.getText(wordRange).trim() : "";

  return {
    rootPath: workspaceFolder.uri.fsPath,
    filePath: vscode.workspace.asRelativePath(editor.document.uri, false),
    line: selection.active.line + 1,
    selectedText: selected || wordUnderCursor || undefined
  };
}

function modelAccessConfig(): {
  useBuiltInAgent: boolean;
  useApiKeyProvider: boolean;
  autoEnrichOnExplain: boolean;
  preferIdeHost: boolean;
  providerId: string;
  providerLabel: string;
  apiKey?: string;
  baseUrl: string;
  model: string;
} {
  const access = vscode.workspace.getConfiguration("codegraph.modelAccess");
  const enrichment = vscode.workspace.getConfiguration("codegraph.enrichment");
  const providerId = String(enrichment.get<string>("provider") ?? "openrouter");
  const preset = getEnrichmentProviderPreset(providerId);
  const apiKey =
    cachedApiKey?.trim() ||
    process.env.CODEGRAPH_API_KEY ||
    process.env.OPENAI_API_KEY;
  const legacyEnabled = Boolean(enrichment.get<boolean>("enabled"));
  const customBaseUrl = enrichment.get<string>("baseUrl")?.trim();

  const useApiKeyProvider = Boolean(access.get<boolean>("useApiKeyProvider")) || legacyEnabled;
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
    preferIdeHost: Boolean(enrichment.get<boolean>("preferIdeHost")),
    providerId: preset.id,
    providerLabel: preset.label,
    apiKey: apiKey || undefined,
    baseUrl: resolveEnrichmentBaseUrl(preset.id, customBaseUrl),
    model: String(enrichment.get<string>("model")?.trim() || preset.defaultModel)
  };
}

/**
 * Wizard: pick provider (auto base URL) → API key → model.
 */
async function configureApiProvider(options?: { enableApiKeyMode?: boolean }): Promise<boolean> {
  const enrichment = vscode.workspace.getConfiguration("codegraph.enrichment");
  const currentId = String(enrichment.get<string>("provider") ?? "openrouter");

  const picked = await vscode.window.showQuickPick(
    ENRICHMENT_PROVIDER_PRESETS.map((preset) => ({
      label: preset.label,
      description: preset.id === "custom" ? "set base URL next" : preset.baseUrl,
      detail: preset.description,
      preset
    })),
    {
      title: "Codegraph API provider",
      placeHolder: "Select a provider (base URL is set automatically)",
      ignoreFocusOut: true
    }
  );
  if (!picked) {
    return false;
  }

  const preset = picked.preset;
  let customBaseUrl = enrichment.get<string>("baseUrl")?.trim() || "";
  if (preset.id === "custom") {
    const entered = await vscode.window.showInputBox({
      title: "Custom OpenAI-compatible base URL",
      prompt: "Must expose POST /chat/completions (include /v1 if required)",
      value: customBaseUrl || "https://api.openai.com/v1",
      ignoreFocusOut: true
    });
    if (!entered?.trim()) {
      return false;
    }
    customBaseUrl = entered.trim().replace(/\/$/, "");
  }

  const existingKey = cachedApiKey?.trim();
  const apiKey = await vscode.window.showInputBox({
    title: `${preset.label} API key`,
    prompt: existingKey
      ? "Stored in VS Code Secret Storage. Leave empty to keep the current key."
      : "Stored in VS Code Secret Storage (not workspace settings).",
    password: true,
    placeHolder: existingKey ? "Key is set — enter a new key to replace" : "Paste API key",
    ignoreFocusOut: true
  });
  if (apiKey === undefined) {
    return false;
  }
  const resolvedKey = apiKey.trim() || existingKey;
  if (!resolvedKey) {
    void vscode.window.showWarningMessage("API key is required for API key mode.");
    return false;
  }

  const modelChoices = [
    ...modelPresetsForProvider(preset.id).map((id) => ({
      label: id,
      description: id === preset.defaultModel ? "default" : undefined,
      model: id
    })),
    { label: "Custom model id…", description: "type any model string", model: "__custom__" }
  ];
  const modelPick = await vscode.window.showQuickPick(modelChoices, {
    title: `${preset.label} model`,
    placeHolder: "Select a preset model",
    ignoreFocusOut: true
  });
  if (!modelPick) {
    return false;
  }

  let model = modelPick.model;
  if (model === "__custom__") {
    const entered = await vscode.window.showInputBox({
      title: `${preset.label} custom model`,
      prompt: "Model id for this provider",
      value: enrichment.get<string>("model")?.trim() || preset.defaultModel,
      ignoreFocusOut: true
    });
    if (!entered?.trim()) {
      return false;
    }
    model = entered.trim();
  }

  const baseUrl = resolveEnrichmentBaseUrl(preset.id, customBaseUrl);
  if (extensionContext) {
    await extensionContext.secrets.store(API_KEY_SECRET, resolvedKey);
  }
  cachedApiKey = resolvedKey;
  await enrichment.update("provider", preset.id, vscode.ConfigurationTarget.Workspace);
  await enrichment.update("apiKey", undefined, vscode.ConfigurationTarget.Workspace);
  await enrichment.update("model", model, vscode.ConfigurationTarget.Workspace);
  await enrichment.update("baseUrl", preset.id === "custom" ? baseUrl : "", vscode.ConfigurationTarget.Workspace);
  await enrichment.update("preferIdeHost", false, vscode.ConfigurationTarget.Workspace);

  if (options?.enableApiKeyMode !== false) {
    const access = vscode.workspace.getConfiguration("codegraph.modelAccess");
    await access.update("useApiKeyProvider", true, vscode.ConfigurationTarget.Workspace);
    await access.update("useBuiltInAgent", false, vscode.ConfigurationTarget.Workspace);
    await enrichment.update("enabled", true, vscode.ConfigurationTarget.Workspace);
  }

  const test = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Codegraph: testing API connection…" },
    async () =>
      testProviderConnection({
        providerId: preset.id,
        apiKey: resolvedKey,
        baseUrl,
        model
      })
  );

  if (test.ok) {
    void vscode.window.showInformationMessage(
      `Codegraph API OK · ${preset.label} · ${model} · ${test.latencyMs}ms`
    );
  } else {
    void vscode.window.showWarningMessage(
      `Codegraph saved ${preset.label}/${model}, but connection failed: ${test.error ?? "unknown"}`
    );
  }
  return true;
}

async function runTestApiConnection(): Promise<void> {
  const access = modelAccessConfig();
  if (!access.apiKey) {
    const configured = await configureApiProvider({ enableApiKeyMode: true });
    if (!configured) {
      return;
    }
  }
  const latest = modelAccessConfig();
  if (!latest.apiKey) {
    void vscode.window.showWarningMessage("No API key configured.");
    return;
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Codegraph: testing API connection…" },
    async () =>
      testProviderConnection({
        providerId: latest.providerId,
        apiKey: latest.apiKey!,
        baseUrl: latest.baseUrl,
        model: latest.model
      })
  );

  logCodegraph(
    `API test ${result.ok ? "OK" : "FAIL"} provider=${result.provider} model=${result.model} ${result.latencyMs}ms ${result.error ?? ""}`,
    true
  );
  if (result.ok) {
    void vscode.window.showInformationMessage(
      `Connection OK · ${latest.providerLabel} · ${result.model} · ${result.latencyMs}ms`
    );
  } else {
    void vscode.window.showErrorMessage(`Connection failed: ${result.error ?? "unknown error"}`);
  }
}

async function runRepoBrief(options?: { force?: boolean }): Promise<void> {
  const folder = folderForIndex();
  if (!folder) {
    void vscode.window.showWarningMessage("Open a folder workspace to run a repo brief.");
    return;
  }

  const rootPath = folder.uri.fsPath;
  const stateKey = `codegraph.repoBrief.done:${rootPath}`;
  if (!options?.force && extensionContext?.workspaceState.get<boolean>(stateKey)) {
    return;
  }

  const brief = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Codegraph: scanning repo brief…" },
    async () => buildRepoBrief(rootPath)
  );

  logCodegraph("=== Repo brief ===", true);
  for (const line of brief.summaryLines) {
    logCodegraph(line);
  }
  for (const symbol of brief.notableSymbols.slice(0, 16)) {
    logCodegraph(`- ${symbol.kind} ${symbol.name} @ ${symbol.file}:${symbol.line}`);
  }

  await extensionContext?.workspaceState.update(stateKey, true);

  const access = modelAccessConfig();
  if (access.useBuiltInAgent && !access.useApiKeyProvider) {
    const prompt = buildRepoBriefAgentPrompt({
      rootPath: brief.rootPath,
      summaryLines: brief.summaryLines,
      notableSymbols: brief.notableSymbols
    });
    const ok = await handOffToCursorAgent(prompt, { forceNew: true });
    void vscode.window.showInformationMessage(
      ok
        ? "Repo brief sent to Agent chat."
        : "Repo brief ready in Output → Codegraph (Agent auto-send failed)."
    );
    return;
  }

  if (access.useApiKeyProvider && extensionContext) {
    const pending = {
      ...pointerContext({
        rootPath,
        filePath: brief.entrypoints[0] ?? brief.notableSymbols[0]?.file ?? ".",
        line: brief.notableSymbols[0]?.line ?? 1,
        selectedText: brief.notableSymbols[0]?.name
      }),
      explanation: {
        ...pointerContext({
          rootPath,
          filePath: brief.entrypoints[0] ?? ".",
          line: 1
        }).explanation,
        summary: "Repository brief",
        whyItExists: brief.summaryLines.join("\n\n"),
        whatItDoes: brief.notableSymbols
          .slice(0, 12)
          .map((item) => `| ${item.name} | ${item.kind} @ ${item.file}:${item.line} |`)
          .join("\n"),
        howItWorks: brief.entrypoints.length
          ? `Entrypoints:\n${brief.entrypoints.map((item) => `- ${item}`).join("\n")}`
          : "",
        codebaseUsage: "Ask about a file, or turn on Live Explain and keep moving.",
        sources: brief.notableSymbols.slice(0, 12).map((item) => ({
          file: item.file,
          line: item.line,
          kind: "definition" as const
        }))
      },
      enrichment: {
        used: true,
        provider: "repo-brief",
        model: "local-scan"
      }
    };
    currentSession = {
      request: {
        rootPath,
        filePath: brief.entrypoints[0] ?? brief.notableSymbols[0]?.file ?? ".",
        line: brief.notableSymbols[0]?.line ?? 1,
        selectedText: brief.notableSymbols[0]?.name
      },
      result: pending
    };
    renderExplainPanel(extensionContext, currentSession.request, pending, { live: false, announce: false });
    void vscode.window.showInformationMessage("Repo brief ready in the Codegraph panel.");
    return;
  }

  void vscode.window.showInformationMessage("Repo brief written to Output → Codegraph.");
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
        error: "API key provider enabled but no API key is configured. Run “Codegraph: Configure API Provider”."
      }
    };
  }

  return enrichSelectionContext(deterministic, {
    enabled: true,
    trustProviderConfig: true,
    depth: explainDepthSetting(),
    provider: {
      providerId: access.providerId,
      apiKey: access.apiKey,
      baseUrl: access.baseUrl,
      model: access.model
    }
  });
}

async function enrichViaAgent(
  request: { rootPath: string; filePath: string; line: number; selectedText?: string },
  options?: { handOff?: boolean; forceNewChat?: boolean; neighborhoodLines?: string[] }
): Promise<EnrichedSelectionContext> {
  const prompt = buildPointerAgentHandoffPrompt({
    ...request,
    depth: explainDepthSetting(),
    neighborhoodLines: options?.neighborhoodLines ?? neighborhoodForRequest(request)
  });
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

  const result = await autoSendToCursorAgent(prompt, {
    forceNew: options?.forceNew,
    log: (message) => getOutputChannel().appendLine(message)
  });
  if (result.opened) {
    agentChatOpened = true;
  }
  return result.submitted;
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
  options?: { live?: boolean; handOffAgent?: boolean; neighborhoodLines?: string[] }
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
      forceNewChat: !agentChatOpened,
      neighborhoodLines: options?.neighborhoodLines
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
  const neighborhoodLines = neighborhoodForRequest(request);
  if (live && editor) {
    captureEditorState(editor, request, undefined, neighborhoodLines);
  }

  // Agent mode: slim pointer only — answer lives in Agent chat (no Jump panel).
  if (agentMode) {
    logCodegraph(`Agent mode explain for ${request.filePath}:${request.line} (live=${live})`, true);
    const result = await enrichGroundedContext(request, pointerContext(request), {
      live,
      handOffAgent: options?.handOffAgent ?? true,
      neighborhoodLines
    });
    if (live && generation !== liveExplainGeneration) {
      logCodegraph(
        `Agent handoff aborted (superseded by newer symbol) for ${request.filePath}:${request.line}`,
        true
      );
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
  panel.webview.html = renderExplanationHtml(request.filePath, request.line, result, {
    logoUri: extensionIconWebviewUri(panel.webview),
    webview: panel.webview
  });
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
      "Codegraph",
      vscode.ViewColumn.Beside,
      {
        enableFindWidget: true,
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")]
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
    depth?: string;
  };

  if (parsed.type === "openSource" && parsed.file && currentSession) {
    await openSourceLocation(currentSession.request.rootPath, parsed.file, parsed.line ?? 1);
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

  if (parsed.type === "setExplainDepth") {
    const depth = parsed.depth === "short" || parsed.depth === "deep" || parsed.depth === "standard"
      ? parsed.depth
      : "standard";
    await vscode.workspace
      .getConfiguration("codegraph.explain")
      .update("depth", depth, vscode.ConfigurationTarget.Workspace);
    lastLiveExplainKey = "";
    updateExplainDepthStatusBar();
    void vscode.window.showInformationMessage(`Explain depth: ${depth}`);
    if (panel && currentSession) {
      panel.webview.html = renderExplanationHtml(
        currentSession.request.filePath,
        currentSession.request.line,
        currentSession.result,
        { logoUri: extensionIconWebviewUri(panel.webview), webview: panel.webview }
      );
    }
    return;
  }

  if (parsed.type === "repoBrief") {
    await runRepoBrief({ force: true });
    return;
  }

  if (parsed.type === "testApiConnection") {
    await runTestApiConnection();
    return;
  }

  if (parsed.type === "setModelAccess") {
    const config = vscode.workspace.getConfiguration("codegraph.modelAccess");
    let useBuiltInAgent = Boolean(parsed.useBuiltInAgent);
    const useApiKeyProvider = Boolean(parsed.useApiKeyProvider);

    if (useApiKeyProvider && useBuiltInAgent) {
      useBuiltInAgent = false;
    }
    if (!useApiKeyProvider && !useBuiltInAgent) {
      useBuiltInAgent = true;
    }

    if (useApiKeyProvider) {
      const configured = await configureApiProvider({ enableApiKeyMode: true });
      if (!configured) {
        return;
      }
    } else {
      await config.update("useBuiltInAgent", useBuiltInAgent, vscode.ConfigurationTarget.Workspace);
      await config.update("useApiKeyProvider", false, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace
        .getConfiguration("codegraph.enrichment")
        .update("enabled", false, vscode.ConfigurationTarget.Workspace);
    }

    if (currentSession && extensionContext) {
      await runExplainSelection(extensionContext, currentSession.request, {
        live: liveExplainEnabled,
        handOffAgent: false
      });
    }

    void vscode.window.showInformationMessage(
      useApiKeyProvider
        ? "API key mode: enriched answers show in the Codegraph panel."
        : "Agent mode: answers show in Cursor Agent chat."
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

function extensionIconWebviewUri(webview: vscode.Webview): string | undefined {
  if (!extensionContext) {
    return undefined;
  }
  const iconPath = vscode.Uri.joinPath(extensionContext.extensionUri, "media", "icon.png");
  if (!fs.existsSync(iconPath.fsPath)) {
    return undefined;
  }
  return webview.asWebviewUri(iconPath).toString();
}

function renderExplanationHtml(
  filePath: string,
  line: number,
  result: EnrichedSelectionContext,
  options?: { logoUri?: string; webview?: vscode.Webview }
): string {
  const definition = result.explanation.sources.find((source) => source.kind === "definition") ?? result.explanation.sources[0];
  const endLineGuess =
    definition?.excerpt && definition.line
      ? definition.line + Math.max(0, definition.excerpt.split("\n").length - 1)
      : line;
  const locationLabel = `${shortFileLabel(filePath)} line ${line}`;
  // Agent mode marks enrichment.used when chat handoff succeeds, but the write-up
  // lives in Agent chat — only treat API (or other in-panel) enrichment as "enriched".
  const agentPanel =
    result.enrichment?.provider === "cursor-agent" || result.enrichment?.provider === "agent";
  const enriched = Boolean(result.enrichment?.used) && !agentPanel && Boolean(result.explanation.whyItExists);
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
  const logoUri = options?.logoUri;
  const nonce = randomBytes(16).toString("base64");
  const cspSource = options?.webview?.cspSource ?? "https:";
  const depth = explainDepthSetting();
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
      <p class="pending">${
        result.enrichment?.provider === "cursor-agent" || result.enrichment?.provider === "agent"
          ? "Full write-up is in <strong>Agent chat</strong>."
          : "Source window ready — waiting for API enrichment."
      }</p>
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
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
      <style>
        :root {
          --cg-teal: #2dd4bf;
          --cg-cyan: #22d3ee;
          --cg-amber: #f59e0b;
        }
        body {
          font-family: var(--vscode-font-family);
          color: var(--vscode-editor-foreground);
          padding: 18px 18px 28px;
          line-height: 1.55;
          max-width: 720px;
        }
        .brand {
          display: flex;
          align-items: center;
          gap: 10px;
          margin: 0 0 14px;
        }
        .brand img {
          width: 28px;
          height: 28px;
          border-radius: 7px;
          flex: 0 0 auto;
        }
        .brand-name {
          font-size: 0.78rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--vscode-descriptionForeground);
          font-weight: 600;
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
        .toolbar {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
          margin: 0 0 14px;
          font-size: 0.82rem;
        }
        .chip {
          border: 1px solid var(--vscode-input-border, transparent);
          background: var(--vscode-button-secondaryBackground, transparent);
          color: var(--vscode-foreground);
          border-radius: 999px;
          padding: 3px 10px;
          cursor: pointer;
          font: inherit;
        }
        .chip.active {
          border-color: var(--cg-teal);
          color: var(--cg-teal);
        }
        @media (max-width: 520px) {
        }
      </style>
    </head>
    <body>
      <div class="brand">
        ${
          logoUri
            ? `<img src="${escapeAttribute(logoUri)}" alt="Codegraph" />`
            : `<span class="brand-name">◆</span>`
        }
        <span class="brand-name">Codegraph</span>
      </div>
      <div class="toolbar">
        <span class="muted">Depth</span>
        <button class="chip ${depth === "short" ? "active" : ""}" data-action="setExplainDepth" data-depth="short">Short</button>
        <button class="chip ${depth === "standard" ? "active" : ""}" data-action="setExplainDepth" data-depth="standard">Standard</button>
        <button class="chip ${depth === "deep" ? "active" : ""}" data-action="setExplainDepth" data-depth="deep">Deep</button>
        <button class="chip" data-action="repoBrief">Repo brief</button>
      </div>
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

      <script nonce="${nonce}">
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
            const type = node.getAttribute("data-action");
            const depth = node.getAttribute("data-depth");
            vscode.postMessage(depth ? { type, depth } : { type });
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
