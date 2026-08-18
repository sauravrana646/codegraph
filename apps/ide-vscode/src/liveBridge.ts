import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { buildPointerAgentHandoffPrompt, type ExplainDepth } from "@codegraph/model-gateway";
import { redactSecrets } from "@codegraph/security";

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

const WAKE_LOG_MAX_BYTES = 256 * 1024;

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
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // ignore platforms that cannot chmod
  }
}

function writeEnabled(dir: string, enabled: boolean): void {
  ensureDir(dir);
  const enabledPath = path.join(dir, "enabled");
  if (enabled) {
    fs.writeFileSync(enabledPath, "1\n", { encoding: "utf8", mode: 0o600 });
  } else if (fs.existsSync(enabledPath)) {
    fs.unlinkSync(enabledPath);
  }
}

function writeState(dir: string, state: LiveCursorState): void {
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

function rotateWakeLog(logPath: string): void {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size <= WAKE_LOG_MAX_BYTES) {
      return;
    }
    const rotated = `${logPath}.1`;
    try {
      fs.unlinkSync(rotated);
    } catch {
      // ignore
    }
    fs.renameSync(logPath, rotated);
  } catch {
    // missing log is fine
  }
}

function appendWake(dir: string, state: LiveCursorState): void {
  ensureDir(dir);
  const logPath = path.join(dir, "wake.log");
  rotateWakeLog(logPath);
  const line = [
    state.iso,
    state.absolutePath,
    String(state.line),
    state.selection.replace(/\s+/g, " ").slice(0, 120)
  ].join("\t");
  fs.appendFileSync(logPath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
}

function writePendingPrompt(dir: string, state: LiveCursorState, neighborhoodLines: string[]): void {
  ensureDir(dir);
  const depthRaw =
    vscode.workspace.getConfiguration("codegraph.explain").get<string>("depth") ?? "standard";
  const depth: ExplainDepth =
    depthRaw === "short" || depthRaw === "deep" ? depthRaw : "standard";
  const prompt = buildPointerAgentHandoffPrompt({
    rootPath: state.rootPath,
    filePath: state.filePath,
    line: state.line,
    selectedText: state.selection || state.selectedText,
    depth,
    neighborhoodLines
  });
  fs.writeFileSync(path.join(dir, "pending-prompt.md"), `${prompt}\n`, { encoding: "utf8", mode: 0o600 });
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
  neighborhoodLines?: string[];
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

  const selection = redactSecrets((input.selectedText ?? "").trim());
  const neighborhoodLines = input.neighborhoodLines ?? [];
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
      writePendingPrompt(dir, state, neighborhoodLines);
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
  },
  neighborhoodLines?: string[]
): void {
  publishLiveCursorState({
    rootPath: request.rootPath,
    filePath: request.filePath,
    absolutePath: editor.document.uri.fsPath,
    line: request.line,
    column: editor.selection.active.character,
    selectedText: request.selectedText,
    languageId: editor.document.languageId,
    neighborhoodLines,
    grounded
  });
}
