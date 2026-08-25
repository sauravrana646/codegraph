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

async function restoreClipboard(previous: string): Promise<void> {
  try {
    await vscode.env.clipboard.writeText(previous);
  } catch {
    // ignore restore failures
  }
}

export interface AgentAutoSendResult {
  opened: boolean;
  submitted: boolean;
}

async function macAutoSendToAgent(
  prompt: string,
  options?: { forceNew?: boolean; log?: (message: string) => void }
): Promise<AgentAutoSendResult> {
  if (process.platform !== "darwin") {
    return { opened: false, submitted: false };
  }

  const log = options?.log ?? (() => undefined);
  await vscode.env.clipboard.writeText(prompt);

  const openOrFocus = options?.forceNew
    ? 'keystroke "i" using {command down}\ndelay 0.5'
    : 'keystroke "i" using {command down}\ndelay 0.4';

  const script = `
tell application "Cursor" to activate
delay 0.3
tell application "System Events"
  tell process "Cursor"
    set frontmost to true
    ${openOrFocus}
    keystroke "a" using {command down}
    delay 0.1
    keystroke "v" using {command down}
    delay 0.35
    key code 36
  end tell
end tell
`;

  try {
    await execFileAsync("osascript", ["-e", script], { timeout: 10000 });
    log("macOS auto-send succeeded (Cmd+I → paste → Return)");
    return { opened: true, submitted: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`macOS auto-send failed: ${detail}`);
    if (/not allowed|osascript|1002|1743|accessibility|System Events/i.test(detail)) {
      void vscode.window.showErrorMessage(
        "Codegraph needs Accessibility permission. System Settings → Privacy & Security → Accessibility → enable Cursor, Quit Cursor, reopen."
      );
    }
    return { opened: false, submitted: false };
  }
}

/**
 * Fully automatic Agent handoff. On macOS, prefer Accessibility automation because
 * Cursor chat commands often "succeed" without actually inserting/submitting the prompt.
 * Auto-submit briefly uses the clipboard and restores it immediately after paste completes.
 */
export async function autoSendToCursorAgent(
  prompt: string,
  options?: { forceNew?: boolean; log?: (message: string) => void }
): Promise<AgentAutoSendResult> {
  const log = options?.log ?? (() => undefined);
  const previousClipboard = await vscode.env.clipboard.readText();
  await vscode.env.clipboard.writeText(prompt);
  log(`Auto-send starting (prompt chars=${prompt.length}, forceNew=${Boolean(options?.forceNew)})`);

  try {
    const macResult = await macAutoSendToAgent(prompt, { forceNew: options?.forceNew, log });
    if (macResult.submitted) {
      return macResult;
    }

    const openCommands = options?.forceNew
      ? ["composer.newAgentChat", "aichat.newchataction", "workbench.action.chat.newChat", "workbench.action.chat.open"]
      : ["composer.focusComposer", "composer.newAgentChat", "aichat.newchataction", "workbench.action.chat.open"];

    let opened = false;
    for (const command of openCommands) {
      if (await tryExecuteCommand(command)) {
        opened = true;
        log(`Opened/focused via ${command}`);
        break;
      }
      if (await tryExecuteCommand(command, { query: prompt })) {
        opened = true;
        log(`Opened with query via ${command}`);
        break;
      }
    }

    await sleep(500);
    await tryExecuteCommand("editor.action.clipboardPasteAction");
    await sleep(250);

    const submitCommands = [
      "composer.startGeneration",
      "workbench.action.chat.submit",
      "workbench.action.chat.send",
      "composer.submit",
      "chatEditor.action.submit"
    ];
    let submitted = false;
    for (const command of submitCommands) {
      if (await tryExecuteCommand(command)) {
        submitted = true;
        log(`Submitted via ${command}`);
        break;
      }
    }

    if (!opened) {
      log("Agent auto-send failed: could not open Agent chat");
      void vscode.window.showWarningMessage(
        "Codegraph could not open Agent chat. Open Agent once (Cmd+I), then toggle Live Explain again."
      );
      return { opened: false, submitted: false };
    }

    if (!submitted) {
      log("Agent opened/pasted but submit command unavailable");
      void vscode.window.showWarningMessage(
        "Codegraph pasted into Agent but could not auto-submit. On macOS enable Accessibility for Cursor."
      );
      return { opened: true, submitted: false };
    }

    return { opened: true, submitted: true };
  } finally {
    await restoreClipboard(previousClipboard);
  }
}
