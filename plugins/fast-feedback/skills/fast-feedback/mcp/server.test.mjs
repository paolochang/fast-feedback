import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { appendItems } from "../scripts/inbox.mjs";
import { handleRequest, toolDefinitions } from "./server.mjs";

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
  assert.equal(initialized.jsonrpc, "2.0");
  assert.equal(initialized.id, 1);
  assert.equal(initialized.result.capabilities.tools instanceof Object, true);
  assert.equal(typeof initialized.result.protocolVersion, "string");

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
    assert.deepEqual(JSON.parse((await toolCall("ffb_peek")).result.content[0].text), items);
    assert.equal((await toolCall("ffb_status")).result.content[0].text, "2");
    assert.deepEqual(JSON.parse((await toolCall("ffb_pull")).result.content[0].text), items);
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
    assert.deepEqual(JSON.parse(result.result.content[0].text), [{ comment: "arrived" }]);
  });
});

test("unknown methods error and notifications do not reply", async () => {
  const unknown = await handleRequest({ jsonrpc: "2.0", id: "x", method: "does/not/exist" });
  assert.deepEqual(unknown.error, { code: -32601, message: "Method not found" });
  assert.equal(await handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
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
