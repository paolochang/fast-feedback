import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { count, peek, readAndClear } from "../scripts/inbox.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_WAIT_TIMEOUT_MS = 100_000;
const MAX_WAIT_TIMEOUT_MS = 110_000;
const POLL_INTERVAL_MS = 500;

export const toolDefinitions = [
  {
    name: "ffb_pull",
    description: "Read and clear all pending Fast Feedback items.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ffb_wait",
    description: "Wait for pending Fast Feedback items, then read and clear them.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ffb_peek",
    description: "Read pending Fast Feedback items without clearing them.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ffb_status",
    description: "Return the number of pending Fast Feedback items.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function waitTimeoutMs() {
  const configured = Number(process.env.FFB_WAIT_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured < 0) return DEFAULT_WAIT_TIMEOUT_MS;
  return Math.min(configured, MAX_WAIT_TIMEOUT_MS);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForFeedback(inbox = { count, readAndClear }) {
  const deadline = Date.now() + waitTimeoutMs();
  while (Date.now() <= deadline) {
    if (await inbox.count()) {
      const items = await inbox.readAndClear();
      if (items.length) return items;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(POLL_INTERVAL_MS, remaining));
  }
  return null;
}

export async function callTool(name) {
  switch (name) {
    case "ffb_pull": {
      const items = await readAndClear();
      return textResult(items.length ? JSON.stringify(items) : "no pending feedback");
    }
    case "ffb_wait": {
      const items = await waitForFeedback();
      return textResult(items ? JSON.stringify(items) : "none yet");
    }
    case "ffb_peek":
      return textResult(JSON.stringify(await peek()));
    case "ffb_status":
      return textResult(String(await count()));
    default:
      return textResult("Unknown tool: " + String(name), true);
  }
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function methodNotFound(id) {
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
}

function invalidRequest(id) {
  return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
}

function internalError(id) {
  return { jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } };
}

function isValidRequest(request) {
  return request !== null
    && typeof request === "object"
    && !Array.isArray(request)
    && request.jsonrpc === "2.0"
    && typeof request.method === "string";
}

export async function handleRequest(request) {
  if (!isValidRequest(request)) return invalidRequest(request?.id ?? null);
  if (request.id === undefined || request.method.startsWith("notifications/")) return null;

  switch (request?.method) {
    case "ping":
      return response(request.id, {});
    case "initialize":
      return response(request.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "fast-feedback", version: "1.0.0" },
      });
    case "tools/list":
      return response(request.id, { tools: toolDefinitions });
    case "tools/call": {
      try {
        return response(request.id, await callTool(request.params?.name));
      } catch (error) {
        return response(request.id, textResult(error instanceof Error ? error.message : String(error), true));
      }
    }
    default:
      return methodNotFound(request?.id ?? null);
  }
}

export async function serveStdio({ input: source = process.stdin, output = process.stdout, dispatch = handleRequest } = {}) {
  const input = createInterface({ input: source, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }) + "\n");
      continue;
    }

    const hasId = request !== null && typeof request === "object" && !Array.isArray(request) && Object.hasOwn(request, "id");
    Promise.resolve().then(() => dispatch(request)).then((reply) => {
      if (reply) output.write(JSON.stringify(reply) + "\n");
    }).catch(() => {
      if (hasId) output.write(JSON.stringify(internalError(request.id)) + "\n");
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  serveStdio();
}
