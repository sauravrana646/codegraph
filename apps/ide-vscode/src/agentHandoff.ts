import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryExecuteCommand(command: string, ...args: unknown[]): Promise<boolean> {
  try {
    await vscode.commands.executeCommand(command, ...args);
    return true;
  } catch {
    return false;
  }
}

async function macAutoSendToAgent(prompt: string, options?: { forceNew?: boolean }): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }

  await vscode.env.clipboard.writeText(prompt);

  // Accessibility automation: focus Agent, replace input, submit with Return.
  // This is the only reliable auto-submit path on Cursor today (no manual Enter).
  const openOrFocus = options?.forceNew
    ? 'keystroke "i" using {command down}\ndelay 0.45'
    : 'keystroke "i" using {command down}\ndelay 0.35';

  const script = `
tell application "Cursor" to activate
delay 0.25
tell application "System Events"
  tell process "Cursor"
    set frontmost to true
    ${openOrFocus}
    keystroke "a" using {command down}
    delay 0.08
    keystroke "v" using {command down}
    delay 0.3
    key code 36
  end tell
end tell
`;

  try {
    await execFileAsync("osascript", ["-e", script], { timeout: 8000 });
    return true;
  } catch (error) {
    console.error("Codegraph macOS Agent auto-send failed", error);
    return false;
  }
}

/**
 * Fully automatic Agent handoff: open/focus Agent, insert grounded prompt, submit.
 * User should only move the cursor — no paste/Enter required.
 */
export async function autoSendToCursorAgent(
  prompt: string,
  options?: { forceNew?: boolean; log?: (message: string) => void }
): Promise<boolean> {
  const log = options?.log ?? (() => undefined);
  const previousClipboard = await vscode.env.clipboard.readText();
  await vscode.env.clipboard.writeText(prompt);

  // 1) Prefer native chat open with full query (works on some Cursor/VS Code builds).
  const nativeQueryAttempts: Array<{ command: string; args: unknown }> = [
    { command: "workbench.action.chat.open", args: { query: prompt, isPartialQuery: false } },
    { command: "workbench.action.chat.open", args: { query: prompt } },
    { command: "workbench.action.chat.open", args: prompt },
    { command: "composer.startComposerPrompt", args: prompt },
    { command: "composer.startComposerPrompt", args: { query: prompt } }
  ];

  for (const attempt of nativeQueryAttempts) {
    if (await tryExecuteCommand(attempt.command, attempt.args)) {
      await sleep(200);
      // Some hosts only fill the box — force generation.
      await tryExecuteCommand("composer.startGeneration");
      await tryExecuteCommand("workbench.action.chat.submit");
      log(`Native Agent query via ${attempt.command}`);
      setTimeout(() => void vscode.env.clipboard.writeText(previousClipboard), 2500);
      return true;
    }
  }

  // 2) macOS: System Events auto paste + Return (no manual Enter).
  if (await macAutoSendToAgent(prompt, { forceNew: options?.forceNew })) {
    log("macOS Agent auto-send (Cmd+I, paste, Return)");
    setTimeout(() => void vscode.env.clipboard.writeText(previousClipboard), 2500);
    return true;
  }

  // 3) Cross-platform command fallback: open, paste, submit commands.
  const openCommands = options?.forceNew
    ? ["composer.newAgentChat", "aichat.newchataction", "workbench.action.chat.newChat"]
    : ["composer.focusComposer", "composer.newAgentChat", "aichat.newchataction", "workbench.action.chat.open"];

  let opened = false;
  for (const command of openCommands) {
    if (await tryExecuteCommand(command)) {
      opened = true;
      break;
    }
  }

  await sleep(450);
  await tryExecuteCommand("editor.action.clipboardPasteAction");
  await sleep(200);

  const submitCommands = [
    "composer.startGeneration",
    "workbench.action.chat.submit",
    "composer.submit",
    "chatEditor.action.submit"
  ];
  let submitted = false;
  for (const command of submitCommands) {
    if (await tryExecuteCommand(command)) {
      submitted = true;
      break;
    }
  }

  setTimeout(() => void vscode.env.clipboard.writeText(previousClipboard), 2500);
  log(
    opened
      ? submitted
        ? "Agent open + paste + submit commands succeeded"
        : "Agent opened and pasted, but submit command unavailable on this Cursor build"
      : "Agent auto-send failed"
  );
  return opened && submitted;
}
