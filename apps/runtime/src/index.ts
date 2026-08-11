#!/usr/bin/env node
import http from "node:http";

import { buildSelectionContext, findDefinition, findUsages, getLogicalSection } from "@codegraph/core";

interface RuntimeRequestBody {
  rootPath: string;
  filePath: string;
  line: number;
  selectedText?: string;
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
    (candidate.selectedText === undefined || typeof candidate.selectedText === "string")
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

async function handleToolRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  try {
    if (request.method === "GET" && request.url === "/health") {
      writeJson(response, 200, { ok: true, service: "codegraph-runtime" });
      return;
    }

    if (request.method !== "POST" || !request.url) {
      writeJson(response, 404, { error: "Not found" });
      return;
    }

    const payload = await readJsonBody(request);

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
