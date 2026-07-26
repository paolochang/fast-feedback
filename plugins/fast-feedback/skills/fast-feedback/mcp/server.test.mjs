import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { appendItems } from "../scripts/inbox.mjs";
import { handleRequest, serveStdio, toolDefinitions, waitForFeedback } from "./server.mjs";

async function withInbox(run) {
  const inbox = await mkdtemp(join(tmpdir(), "ffb-mcp-"));
  const previous = process.env.FFB_INBOX;
  process.env.FFB_INBOX = inbox;
  try {
    return await run(inbox);
  } finally {
    if (previous === undefined) delete process.env.FFB_INBOX;
    else process.env.FFB_INBOX = previous;
    await rm(inbox, { recursive: true, force: true });
  }
}

function toolCall(name) {
  return handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
}

test("initialize and tools/list expose the four schemas", async () => {
  const initialized = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const plugin = JSON.parse(await readFile(new URL("../../../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(initialized.jsonrpc, "2.0");
  assert.equal(initialized.id, 1);
  assert.equal(initialized.result.capabilities.tools instanceof Object, true);
  assert.equal(typeof initialized.result.protocolVersion, "string");
  assert.equal(initialized.result.serverInfo.version, plugin.version);

  const listed = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.deepEqual(listed.result.tools, toolDefinitions);
  assert.deepEqual(listed.result.tools.map(({ name }) => name), ["ffb_pull", "ffb_wait", "ffb_peek", "ffb_status"]);
  for (const tool of listed.result.tools) assert.equal(tool.inputSchema.type, "object");
});

test("pull clears feedback while peek and status preserve it", { concurrency: false }, async () => {
  await withInbox(async () => {
    const items = [{ n: 1, comment: "first" }, { n: 2, comment: "second" }];
    await appendItems(items);

    assert.equal((await toolCall("ffb_status")).result.content[0].text, "2");
    assert.deepEqual(
      JSON.parse((await toolCall("ffb_peek")).result.content[0].text).map(({ id, ...item }) => item).sort((left, right) => left.n - right.n),
      items,
    );
    assert.equal((await toolCall("ffb_status")).result.content[0].text, "2");
    assert.deepEqual(
      JSON.parse((await toolCall("ffb_pull")).result.content[0].text).map(({ id, ...item }) => item).sort((left, right) => left.n - right.n),
      items,
    );
    assert.equal((await toolCall("ffb_status")).result.content[0].text, "0");
    assert.equal((await toolCall("ffb_pull")).result.content[0].text, "no pending feedback");
  });
});

test("wait returns new feedback promptly and reports a short timeout", { concurrency: false }, async () => {
  await withInbox(async () => {
    const previousTimeout = process.env.FFB_WAIT_TIMEOUT_MS;
    process.env.FFB_WAIT_TIMEOUT_MS = "25";
    try {
      assert.equal((await toolCall("ffb_wait")).result.content[0].text, "none yet");
    } finally {
      if (previousTimeout === undefined) delete process.env.FFB_WAIT_TIMEOUT_MS;
      else process.env.FFB_WAIT_TIMEOUT_MS = previousTimeout;
    }

    const started = Date.now();
    const waiting = toolCall("ffb_wait");
    setTimeout(() => appendItems([{ comment: "arrived" }]), 50);
    const result = await waiting;
    assert.ok(Date.now() - started < 1_000);
    assert.deepEqual(
      JSON.parse(result.result.content[0].text).map(({ id, ...item }) => item),
      [{ comment: "arrived" }],
    );
  });
});

test("unknown methods error and notifications do not reply", async () => {
  const unknown = await handleRequest({ jsonrpc: "2.0", id: "x", method: "does/not/exist" });
  assert.deepEqual(unknown.error, { code: -32601, message: "Method not found" });
  assert.equal(await handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(await handleRequest({ jsonrpc: "2.0", method: "does/not/exist" }), null);

  const zeroId = await handleRequest({ jsonrpc: "2.0", id: 0, method: "does/not/exist" });
  assert.equal(zeroId.id, 0);
  assert.deepEqual(zeroId.error, { code: -32601, message: "Method not found" });
});

test("invalid JSON-RPC envelopes return Invalid Request before notification suppression", async () => {
  for (const request of [{}, null, { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 1, method: 5 }]) {
    const reply = await handleRequest(request);
    assert.deepEqual(reply.error, { code: -32600, message: "Invalid Request" });
  }
  assert.equal((await handleRequest({})).id, null);
  assert.equal((await handleRequest(null)).id, null);
  assert.equal((await handleRequest({ jsonrpc: "2.0", id: 1, method: 5 })).id, 1);
  assert.equal(await handleRequest({ jsonrpc: "2.0", method: "ping" }), null);
  assert.equal(await handleRequest({ jsonrpc: "2.0", id: 2, method: "notifications/initialized" }), null);
});

test("stdio returns an internal error if dispatch rejects for a request with an id", async () => {
  const input = new PassThrough();
  let stdout = "";
  const serving = serveStdio({
    input,
    output: { write: (chunk) => { stdout += chunk; } },
    dispatch: () => { throw new Error("dispatch failed"); },
  });

  input.end(JSON.stringify({ jsonrpc: "2.0", id: "boom", method: "ping" }) + "\n");
  await serving;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(stdout), {
    jsonrpc: "2.0",
    id: "boom",
    error: { code: -32603, message: "Internal error" },
  });
});

test("ping returns an empty MCP result", async () => {
  assert.deepEqual(
    await handleRequest({ jsonrpc: "2.0", id: "ping-id", method: "ping" }),
    { jsonrpc: "2.0", id: "ping-id", result: {} },
  );
});

test("wait continues polling when another consumer empties the queue", async () => {
  const previousTimeout = process.env.FFB_WAIT_TIMEOUT_MS;
  process.env.FFB_WAIT_TIMEOUT_MS = "10";
  let checks = 0;
  try {
    assert.equal(await waitForFeedback({
      count: async () => checks++ === 0,
      readAndClear: async () => [],
    }), null);
    assert.ok(checks >= 1);
  } finally {
    if (previousTimeout === undefined) delete process.env.FFB_WAIT_TIMEOUT_MS;
    else process.env.FFB_WAIT_TIMEOUT_MS = previousTimeout;
  }
});

test("stdio server replies to requests and suppresses notifications", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} }) + "\n");
  child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(exitCode, 0);
  const replies = stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, 3);
  assert.ok(replies[0].result.serverInfo.name);
});

test("stdio dispatches ping before an earlier ffb_wait resolves", { concurrency: false }, async () => {
  const inbox = await mkdtemp(join(tmpdir(), "ffb-mcp-stdio-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    env: { ...process.env, FFB_INBOX: inbox, FFB_WAIT_TIMEOUT_MS: "300" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const replies = [];
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const lines = stdout.split("\n");
    stdout = lines.pop();
    for (const line of lines) if (line) replies.push(JSON.parse(line));
  });

  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }) + "\n");
    while (!replies.some(({ id }) => id === 0)) await new Promise((resolve) => setTimeout(resolve, 5));

    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ffb_wait" } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n");

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(replies.slice(1), [{ jsonrpc: "2.0", id: 2, result: {} }]);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("close", resolve));
    await rm(inbox, { recursive: true, force: true });
  }
});
