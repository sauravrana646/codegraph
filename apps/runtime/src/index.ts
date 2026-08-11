#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import http from "node:http";

import { buildSelectionContext, findDefinition, findUsages, getLogicalSection } from "@codegraph/core";

interface RuntimeRequestBody {
  rootPath: string;
  filePath: string;
  line: number;
  selectedText?: string;
}

type SessionAction = "explain-selection" | "find-definition" | "find-usages" | "logical-section";

interface SessionFollowupBody {
  sessionId: string;
  action: SessionAction;
  requestOverrides?: Partial<RuntimeRequestBody>;
}

interface RuntimeSession {
  sessionId: string;
  request: RuntimeRequestBody;
  createdAt: number;
  updatedAt: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000;
const sessions = new Map<string, RuntimeSession>();

function isRuntimeRequestBody(value: unknown): value is RuntimeRequestBody {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RuntimeRequestBody>;
  return (
    typeof candidate.rootPath === "string" &&
    typeof candidate.filePath === "string" &&
    typeof candidate.line === "number" &&
    (candidate.selectedText === undefined || typeof candidate.selectedText === "string")
  );
}

function isSessionFollowupBody(value: unknown): value is SessionFollowupBody {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SessionFollowupBody>;
  return (
    typeof candidate.sessionId === "string" &&
    (candidate.action === "explain-selection" ||
      candidate.action === "find-definition" ||
      candidate.action === "find-usages" ||
      candidate.action === "logical-section") &&
    (candidate.requestOverrides === undefined || typeof candidate.requestOverrides === "object")
  );
}

function printUsage(): void {
  console.error(
    [
      "Usage:",
      "  codegraph-runtime explain <workspace-root> <file-path> <line> [selectedText]",
      "  codegraph-runtime serve [port]"
    ].join("\n")
  );
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const bodyText = Buffer.concat(chunks).toString("utf8");
  return bodyText ? JSON.parse(bodyText) : {};
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function pruneExpiredSessions(): void {
  const now = Date.now();

  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.updatedAt > SESSION_TTL_MS) {
      sessions.delete(sessionId);
    }
  }
}

function createSession(request: RuntimeRequestBody): RuntimeSession {
  const now = Date.now();
  const session: RuntimeSession = {
    sessionId: randomUUID(),
    request,
    createdAt: now,
    updatedAt: now
  };
  sessions.set(session.sessionId, session);
  return session;
}

function mergeRequest(
  baseRequest: RuntimeRequestBody,
  overrides?: Partial<RuntimeRequestBody>
): RuntimeRequestBody {
  return {
    rootPath: overrides?.rootPath ?? baseRequest.rootPath,
    filePath: overrides?.filePath ?? baseRequest.filePath,
    line: overrides?.line ?? baseRequest.line,
    selectedText: overrides?.selectedText ?? baseRequest.selectedText
  };
}

async function runAction(action: SessionAction, request: RuntimeRequestBody): Promise<unknown> {
  if (action === "explain-selection") {
    return buildSelectionContext(request);
  }

  if (action === "find-definition") {
    return findDefinition(request);
  }

  if (action === "find-usages") {
    return findUsages(request);
  }

  return getLogicalSection(request);
}

async function handleToolRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  try {
    pruneExpiredSessions();

    if (request.method === "GET" && request.url === "/health") {
      writeJson(response, 200, { ok: true, service: "codegraph-runtime", activeSessions: sessions.size });
      return;
    }

    if (request.method !== "POST" || !request.url) {
      writeJson(response, 404, { error: "Not found" });
      return;
    }

    const payload = await readJsonBody(request);

    if (request.url === "/v1/sessions/explain-selection") {
      if (!isRuntimeRequestBody(payload)) {
        writeJson(response, 400, {
          error: "Invalid request body. Expected { rootPath, filePath, line, selectedText? }"
        });
        return;
      }

      const session = createSession(payload);
      const result = await buildSelectionContext(payload);
      writeJson(response, 200, {
        sessionId: session.sessionId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        ttlMs: SESSION_TTL_MS,
        result
      });
      return;
    }

    if (request.url === "/v1/sessions/followup") {
      if (!isSessionFollowupBody(payload)) {
        writeJson(response, 400, {
          error: "Invalid session follow-up body. Expected { sessionId, action, requestOverrides? }"
        });
        return;
      }

      const session = sessions.get(payload.sessionId);

      if (!session) {
        writeJson(response, 404, { error: "Session not found or expired" });
        return;
      }

      session.request = mergeRequest(session.request, payload.requestOverrides);
      session.updatedAt = Date.now();

      writeJson(response, 200, {
        sessionId: session.sessionId,
        action: payload.action,
        updatedAt: session.updatedAt,
        result: await runAction(payload.action, session.request)
      });
      return;
    }

    if (!isRuntimeRequestBody(payload)) {
      writeJson(response, 400, {
        error: "Invalid request body. Expected { rootPath, filePath, line, selectedText? }"
      });
      return;
    }

    if (request.url === "/v1/tools/explain-selection") {
      writeJson(response, 200, await buildSelectionContext(payload));
      return;
    }

    if (request.url === "/v1/tools/find-definition") {
      writeJson(response, 200, await findDefinition(payload));
      return;
    }

    if (request.url === "/v1/tools/find-usages") {
      writeJson(response, 200, await findUsages(payload));
      return;
    }

    if (request.url === "/v1/tools/logical-section") {
      writeJson(response, 200, await getLogicalSection(payload));
      return;
    }

    writeJson(response, 404, { error: "Unknown endpoint" });
  } catch (error) {
    writeJson(response, 500, {
      error: error instanceof Error ? error.message : "Unknown runtime error"
    });
  }
}

async function runExplainCommand(args: string[]): Promise<void> {
  const [rootPath, filePath, lineArg, ...selectedTextParts] = args;

  if (!rootPath || !filePath || !lineArg) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const line = Number.parseInt(lineArg, 10);

  if (!Number.isInteger(line) || line < 1) {
    console.error(`Invalid line number: ${lineArg}`);
    process.exitCode = 1;
    return;
  }

  const result = await buildSelectionContext({
    rootPath,
    filePath,
    line,
    selectedText: selectedTextParts.join(" ") || undefined
  });

  console.log(JSON.stringify(result, null, 2));
}

async function runServerCommand(args: string[]): Promise<void> {
  const portArg = args[0] ?? process.env.CODEGRAPH_PORT ?? "4311";
  const port = Number.parseInt(portArg, 10);

  if (!Number.isInteger(port) || port < 1) {
    console.error(`Invalid port: ${portArg}`);
    process.exitCode = 1;
    return;
  }

  const server = http.createServer((request, response) => {
    void handleToolRequest(request, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  console.log(`Codegraph runtime listening on http://127.0.0.1:${port}`);
}

async function main(): Promise<void> {
  const [, , command = "explain", ...args] = process.argv;

  if (command === "serve") {
    await runServerCommand(args);
    return;
  }

  if (command === "explain") {
    await runExplainCommand(args);
    return;
  }

  printUsage();
  process.exitCode = 1;
}

void main();
