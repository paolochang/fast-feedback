import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

async function startServer(id = "test-session") {
  const server = http.createServer((request, response) => {
    if (!core.handleFfbRoute(request, response, { port: server.address().port, id })) {
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
    const pending = await readFile(join(inboxDir, "pending", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json"), "utf8");
    assert.match(pending, /Stored by serve core/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousInbox === undefined) delete process.env.FFB_INBOX;
    else process.env.FFB_INBOX = previousInbox;
    await rm(inboxDir, { recursive: true, force: true });
  }
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
