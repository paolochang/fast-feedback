import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const core = await import("./serve-core.mjs");
const overlayPath = new URL("../assets/overlay.js", import.meta.url);

function request({ port, method = "POST", path = "/__ffb__/send", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function startServer(id = "test-session", dependencies = {}) {
  const server = http.createServer((request, response) => {
    if (!core.handleFfbRoute(request, response, { port: server.address().port, id, ...dependencies })) {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function authorizedHeaders(port, contentType = "application/json") {
  return {
    host: "localhost:" + port,
    origin: "http://localhost:" + port,
    "x-ffb-token": core.FFB_SEND_TOKEN,
    "content-type": contentType,
  };
}

function bootHelpers(fetch) {
  const boot = core.renderBoot({ fileLabel: "localhost:3000" });
  const match = boot.match(/^\n<script>([\s\S]*?)<\/script>/);
  assert.ok(match);
  const sandbox = { window: {}, fetch };
  vm.runInNewContext(match[1], sandbox);
  return sandbox.window;
}

test("renderBoot helpers reject failed settings and screenshot writes", async () => {
  const helpers = bootHelpers(async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: "forbidden" }),
  }));

  await assert.rejects(() => helpers.__FFB_SAVE({ theme: "dark" }), /Settings failed: 403/);
  await assert.rejects(() => helpers.__FFB_SAVE_SHOT(new Uint8Array()), /Screenshot failed: 403/);
});

test("handleFfbRoute rejects /send without the token", async () => {
  const server = await startServer();
  try {
    const response = await request({
      port: server.address().port,
      headers: { host: "localhost:" + server.address().port, origin: "http://localhost:" + server.address().port, "content-type": "application/json" },
      body: "[]",
    });
    assert.equal(response.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("handleFfbRoute rejects settings and screenshot writes with the wrong token", async () => {
  const server = await startServer();
  try {
    for (const path of ["/__ffb__/settings", "/__ffb__/screenshot"]) {
      const response = await request({
        port: server.address().port,
        path,
        headers: { "x-ffb-token": "stale-token" },
        body: "stale",
      });
      assert.equal(response.status, 403);
      assert.deepEqual(JSON.parse(response.body), { error: "forbidden" });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("handleFfbRoute serves an unauthenticated ping with only its opaque identity", async () => {
  const server = await startServer();
  try {
    const ping = await request({ port: server.address().port, method: "GET", path: "/__ffb__/ping" });
    assert.equal(ping.status, 200);
    assert.deepEqual(JSON.parse(ping.body), { ffb: true, mode: "static", id: "test-session" });
    const send = await request({ port: server.address().port, body: "[]", headers: { "content-type": "application/json" } });
    assert.equal(send.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("handleFfbRoute rejects /send with the wrong content type", async () => {
  const server = await startServer();
  try {
    const response = await request({
      port: server.address().port,
      headers: authorizedHeaders(server.address().port, "text/plain"),
      body: "[]",
    });
    assert.equal(response.status, 415);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("handleFfbRoute rejects /send bodies over its cap", async () => {
  const server = await startServer();
  try {
    const response = await request({
      port: server.address().port,
      headers: authorizedHeaders(server.address().port),
      body: Buffer.alloc(256 * 1024 + 1),
    });
    assert.equal(response.status, 413);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("handleFfbRoute sends valid feedback to the inbox", async () => {
  const inboxDir = await mkdtemp(join(tmpdir(), "ffb-serve-core-"));
  const previousInbox = process.env.FFB_INBOX;
  process.env.FFB_INBOX = inboxDir;
  const server = await startServer();
  try {
    const response = await request({
      port: server.address().port,
      headers: authorizedHeaders(server.address().port),
      body: JSON.stringify([{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", comment: "Stored by serve core" }]),
    });
    assert.equal(response.status, 200);
    const result = JSON.parse(response.body);
    assert.equal(result.progress, true);
    assert.equal(result.items.length, 1);
    assert.match(result.items[0].progress_id, /^[0-9a-f-]{36}$/i);
    const pending = await readFile(join(inboxDir, "pending", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json"), "utf8");
    assert.match(pending, /Stored by serve core/);
    assert.match(pending, new RegExp(result.items[0].progress_id));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousInbox === undefined) delete process.env.FFB_INBOX;
    else process.env.FFB_INBOX = previousInbox;
    await rm(inboxDir, { recursive: true, force: true });
  }
});

test("handleFfbRoute creates queued progress before publishing pending items", async () => {
  const calls = [];
  let queuedEntries;
  let appendedItems;
  const server = await startServer("test-session", {
    progressApi: { createQueued: async (entries) => { calls.push("queued"); queuedEntries = entries; } },
    inboxApi: {
      appendItems: async (items) => { calls.push("append"); appendedItems = items; },
      count: async () => 1,
    },
  });
  try {
    const response = await request({ port: server.address().port, path: "/__ffb__/send?overlay=1", headers: authorizedHeaders(server.address().port), body: JSON.stringify([{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }]) });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ["queued", "append"]);
    assert.equal(queuedEntries[0].progress_id, appendedItems[0].progress_id);
    assert.equal(queuedEntries[0].item_id, appendedItems[0].id);
    assert.ok(Date.parse(queuedEntries[0].sent_at));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("handleFfbRoute delivers feedback when queued progress cannot be written", async () => {
  let appended = false;
  const server = await startServer("test-session", {
    progressApi: { createQueued: async () => { throw new Error("locked"); } },
    inboxApi: { appendItems: async () => { appended = true; }, count: async () => 1 },
  });
  try {
    const response = await request({ port: server.address().port, headers: authorizedHeaders(server.address().port), body: JSON.stringify([{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }]) });
    assert.equal(response.status, 200);
    assert.equal(appended, true);
    assert.equal(JSON.parse(response.body).progress, false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("handleFfbRoute reads projected progress and validates bounded ids", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const server = await startServer("test-session", { progressApi: { readStatuses: async () => [{ progress_id: id, item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "processing", sent_at: "2026-01-01T00:00:00.000Z", claimed_at: "2026-01-01T00:01:00.000Z", settled_at: null }] } });
  try {
    const good = await request({ port: server.address().port, method: "GET", path: "/__ffb__/progress?ids=" + id, headers: { "x-ffb-token": core.FFB_SEND_TOKEN } });
    assert.equal(good.status, 200);
    assert.deepEqual(JSON.parse(good.body), { items: [{ progress_id: id, item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "processing", since: "2026-01-01T00:01:00.000Z" }] });
    const bad = await request({ port: server.address().port, method: "GET", path: "/__ffb__/progress?ids=nope", headers: { "x-ffb-token": core.FFB_SEND_TOKEN } });
    assert.equal(bad.status, 400);
    const tooMany = Array.from({ length: 101 }, () => id).join(",");
    const capped = await request({ port: server.address().port, method: "GET", path: "/__ffb__/progress?ids=" + tooMany, headers: { "x-ffb-token": core.FFB_SEND_TOKEN } });
    assert.equal(capped.status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("handleFfbRoute withdraws queued spool items and deletes all requested records", async () => {
  const queued = "11111111-1111-4111-8111-111111111111";
  const processing = "22222222-2222-4222-8222-222222222222";
  let removedItemIds;
  let deletedIds;
  const server = await startServer("test-session", {
    progressApi: {
      readStatuses: async () => [
        { progress_id: queued, item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "queued" },
        { progress_id: processing, item_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "processing" },
      ],
      withdraw: async (ids) => { deletedIds = ids; },
    },
    inboxApi: { removePending: async (ids) => { removedItemIds = ids; return ids; } },
  });
  try {
    const response = await request({ port: server.address().port, path: "/__ffb__/withdraw?overlay=1", headers: authorizedHeaders(server.address().port), body: JSON.stringify({ ids: [queued, processing] }) });
    assert.equal(response.status, 200);
    assert.deepEqual(removedItemIds, ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
    assert.deepEqual(deletedIds, [queued, processing]);
    assert.deepEqual(JSON.parse(response.body), { withdrawn: [queued], already_delivered: [processing] });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("renderBoot injects authenticated progress and withdraw helpers", async () => {
  const calls = [];
  const helpers = bootHelpers(async (url, options = {}) => { calls.push({ url, options }); return { ok: true, json: async () => ({ items: [] }) }; });
  await helpers.__FFB_PROGRESS(["id"]);
  await helpers.__FFB_WITHDRAW(["id"]);
  assert.equal(calls[0].url, "/__ffb__/progress?ids=id");
  assert.equal(calls[0].options.headers["x-ffb-token"], core.FFB_SEND_TOKEN);
  assert.equal(calls[1].url, "/__ffb__/withdraw");
  assert.equal(calls[1].options.headers["x-ffb-token"], core.FFB_SEND_TOKEN);
});

test("injectBoot inserts before the last closing body tag and appends without one", () => {
  assert.equal(core.injectBoot("<body></body><body></body>", "<script>boot</script>"), "<body></body><body><script>boot</script></body>");
  assert.equal(core.injectBoot("<main>page</main>", "<script>boot</script>"), "<main>page</main><script>boot</script>");
});

test("renderBoot hot-reads overlay.js for every response", async () => {
  const original = await readFile(overlayPath, "utf8");
  try {
    await writeFile(overlayPath, original + "\n/* serve-core-hot-read-one */\n");
    const first = core.renderBoot({ fileLabel: "localhost:3000" });
    await writeFile(overlayPath, original + "\n/* serve-core-hot-read-two */\n");
    const second = core.renderBoot({ fileLabel: "localhost:3000" });
    assert.match(first, /serve-core-hot-read-one/);
    assert.match(second, /serve-core-hot-read-two/);
    assert.doesNotMatch(second, /serve-core-hot-read-one/);
  } finally {
    await writeFile(overlayPath, original);
  }
});
