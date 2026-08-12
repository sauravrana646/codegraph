import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createWorkspaceId } from "@codegraph/workspace";

export const SESSION_TTL_MS = 30 * 60 * 1000;

export interface UnderstandingSession {
  sessionId: string;
  workspaceId: string;
  rootPath: string;
  filePath: string;
  line: number;
  selectedText?: string;
  symbol?: string;
  definitionFiles: string[];
  usageFiles: string[];
  updatedAt: number;
}

function sessionPath(rootPath: string): string {
  const id = createWorkspaceId(path.resolve(rootPath));
  return path.join(os.homedir(), ".cursor", "codegraph", "sessions", `${id}.json`);
}

export async function rememberSession(session: UnderstandingSession): Promise<UnderstandingSession> {
  const payload: UnderstandingSession = { ...session, updatedAt: Date.now() };
  const file = sessionPath(session.rootPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

export async function loadSession(rootPath: string): Promise<UnderstandingSession | undefined> {
  try {
    const raw = await fs.readFile(sessionPath(rootPath), "utf8");
    const parsed = JSON.parse(raw) as UnderstandingSession;
    if (Date.now() - parsed.updatedAt > SESSION_TTL_MS) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}
