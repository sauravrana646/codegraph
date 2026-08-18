#!/usr/bin/env node
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import path from "node:path";

import {
  runEnsureIndexTool,
  runExplainSelectionTool,
  runFindDefinitionTool,
  runFindUsagesTool,
  runGetProjectOverviewTool,
  runGetSymbolContextTool,
  runLogicalSectionTool,
  runNamedTool,
  runSearchCodebaseTool,
  runTraceCallChainTool,
  type NamedToolAction,
  type ToolRequest
} from "@codegraph/agent-tools";
import { toolError, type LogicalSectionDepth, type ToolEnvelope, type ToolName } from "@codegraph/protocol";

type RuntimeRequestBody = ToolRequest;

type SessionAction = NamedToolAction;

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
const MAX_SESSIONS = 100;
const MAX_BODY_BYTES = 1_000_000;
const sessions = new Map<string, RuntimeSession>();

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function parseAllowedRoots(): string[] {
  const configured = (process.env.CODEGRAPH_ALLOWED_ROOTS ?? "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));
  if (configured.length > 0) {
    return configured;
  }
  return [path.resolve(process.cwd())];
}

let AUTH_TOKEN: string | undefined;
let ALLOW_ANONYMOUS = false;
let GENERATED_TOKEN = false;
const ALLOWED_ROOTS = parseAllowedRoots();

function initRuntimeSecurity(): void {
  ALLOW_ANONYMOUS = envFlag("CODEGRAPH_ALLOW_ANONYMOUS");
  const fromEnv = process.env.CODEGRAPH_RUNTIME_TOKEN?.trim();
  if (fromEnv) {
    AUTH_TOKEN = fromEnv;
    GENERATED_TOKEN = false;
    return;
  }
  if (ALLOW_ANONYMOUS) {
    AUTH_TOKEN = undefined;
    GENERATED_TOKEN = false;
    return;
  }
  AUTH_TOKEN = randomBytes(32).toString("hex");
  process.env.CODEGRAPH_RUNTIME_TOKEN = AUTH_TOKEN;
  GENERATED_TOKEN = true;
}

function isLogicalSectionDepth(value: unknown): value is LogicalSectionDepth {
  return value === "statement" || value === "function" || value === "class" || value === "auto";
}

function isProviderObject(value: unknown): value is NonNullable<ToolRequest["provider"]> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    (candidate.apiKey === undefined || typeof candidate.apiKey === "string") &&
    (candidate.baseUrl === undefined || typeof candidate.baseUrl === "string") &&
    (candidate.model === undefined || typeof candidate.model === "string")
  );
}

function isRuntimeRequestBody(value: unknown): value is RuntimeRequestBody {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RuntimeRequestBody>;
  return (
    typeof candidate.rootPath === "string" &&
    typeof candidate.filePath === "string" &&
    Number.isInteger(candidate.line) &&
    (candidate.line as number) >= 1 &&
    (candidate.selectedText === undefined || typeof candidate.selectedText === "string") &&
    (candidate.query === undefined || typeof candidate.query === "string") &&
    (candidate.force === undefined || typeof candidate.force === "boolean") &&
    (candidate.depth === undefined || isLogicalSectionDepth(candidate.depth)) &&
    (candidate.enrich === undefined || typeof candidate.enrich === "boolean") &&
    (candidate.provider === undefined || isProviderObject(candidate.provider)) &&
    !path.isAbsolute(candidate.filePath) &&
    !candidate.filePath.includes("\0")
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
      candidate.action === "logical-section" ||
      candidate.action === "search-codebase" ||
      candidate.action === "get-symbol-context" ||
      candidate.action === "get-project-overview" ||
      candidate.action === "trace-call-chain" ||
      candidate.action === "ensure-index") &&
    (candidate.requestOverrides === undefined || typeof candidate.requestOverrides === "object")
  );
}

function printUsage(): void {
  console.error(
    [
      "Usage:",
      "  codegraph-runtime explain <workspace-root> <file-path> <line> [selectedText]",
      "  codegraph-runtime serve [port]",
      "",
      "Security env:",
      "  CODEGRAPH_RUNTIME_TOKEN     Bearer token required for HTTP API (auto-generated if unset)",
      "  CODEGRAPH_ALLOW_ANONYMOUS   Set to 1 to allow unauthenticated HTTP (insecure)",
      "  CODEGRAPH_ALLOWED_ROOTS     Path-delimiter list of allowed workspace roots (default: cwd)"
    ].join("\n")
  );
}

function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorized(request: http.IncomingMessage): boolean {
  if (ALLOW_ANONYMOUS && !AUTH_TOKEN) {
    return true;
  }

  if (!AUTH_TOKEN) {
    return false;
  }

  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return tokensEqual(header.slice("Bearer ".length), AUTH_TOKEN);
  }

  const alt = request.headers["x-codegraph-token"];
  if (typeof alt === "string") {
    return tokensEqual(alt, AUTH_TOKEN);
  }

  return false;
}

function assertAllowedRoot(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  const allowed = ALLOWED_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));

  if (!allowed) {
    throw new Error("rootPath is not in CODEGRAPH_ALLOWED_ROOTS");
  }

  return resolved;
}

function isSafeLocalHostHeader(host: string | undefined): boolean {
  if (!host) {
    return false;
  }
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
}

class HttpGuardError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpGuardError";
  }
}

function assertHttpRequestGuards(request: http.IncomingMessage, options?: { requireJson?: boolean }): void {
  if (!isSafeLocalHostHeader(typeof request.headers.host === "string" ? request.headers.host : undefined)) {
    throw new HttpGuardError(400, "Invalid Host header");
  }

  if (options?.requireJson) {
    if (typeof request.headers.origin === "string" && request.headers.origin.trim()) {
      throw new HttpGuardError(403, "Origin header is not allowed");
    }
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
      throw new HttpGuardError(415, "Content-Type must be application/json");
    }
  }
}

function sanitizeRemoteRequest(request: RuntimeRequestBody): RuntimeRequestBody {
  return {
    rootPath: assertAllowedRoot(request.rootPath),
    filePath: request.filePath,
    line: request.line,
    selectedText: request.selectedText,
    depth: request.depth,
    enrich: request.enrich,
    query: request.query,
    force: request.force,
    // Never honor client-supplied provider credentials/baseUrl over HTTP.
    provider: undefined,
    trustProviderConfig: false
  };
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;

    if (total > MAX_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }

    chunks.push(buffer);
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

  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (!oldest) {
      break;
    }
    sessions.delete(oldest);
  }
}

function createSession(request: RuntimeRequestBody): RuntimeSession {
  pruneExpiredSessions();
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
  // Freeze workspace root for the session lifetime.
  const merged: RuntimeRequestBody = {
    rootPath: baseRequest.rootPath,
    filePath: overrides?.filePath ?? baseRequest.filePath,
    line: overrides?.line ?? baseRequest.line,
    selectedText: overrides?.selectedText ?? baseRequest.selectedText,
    depth: overrides?.depth ?? baseRequest.depth,
    enrich: overrides?.enrich ?? baseRequest.enrich,
    query: overrides?.query ?? baseRequest.query,
    force: overrides?.force ?? baseRequest.force,
    provider: undefined,
    trustProviderConfig: false
  };

  if (!isRuntimeRequestBody(merged)) {
    throw new Error("Invalid session requestOverrides");
  }

  return sanitizeRemoteRequest(merged);
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
      assertHttpRequestGuards(request);
      writeJson(response, 200, {
        ok: true,
        tool: "health",
        data: {
          service: "codegraph-runtime",
          activeSessions: sessions.size,
          authRequired: Boolean(AUTH_TOKEN) && !ALLOW_ANONYMOUS,
          allowedRootsConfigured: ALLOWED_ROOTS.length > 0
        }
      });
      return;
    }

    assertHttpRequestGuards(request, { requireJson: request.method === "POST" });

    if (!isAuthorized(request)) {
      writeJson(response, 401, toolError("unauthorized", "Missing or invalid runtime token"));
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
            "Invalid request body. Expected { rootPath, filePath, line>=1, selectedText?, depth?, enrich? }",
            "sessions.explain-selection"
          )
        );
        return;
      }

      const sanitized = sanitizeRemoteRequest(payload);
      const session = createSession(sanitized);
      const result = await runExplainSelectionTool(sanitized);
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

      try {
        session.request = mergeRequest(session.request, payload.requestOverrides);
      } catch (error) {
        writeJson(
          response,
          400,
          toolError(
            "invalid_request",
            error instanceof Error ? error.message : "Invalid session requestOverrides",
            "sessions.followup"
          )
        );
        return;
      }

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
          "Invalid request body. Expected { rootPath, filePath, line>=1, selectedText?, depth?, enrich? }"
        )
      );
      return;
    }

    const sanitized = sanitizeRemoteRequest(payload);

    if (request.url === "/v1/tools/explain-selection") {
      writeJson(response, 200, await runExplainSelectionTool(sanitized));
      return;
    }

    if (request.url === "/v1/tools/find-definition") {
      writeJson(response, 200, await runFindDefinitionTool(sanitized));
      return;
    }

    if (request.url === "/v1/tools/find-usages") {
      writeJson(response, 200, await runFindUsagesTool(sanitized));
      return;
    }

    if (request.url === "/v1/tools/logical-section") {
      writeJson(response, 200, await runLogicalSectionTool(sanitized));
      return;
    }

    if (request.url === "/v1/tools/search-codebase") {
      writeJson(response, 200, await runSearchCodebaseTool(sanitized));
      return;
    }

    if (request.url === "/v1/tools/get-symbol-context") {
      writeJson(response, 200, await runGetSymbolContextTool(sanitized));
      return;
    }

    if (request.url === "/v1/tools/get-project-overview") {
      writeJson(response, 200, await runGetProjectOverviewTool(sanitized));
      return;
    }

    if (request.url === "/v1/tools/trace-call-chain") {
      writeJson(response, 200, await runTraceCallChainTool(sanitized));
      return;
    }

    if (request.url === "/v1/tools/ensure-index") {
      writeJson(response, 200, await runEnsureIndexTool(sanitized));
      return;
    }

    writeJson(response, 404, toolError("unknown_endpoint", "Unknown endpoint"));
  } catch (error) {
    if (error instanceof HttpGuardError) {
      writeJson(response, error.statusCode, toolError("invalid_request", error.message));
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown runtime error";
    const status =
      message.includes("CODEGRAPH_ALLOWED_ROOTS") ||
      message.includes("Path escapes") ||
      message.includes("Symlink escapes") ||
      message.includes("Request body exceeds")
        ? 400
        : 500;

    writeJson(response, status, toolError(status === 400 ? "invalid_request" : "runtime_error", message));
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
    rootPath: assertAllowedRoot(rootPath),
    filePath,
    line,
    selectedText: selectedTextParts.join(" ") || undefined,
    enrich: process.env.CODEGRAPH_ENRICH === "1" || process.env.CODEGRAPH_ENRICH === "true",
    trustProviderConfig: false
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

  const pruneTimer = setInterval(() => pruneExpiredSessions(), 60_000);
  pruneTimer.unref();

  const server = http.createServer((request, response) => {
    void handleToolRequest(request, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  console.log(`Codegraph runtime listening on http://127.0.0.1:${port}`);
  console.log(`Allowed roots: ${ALLOWED_ROOTS.join(", ")}`);
  if (ALLOW_ANONYMOUS && !AUTH_TOKEN) {
    console.log("Warning: CODEGRAPH_ALLOW_ANONYMOUS=1; local HTTP API is unauthenticated");
  } else if (GENERATED_TOKEN && AUTH_TOKEN) {
    console.log(`Runtime token (CODEGRAPH_RUNTIME_TOKEN): ${AUTH_TOKEN}`);
  } else {
    console.log("Runtime token auth enabled (CODEGRAPH_RUNTIME_TOKEN)");
  }
}

async function main(): Promise<void> {
  initRuntimeSecurity();
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
