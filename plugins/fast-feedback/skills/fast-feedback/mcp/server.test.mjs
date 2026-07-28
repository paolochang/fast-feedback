import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { appendItems, writeSession } from "../scripts/inbox.mjs";
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

function runStatusProcess(source, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      env: {
        ...process.env,
        FFB_INBOX: join(tmpdir(), "ffb-mcp-child-" + process.pid + "-" + Date.now() + "-" + Math.random()),
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const updateCheckUrl = new URL("../scripts/update-check.mjs", import.meta.url).href;
const serverUrl = new URL("./server.mjs", import.meta.url).href;

test("initialize and tools/list expose the four schemas", async () => {
  const initialized = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const plugin = JSON.parse(await readFile(new URL("../../../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(initialized.jsonrpc, "2.0");
  assert.equal(initialized.id, 1);
  assert.equal(initialized.result.capabilities.tools instanceof Object, true);
  assert.equal(typeof initialized.result.protocolVersion, "string");
  assert.equal(initialized.result.serverInfo.version, plugin.version);
  // Non-tautological: de-tautologizes the line above (both sides undefined would
  // otherwise pass) and guards the F2 fallback (never undefined/number). MCP
  // serverInfo.version is a free-form string, so assert the type — not strict
  // semver, which a valid informational value like "0.3.0-rc1" would false-fail.
  assert.equal(typeof initialized.result.serverInfo.version, "string");

  const listed = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.deepEqual(listed.result.tools, toolDefinitions);
  assert.deepEqual(listed.result.tools.map(({ name }) => name), ["ffb_pull", "ffb_wait", "ffb_peek", "ffb_status"]);
  for (const tool of listed.result.tools) assert.equal(tool.inputSchema.type, "object");
  assert.match(listed.result.tools.find(({ name }) => name === "ffb_status").description, /inbox/);
});

test("ffb_status includes the current version before its lazy update check completes", { concurrency: false }, async () => {
  await withInbox(async () => {
    const status = JSON.parse((await toolCall("ffb_status")).result.content[0].text);
    const plugin = JSON.parse(await readFile(new URL("../../../.claude-plugin/plugin.json", import.meta.url), "utf8"));
    assert.deepEqual(status.version, { current: plugin.version, latest: null, outdated: false });
  });
});

test("ffb_status reports the cached latest version", { concurrency: false }, async () => {
  const plugin = JSON.parse(await readFile(new URL("../../../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  const child = await runStatusProcess(`
    import { ensureVersionChecked } from ${JSON.stringify(updateCheckUrl)};
    await ensureVersionChecked({ fetchImpl: async () => '{"plugins":[{"name":"fast-feedback","version":"0.3.1"}]}' });
    const { callTool } = await import(${JSON.stringify(serverUrl)});
    process.stdout.write(JSON.stringify(await callTool("ffb_status")));
  `);
  assert.equal(child.code, 0, child.stderr);
  assert.deepEqual(JSON.parse(JSON.parse(child.stdout).content[0].text).version, {
    current: plugin.version,
    latest: "0.3.1",
    outdated: true,
  });
});

test("ffb_status returns a valid version payload after a rejected update check", { concurrency: false }, async () => {
  const plugin = JSON.parse(await readFile(new URL("../../../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  const child = await runStatusProcess(`
    import { ensureVersionChecked } from ${JSON.stringify(updateCheckUrl)};
    await ensureVersionChecked({ fetchImpl: async () => { throw new Error("offline"); } });
    const { callTool } = await import(${JSON.stringify(serverUrl)});
    process.stdout.write(JSON.stringify(await callTool("ffb_status")));
  `);
  assert.equal(child.code, 0, child.stderr);
  const reply = JSON.parse(child.stdout);
  assert.equal(reply.isError, false);
  assert.deepEqual(JSON.parse(reply.content[0].text).version, {
    current: plugin.version,
    latest: null,
    outdated: false,
  });
});

test("ffb_status does not wait for an in-flight update check", { concurrency: false }, async () => {
  const plugin = JSON.parse(await readFile(new URL("../../../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  const child = await runStatusProcess(`
    import { ensureVersionChecked } from ${JSON.stringify(updateCheckUrl)};
    ensureVersionChecked({ fetchImpl: () => new Promise(() => {}) });
    const { callTool } = await import(${JSON.stringify(serverUrl)});
    process.stdout.write(JSON.stringify(await callTool("ffb_status")));
  `);
  assert.equal(child.code, 0, child.stderr);
  const reply = JSON.parse(child.stdout);
  assert.equal(reply.isError, false);
  assert.deepEqual(JSON.parse(reply.content[0].text).version, {
    current: plugin.version,
    latest: null,
    outdated: false,
  });
});

test("ffb_status skips the update check when FFB_NO_UPDATE_CHECK is set", { concurrency: false }, async () => {
  const child = await runStatusProcess(`
    import { ensureVersionChecked } from ${JSON.stringify(updateCheckUrl)};
    const { callTool } = await import(${JSON.stringify(serverUrl)});
    const reply = await callTool("ffb_status");
    let fetches = 0;
    await ensureVersionChecked({ fetchImpl: async () => { fetches += 1; return '{"plugins":[]}'; } });
    process.stdout.write(JSON.stringify({ reply, fetches }));
  `, { FFB_NO_UPDATE_CHECK: "1" });
  assert.equal(child.code, 0, child.stderr);
  const { reply, fetches } = JSON.parse(child.stdout);
  assert.equal(reply.isError, false);
  assert.ok(JSON.parse(reply.content[0].text).version);
  assert.equal(fetches, 1);
});

// Guards the "fire, don't await" contract. ensureVersionChecked memoises, so the
// server's own call returns this same never-settling promise. If ffb_status ever
// grows an `await` in front of it, the child's top-level await never settles and
// node exits 13 (ERR_UNSETTLED_TOP_LEVEL_AWAIT) having written nothing — so a
// regression fails loudly here instead of silently adding up to 3s to every call.
test("ffb_status returns without waiting for the update check to settle", { concurrency: false, timeout: 20000 }, async () => {
  const child = await runStatusProcess(`
    import { ensureVersionChecked } from ${JSON.stringify(updateCheckUrl)};
    ensureVersionChecked({ fetchImpl: () => new Promise(() => {}) });
    const { callTool } = await import(${JSON.stringify(serverUrl)});
    process.stdout.write(JSON.stringify(await callTool("ffb_status")));
  `);
  assert.equal(child.code, 0, "ffb_status did not return while the update check was pending: " + child.stderr);
  const status = JSON.parse(JSON.parse(child.stdout).content[0].text);
  assert.equal(status.version.latest, null);
  assert.equal(status.version.outdated, false);
});

test("pull clears feedback while peek and status preserve it", { concurrency: false }, async () => {
  await withInbox(async (inbox) => {
    const items = [{ n: 1, comment: "first" }, { n: 2, comment: "second" }];
    await appendItems(items);

    const firstStatus = JSON.parse((await toolCall("ffb_status")).result.content[0].text);
    assert.equal(firstStatus.pending, 2);
    assert.equal(firstStatus.inbox, inbox);
    assert.deepEqual(firstStatus.server, { state: "none" });
    assert.ok(firstStatus.hint);
    assert.doesNotMatch(firstStatus.hint, /No pending feedback/);
    assert.deepEqual(
      JSON.parse((await toolCall("ffb_peek")).result.content[0].text).map(({ id, ...item }) => item).sort((left, right) => left.n - right.n),
      items,
    );
    const secondStatus = JSON.parse((await toolCall("ffb_status")).result.content[0].text);
    assert.equal(secondStatus.pending, 2);
    assert.equal(secondStatus.inbox, inbox);
    assert.deepEqual(secondStatus.server, { state: "none" });
    assert.ok(secondStatus.hint);
    assert.doesNotMatch(secondStatus.hint, /No pending feedback/);
    assert.deepEqual(
      JSON.parse((await toolCall("ffb_pull")).result.content[0].text).map(({ id, ...item }) => item).sort((left, right) => left.n - right.n),
      items,
    );
    const emptyStatus = JSON.parse((await toolCall("ffb_status")).result.content[0].text);
    assert.deepEqual(Object.keys(emptyStatus), ["pending", "inbox", "server", "version", "hint"]);
    assert.equal(emptyStatus.pending, 0);
    assert.equal(emptyStatus.inbox, inbox);
    assert.match(emptyStatus.hint, /No ffb server is answering at the inbox this MCP reads/);
    assert.match(emptyStatus.hint, new RegExp(inbox.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const emptyPull = (await toolCall("ffb_pull")).result.content[0].text;
    assert.match(emptyPull, /^no pending feedback — call ffb_status to see whether a server is running and which inbox is being read\.$/);

    const emptyPeek = (await toolCall("ffb_peek")).result.content[0].text;
    const [emptyPeekJson, emptyPeekPointer] = emptyPeek.split("\n");
    assert.deepEqual(JSON.parse(emptyPeekJson), []);
    assert.equal(emptyPeekPointer, " — call ffb_status to see whether a server is running and which inbox is being read.");
  });
});

test("ffb_status does not probe non-loopback session markers", { concurrency: false }, async () => {
  await withInbox(async () => {
    const previousNoUpdateCheck = process.env.FFB_NO_UPDATE_CHECK;
    const previousFetch = globalThis.fetch;
    let fetches = 0;
    process.env.FFB_NO_UPDATE_CHECK = "1";
    globalThis.fetch = async () => {
      fetches++;
      return { ok: true, json: async () => ({ ffb: true }) };
    };
    try {
      const started_at = "2026-07-28T12:00:00.000Z";
      const url = "http://example.invalid:4321";
      await writeSession({ mode: "static", version: "0.3.0", url, started_at });

      const status = JSON.parse((await toolCall("ffb_status")).result.content[0].text);
      assert.deepEqual(status.server, { state: "not_responding", mode: "static", url, started_at });
      assert.equal(fetches, 0);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousNoUpdateCheck === undefined) delete process.env.FFB_NO_UPDATE_CHECK;
      else process.env.FFB_NO_UPDATE_CHECK = previousNoUpdateCheck;
    }
  });
});

test("ffb_status degrades malformed session marker URLs without probing", { concurrency: false }, async () => {
  await withInbox(async () => {
    const previousNoUpdateCheck = process.env.FFB_NO_UPDATE_CHECK;
    const previousFetch = globalThis.fetch;
    let fetches = 0;
    process.env.FFB_NO_UPDATE_CHECK = "1";
    globalThis.fetch = async () => {
      fetches++;
      return { ok: true, json: async () => ({ ffb: true }) };
    };
    try {
      const started_at = "2026-07-28T12:00:00.000Z";
      const url = "not-a-valid-url";
      await writeSession({ mode: "static", version: "0.3.0", url, started_at });

      const result = await toolCall("ffb_status");
      assert.equal(result.result.isError, false);
      const status = JSON.parse(result.result.content[0].text);
      assert.deepEqual(status.server, { state: "not_responding", mode: "static", url, started_at });
      assert.equal(fetches, 0);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousNoUpdateCheck === undefined) delete process.env.FFB_NO_UPDATE_CHECK;
      else process.env.FFB_NO_UPDATE_CHECK = previousNoUpdateCheck;
    }
  });
});

test("ffb_status probes loopback session markers", { concurrency: false }, async () => {
  await withInbox(async () => {
    const previousNoUpdateCheck = process.env.FFB_NO_UPDATE_CHECK;
    const previousFetch = globalThis.fetch;
    const requested = [];
    process.env.FFB_NO_UPDATE_CHECK = "1";
    globalThis.fetch = async (url) => {
      requested.push(String(url));
      return { ok: true, json: async () => ({ ffb: true }) };
    };
    try {
      for (const url of ["http://127.0.0.1:4321", "http://localhost:4321", "http://[::1]:4321"]) {
        await writeSession({ mode: "static", version: "0.3.0", url, started_at: "2026-07-28T12:00:00.000Z" });
        const status = JSON.parse((await toolCall("ffb_status")).result.content[0].text);
        assert.equal(status.server.state, "running");
      }
      assert.deepEqual(requested, [
        "http://127.0.0.1:4321/__ffb__/ping",
        "http://localhost:4321/__ffb__/ping",
        "http://[::1]:4321/__ffb__/ping",
      ]);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousNoUpdateCheck === undefined) delete process.env.FFB_NO_UPDATE_CHECK;
      else process.env.FFB_NO_UPDATE_CHECK = previousNoUpdateCheck;
    }
  });
});

test("ffb_status reports marker liveness and only hints when not running", { concurrency: false }, async () => {
  await withInbox(async () => {
    const none = JSON.parse((await toolCall("ffb_status")).result.content[0].text);
    assert.deepEqual(none.server, { state: "none" });
    assert.ok(none.hint);

    const server = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ffb: true, mode: "static" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = "http://127.0.0.1:" + server.address().port;
    try {
      await writeSession({ mode: "static", version: "0.3.0", url, started_at: "2026-07-28T12:00:00.000Z" });
      const running = JSON.parse((await toolCall("ffb_status")).result.content[0].text);
      assert.deepEqual(running.server, { state: "running", mode: "static", url, started_at: "2026-07-28T12:00:00.000Z" });
      assert.equal(running.hint, undefined);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    const foreign = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ffb: false }));
    });
    await new Promise((resolve) => foreign.listen(0, "127.0.0.1", resolve));
    const foreignUrl = "http://127.0.0.1:" + foreign.address().port;
    try {
      await writeSession({ mode: "static", version: "0.3.0", url: foreignUrl, started_at: "2026-07-28T12:00:00.000Z" });
      const foreignStatus = JSON.parse((await toolCall("ffb_status")).result.content[0].text);
      assert.deepEqual(foreignStatus.server, { state: "not_responding", mode: "static", url: foreignUrl, started_at: "2026-07-28T12:00:00.000Z" });
      assert.ok(foreignStatus.hint);
    } finally {
      await new Promise((resolve) => foreign.close(resolve));
    }

    const started = Date.now();
    const stopped = JSON.parse((await toolCall("ffb_status")).result.content[0].text);
    assert.ok(Date.now() - started < 1000);
    assert.deepEqual(stopped.server, { state: "not_responding", mode: "static", url: foreignUrl, started_at: "2026-07-28T12:00:00.000Z" });
    assert.ok(stopped.hint);
  });
});

test("wait returns new feedback promptly and reports a short timeout", { concurrency: false }, async () => {
  await withInbox(async () => {
    const previousTimeout = process.env.FFB_WAIT_TIMEOUT_MS;
    process.env.FFB_WAIT_TIMEOUT_MS = "25";
    try {
      assert.match(
        (await toolCall("ffb_wait")).result.content[0].text,
        /^none yet — call ffb_status to see whether a server is running and which inbox is being read\.$/,
      );
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
