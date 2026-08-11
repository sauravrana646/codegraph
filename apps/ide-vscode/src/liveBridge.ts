import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

export interface LiveCursorState {
  path: string;
  absolutePath: string;
  filePath: string;
  rootPath: string;
  line: number;
  column: number;
  selection: string;
  selectedText: string;
  languageId: string;
  ts: number;
  iso: string;
}

function homeCursorDir(...parts: string[]): string {
  return path.join(os.homedir(), ".cursor", ...parts);
}

export function codegraphRuntimeDir(): string {
  return homeCursorDir("codegraph");
}

export function learnCodebaseRuntimeDir(): string {
  return homeCursorDir("learn-codebase");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeEnabled(dir: string, enabled: boolean): void {
  ensureDir(dir);
  const enabledPath = path.join(dir, "enabled");
  if (enabled) {
    fs.writeFileSync(enabledPath, "1\n", "utf8");
  } else if (fs.existsSync(enabledPath)) {
    fs.unlinkSync(enabledPath);
  }
}

function writeState(dir: string, state: LiveCursorState): void {
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function appendWake(dir: string, state: LiveCursorState): void {
  ensureDir(dir);
  const line = [
    state.iso,
    state.absolutePath,
    String(state.line),
    state.selection.replace(/\s+/g, " ").slice(0, 120)
  ].join("\t");
  fs.appendFileSync(path.join(dir, "wake.log"), `${line}\n`, "utf8");
}

function writePendingPrompt(dir: string, state: LiveCursorState): void {
  ensureDir(dir);
  // Slim pointer only — Agent reads source (no AST/LSP dumps).
  const depthRaw =
    vscode.workspace.getConfiguration("codegraph.explain").get<string>("depth") ?? "standard";
  const depth = depthRaw === "short" || depthRaw === "deep" ? depthRaw : "standard";
  const prompt = [
    "codegraph-slim-v3",
    "Use the Codegraph skill / MCP tools.",
    "Codegraph Live Explain — answer in this Agent chat.",
    "Do not ask for API keys.",
    "Do NOT use AST/LSP dumps. Read the source yourself.",
    "",
    "TARGET:",
    `rootPath: ${state.rootPath}`,
    `filePath: ${state.filePath}`,
    `line: ${state.line}`,
    `symbol: ${state.selection || "(cursor only)"}`,
    `depth: ${depth}`,
    "",
    "REQUIRED FLOW:",
    "1) Open/read `filePath` around `line` (or call Codegraph `logical_section`).",
    "2) Explain from that source. Optionally call `find_definition` / `find_usages` for file:line locations only.",
    "3) Do not request or rely on AST/LSP context blobs.",
    "",
    "Rules: cite real file:line; never invent files/symbols; keep it concise."
  ].join("\n");
  fs.writeFileSync(path.join(dir, "pending-prompt.md"), `${prompt}\n`, "utf8");
}

export function liveBridgeConfig(): { writeBridge: boolean; compatLearnCodebase: boolean } {
  const cfg = vscode.workspace.getConfiguration("codegraph.liveExplain");
  return {
    writeBridge: cfg.get<boolean>("writeAgentBridge") !== false,
    compatLearnCodebase: cfg.get<boolean>("compatLearnCodebase") !== false
  };
}

export function setLiveBridgeEnabled(enabled: boolean): void {
  const { writeBridge, compatLearnCodebase } = liveBridgeConfig();
  if (!writeBridge) {
    // Still clear markers if disabling.
    if (!enabled) {
      try {
        writeEnabled(codegraphRuntimeDir(), false);
        writeEnabled(learnCodebaseRuntimeDir(), false);
      } catch {
        // ignore
      }
    }
    return;
  }

  try {
    writeEnabled(codegraphRuntimeDir(), enabled);
    if (compatLearnCodebase) {
      writeEnabled(learnCodebaseRuntimeDir(), enabled);
    } else if (!enabled) {
      writeEnabled(learnCodebaseRuntimeDir(), false);
    }
  } catch (error) {
    console.error("Codegraph live bridge enable failed", error);
  }
}

export function publishLiveCursorState(input: {
  rootPath: string;
  filePath: string;
  absolutePath: string;
  line: number;
  column: number;
  selectedText?: string;
  languageId: string;
  grounded?: {
    summary?: string;
    whatItDoes?: string;
    whyItExists?: string;
    howItWorks?: string;
    codebaseUsage?: string;
    sources?: string[];
  };
}): LiveCursorState | undefined {
  const { writeBridge, compatLearnCodebase } = liveBridgeConfig();
  if (!writeBridge) {
    return undefined;
  }

  const selection = (input.selectedText ?? "").trim();
  const state: LiveCursorState = {
    path: input.absolutePath,
    absolutePath: input.absolutePath,
    filePath: input.filePath,
    rootPath: input.rootPath,
    line: input.line,
    column: input.column,
    selection,
    selectedText: selection,
    languageId: input.languageId,
    ts: Date.now(),
    iso: new Date().toISOString()
  };

  try {
    const dirs = [codegraphRuntimeDir()];
    if (compatLearnCodebase) {
      dirs.push(learnCodebaseRuntimeDir());
    }

    for (const dir of dirs) {
      writeState(dir, state);
      appendWake(dir, state);
      writePendingPrompt(dir, state);
    }

    return state;
  } catch (error) {
    console.error("Codegraph live bridge publish failed", error);
    return undefined;
  }
}

export function captureEditorState(
  editor: vscode.TextEditor,
  request: { rootPath: string; filePath: string; line: number; selectedText?: string },
  grounded?: {
    summary?: string;
    whatItDoes?: string;
    whyItExists?: string;
    howItWorks?: string;
    codebaseUsage?: string;
    sources?: string[];
  }
): void {
  publishLiveCursorState({
    rootPath: request.rootPath,
    filePath: request.filePath,
    absolutePath: editor.document.uri.fsPath,
    line: request.line,
    column: editor.selection.active.character,
    selectedText: request.selectedText,
    languageId: editor.document.languageId,
    grounded
  });
}
