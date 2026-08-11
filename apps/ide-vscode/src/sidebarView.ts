import * as vscode from "vscode";

export const CODEGRAPH_VIEW_ID = "codegraph.sidebar";
export const CODEGRAPH_CONTAINER_ID = "codegraph";

/**
 * Activity-bar sidebar webview. Survives Cursor Agent chat, which closes
 * editor-area WebviewPanels opened with ViewColumn.Beside/Two.
 */
export class CodegraphSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = CODEGRAPH_VIEW_ID;

  private view?: vscode.WebviewView;
  private pendingHtml?: string;
  private readonly onMessage: (message: unknown) => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    onMessage: (message: unknown) => void
  ) {
    this.onMessage = onMessage;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
    };
    webviewView.webview.onDidReceiveMessage((message) => {
      this.onMessage(message);
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });

    webviewView.webview.html =
      this.pendingHtml ??
      `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:12px;color:var(--vscode-foreground)">
        <p><strong>Codegraph</strong></p>
        <p style="opacity:.8">Turn on <em>CG Live</em> and move your cursor in a Python file. Jump links appear here (not in Agent chat).</p>
      </body></html>`;
  }

  get webview(): vscode.Webview | undefined {
    return this.view?.webview;
  }

  setHtml(html: string): void {
    this.pendingHtml = html;
    if (this.view) {
      this.view.webview.html = html;
    }
  }

  /** Reveal the activity-bar Codegraph view without stealing Agent focus when possible. */
  async reveal(preserveFocus = true): Promise<void> {
    try {
      await vscode.commands.executeCommand(`workbench.view.extension.${CODEGRAPH_CONTAINER_ID}`);
    } catch {
      // ignore
    }
    try {
      await vscode.commands.executeCommand(`${CODEGRAPH_VIEW_ID}.focus`);
    } catch {
      // ignore
    }
    this.view?.show?.(preserveFocus);
  }
}
