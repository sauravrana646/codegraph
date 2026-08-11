import * as path from "node:path";
import * as vscode from "vscode";

export interface LspLocationRef {
  file: string;
  line: number;
  excerpt?: string;
  kind: "definition" | "reference";
}

export interface LspGatherResult {
  definitions: LspLocationRef[];
  references: LspLocationRef[];
  hoverText?: string;
  used: boolean;
}

function toWorkspaceRelative(rootPath: string, uri: vscode.Uri): string {
  const rel = vscode.workspace.asRelativePath(uri, false);
  if (rel && rel !== uri.fsPath) {
    return rel.replace(/\\/g, "/");
  }
  return path.relative(rootPath, uri.fsPath).replace(/\\/g, "/");
}

async function excerptAt(uri: vscode.Uri, line: number): Promise<string | undefined> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const start = Math.max(0, line - 2);
    const end = Math.min(doc.lineCount, line + 3);
    const lines: string[] = [];
    for (let i = start; i < end; i += 1) {
      lines.push(doc.lineAt(i).text);
    }
    return lines.join("\n");
  } catch {
    return undefined;
  }
}

function locationLine(loc: vscode.Location | vscode.LocationLink): { uri: vscode.Uri; line: number } | undefined {
  if (loc instanceof vscode.Location) {
    return { uri: loc.uri, line: loc.range.start.line + 1 };
  }
  const target = loc.targetUri;
  const range = loc.targetSelectionRange ?? loc.targetRange;
  if (!target || !range) {
    return undefined;
  }
  return { uri: target, line: range.start.line + 1 };
}

export async function gatherIdeLspContext(
  editor: vscode.TextEditor,
  rootPath: string
): Promise<LspGatherResult> {
  const position = editor.selection.active;
  const uri = editor.document.uri;
  const definitions: LspLocationRef[] = [];
  const references: LspLocationRef[] = [];
  let hoverText: string | undefined;
  let used = false;

  try {
    const defResults =
      (await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
        "vscode.executeDefinitionProvider",
        uri,
        position
      )) ?? [];

    for (const item of defResults.slice(0, 8)) {
      const loc = locationLine(item);
      if (!loc) {
        continue;
      }
      used = true;
      definitions.push({
        file: toWorkspaceRelative(rootPath, loc.uri),
        line: loc.line,
        excerpt: await excerptAt(loc.uri, loc.line),
        kind: "definition"
      });
    }
  } catch {
    // LSP definition provider unavailable.
  }

  try {
    const refResults =
      (await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        uri,
        position
      )) ?? [];

    for (const item of refResults.slice(0, 20)) {
      const loc = locationLine(item);
      if (!loc) {
        continue;
      }
      const file = toWorkspaceRelative(rootPath, loc.uri);
      if (definitions.some((definition) => definition.file === file && definition.line === loc.line)) {
        continue;
      }
      used = true;
      references.push({
        file,
        line: loc.line,
        excerpt: await excerptAt(loc.uri, loc.line),
        kind: "reference"
      });
    }
  } catch {
    // LSP reference provider unavailable.
  }

  try {
    const hovers =
      (await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        uri,
        position
      )) ?? [];
    const chunks: string[] = [];
    for (const hover of hovers.slice(0, 3)) {
      for (const part of hover.contents) {
        if (typeof part === "string") {
          chunks.push(part);
        } else if ("value" in part) {
          chunks.push(part.value);
        }
      }
    }
    if (chunks.length > 0) {
      used = true;
      hoverText = chunks.join("\n").slice(0, 4000);
    }
  } catch {
    // Hover provider unavailable.
  }

  return { definitions, references, hoverText, used };
}
