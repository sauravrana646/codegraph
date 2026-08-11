#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import http from "node:http";

import {
  runExplainSelectionTool,
  runFindDefinitionTool,
  runFindUsagesTool,
  runLogicalSectionTool,
  runNamedTool,
  type ToolRequest
} from "@codegraph/agent-tools";
import { toolError, type LogicalSectionDepth, type ToolEnvelope, type ToolName } from "@codegraph/protocol";

interface RuntimeRequestBody extends ToolRequest {}

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

function isLogicalSectionDepth(value: unknown): value is LogicalSectionDepth {
  return value === "statement" || value === "function" || value === "class" || value === "auto";
}

function isRuntimeRequestBody(value: unknown): value is RuntimeRequestBody {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RuntimeRequestBody>;
  return (
    typeof candidate.rootPath === "string" &&
    typeof candidate.filePath === "string" &&
    typeof candidate.line === "number" &&
    (candidate.selectedText === undefined || typeof candidate.selectedText === "string") &&
    (candidate.depth === undefined || isLogicalSectionDepth(candidate.depth)) &&
    (candidate.enrich === undefined || typeof candidate.enrich === "boolean") &&
    (candidate.provider === undefined || typeof candidate.provider === "object")
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
    selectedText: overrides?.selectedText ?? baseRequest.selectedText,
    depth: overrides?.depth ?? baseRequest.depth,
    enrich: overrides?.enrich ?? baseRequest.enrich,
    provider: overrides?.provider ?? baseRequest.provider
  };
}

function withSession(
  tool: ToolName,
  session: RuntimeSession,
  result: ToolEnvelope<unknown>,
  action?: string
): ToolEnvelope<unknown> {
  if (!result.ok) {
    return result;
  }

  return {
    ...result,
    tool,
    session: {
      sessionId: session.sessionId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ttlMs: SESSION_TTL_MS,
      ...(action ? { action } : {})
    }
  };
}

async function handleToolRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  try {
    pruneExpiredSessions();

    if (request.method === "GET" && request.url === "/health") {
      writeJson(response, 200, {
        ok: true,
        tool: "health",
        data: {
          service: "codegraph-runtime",
          activeSessions: sessions.size,
          enrichmentConfigured: Boolean(process.env.CODEGRAPH_API_KEY || process.env.OPENAI_API_KEY)
        }
      });
      return;
    }

    if (request.method !== "POST" || !request.url) {
      writeJson(response, 404, toolError("not_found", "Not found"));
      return;
    }

    const payload = await readJsonBody(request);

    if (request.url === "/v1/sessions/explain-selection") {
      if (!isRuntimeRequestBody(payload)) {
        writeJson(
          response,
          400,
          toolError(
            "invalid_request",
            "Invalid request body. Expected { rootPath, filePath, line, selectedText?, depth?, enrich?, provider? }",
            "sessions.explain-selection"
          )
        );
        return;
      }

      const session = createSession(payload);
      const result = await runExplainSelectionTool(payload);
      writeJson(response, 200, withSession("sessions.explain-selection", session, result));
      return;
    }

    if (request.url === "/v1/sessions/followup") {
      if (!isSessionFollowupBody(payload)) {
        writeJson(
          response,
          400,
          toolError(
            "invalid_request",
            "Invalid session follow-up body. Expected { sessionId, action, requestOverrides? }",
            "sessions.followup"
          )
        );
        return;
      }

      const session = sessions.get(payload.sessionId);

      if (!session) {
        writeJson(
          response,
          404,
          toolError("session_not_found", "Session not found or expired", "sessions.followup")
        );
        return;
      }

      session.request = mergeRequest(session.request, payload.requestOverrides);
      session.updatedAt = Date.now();

      const result = await runNamedTool(payload.action, session.request);
      writeJson(response, 200, withSession("sessions.followup", session, result, payload.action));
      return;
    }

    if (!isRuntimeRequestBody(payload)) {
      writeJson(
        response,
        400,
        toolError(
          "invalid_request",
          "Invalid request body. Expected { rootPath, filePath, line, selectedText?, depth?, enrich?, provider? }"
        )
      );
      return;
    }

    if (request.url === "/v1/tools/explain-selection") {
      writeJson(response, 200, await runExplainSelectionTool(payload));
      return;
    }

    if (request.url === "/v1/tools/find-definition") {
      writeJson(response, 200, await runFindDefinitionTool(payload));
      return;
    }

    if (request.url === "/v1/tools/find-usages") {
      writeJson(response, 200, await runFindUsagesTool(payload));
      return;
    }

    if (request.url === "/v1/tools/logical-section") {
      writeJson(response, 200, await runLogicalSectionTool(payload));
      return;
    }

    writeJson(response, 404, toolError("unknown_endpoint", "Unknown endpoint"));
  } catch (error) {
    writeJson(
      response,
      500,
      toolError("runtime_error", error instanceof Error ? error.message : "Unknown runtime error")
    );
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

  const result = await runExplainSelectionTool({
    rootPath,
    filePath,
    line,
    selectedText: selectedTextParts.join(" ") || undefined,
    enrich: process.env.CODEGRAPH_ENRICH === "1" || process.env.CODEGRAPH_ENRICH === "true"
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
  const [, , firstArg, ...rest] = process.argv;

  if (!firstArg || firstArg === "explain") {
    await runExplainCommand(firstArg === "explain" ? rest : firstArg ? [firstArg, ...rest] : []);
    return;
  }

  if (firstArg === "serve") {
    await runServerCommand(rest);
    return;
  }

  // Backward-compatible: treat a bare workspace path as explain mode.
  if (firstArg.startsWith("/") || firstArg.startsWith(".")) {
    await runExplainCommand([firstArg, ...rest]);
    return;
  }

  printUsage();
  process.exitCode = 1;
}

void main();
