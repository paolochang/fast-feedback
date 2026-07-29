import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { count, inboxPath, peek, readAndClear, readSessions } from "../scripts/inbox.mjs";
import { isLoopbackHost } from "../scripts/proxy-guards.mjs";
import { currentLatest, ensureVersionChecked, versionInfo } from "../scripts/update-check.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_WAIT_TIMEOUT_MS = 100_000;
const MAX_WAIT_TIMEOUT_MS = 110_000;
const POLL_INTERVAL_MS = 500;
const FALLBACK_SERVER_VERSION = "0.0.0";
const SERVER_VERSION = (() => {
  try {
    const v = JSON.parse(readFileSync(new URL("../../../.claude-plugin/plugin.json", import.meta.url), "utf8")).version;
    return typeof v === "string" ? v : FALLBACK_SERVER_VERSION;
  } catch {
    return FALLBACK_SERVER_VERSION;
  }
})();

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
    description: "Return the pending feedback count and inbox path being read.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

const EMPTY_RESULT_POINTER = " — call ffb_status to see whether a server is running and which inbox is being read.";

function emptyStatusHint(inbox) {
  return "No ffb server is answering at the inbox this MCP reads (`" + inbox + "`). Check: "
    + "the page may be in console/bookmarklet mode (Send cannot reach the inbox there — ask for Copy All), "
    + "or the server may have been started from a different working directory (set FFB_INBOX to the same absolute path for both).";
}

async function sessionServerStatus() {
  const sessions = await readSessions();
  if (!sessions.length) return { state: "none" };
  const mostRecent = (entries) => entries.reduce((latest, entry) => (
    entry.started_at >= latest.started_at ? entry : latest
  ));
  const statusFor = (state, session) => ({ state, mode: session.mode, url: session.url, started_at: session.started_at });
  const probes = await Promise.all(sessions.map(async (session) => {
    let sessionUrl;
    try {
      sessionUrl = new URL(session.url);
    } catch {
      return null;
    }
    if (!isLoopbackHost(sessionUrl.hostname)) return null;
    try {
      const response = await fetch(new URL("/__ffb__/ping", sessionUrl), { signal: AbortSignal.timeout(300), redirect: "manual" });
      const ping = await response.json();
      return response.ok && ping?.ffb === true && ping?.id === session.id ? session : null;
    } catch {
      return null;
    }
  }));
  const liveSessions = probes.filter(Boolean);
  if (liveSessions.length) return statusFor("running", mostRecent(liveSessions));
  return statusFor("not_responding", mostRecent(sessions));
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
      return textResult(items.length ? JSON.stringify(items) : "no pending feedback" + EMPTY_RESULT_POINTER);
    }
    case "ffb_wait": {
      const items = await waitForFeedback();
      return textResult(items ? JSON.stringify(items) : "none yet" + EMPTY_RESULT_POINTER);
    }
    case "ffb_peek": {
      const items = await peek();
      return textResult(items.length ? JSON.stringify(items) : "[]\n" + EMPTY_RESULT_POINTER);
    }
    case "ffb_status": {
      if (!process.env.FFB_NO_UPDATE_CHECK) ensureVersionChecked();
      const version = versionInfo(SERVER_VERSION, currentLatest());
      const pending = await count();
      const inbox = inboxPath();
      const server = await sessionServerStatus();
      const status = { pending, inbox, server, version };
      if (server.state !== "running") status.hint = emptyStatusHint(inbox);
      return textResult(JSON.stringify(status));
    }
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
        serverInfo: { name: "fast-feedback", version: SERVER_VERSION },
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
