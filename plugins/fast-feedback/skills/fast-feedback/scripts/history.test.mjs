import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listBatches, writeBatch } from "./history.mjs";

const MAX_HISTORY_BODY_BYTES = 12 * 1024 * 1024;
const scriptPath = fileURLToPath(new URL("./serve-proxy.mjs", import.meta.url));

function meta(id, ts = "2026-07-25T12:00:00.000Z") {
  return {
    id,
    ts,
    url: "http://localhost:3000/example",
    capture: { w: 800, h: 600 },
    items: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", n: 1, sel: "main", region: { x: 0, y: 0, w: 100, h: 100 }, comment: "Looks good" }],
  };
}

function framed(metaValue, png = Buffer.from([0x89, 0x50, 0x4e, 0x47])) {
  const json = Buffer.from(JSON.stringify(metaValue), "utf8");
  return Buffer.concat([Buffer.from(String(json.length) + "\n", "ascii"), json, png]);
}

async function withHistory(run) {
  const dir = await mkdtemp(join(tmpdir(), "ffb-history-"));
  const previous = process.env.FFB_INBOX;
  process.env.FFB_INBOX = dir;
  try {
    await run(dir);
  } finally {
    if (previous === undefined) delete process.env.FFB_INBOX;
    else process.env.FFB_INBOX = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function request({ port, method = "POST", path = "/__ffb__/history", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startProxy(historyDir) {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body>upstream</body></html>");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const port = await unusedPort();
  const proxy = spawn(process.execPath, [scriptPath, "--target", "http://127.0.0.1:" + upstreamPort, "--port", String(port)], {
    env: { ...process.env, FFB_INBOX: historyDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proxy.stdout.on("data", (chunk) => { output += chunk; });
  proxy.stderr.on("data", (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("proxy did not start: " + output)), 5000);
    proxy.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("proxy exited early (" + code + "): " + output));
    });
    const ready = () => {
      if (!output.includes("fast-feedback proxy running")) return;
      clearTimeout(timer);
      proxy.removeListener("exit", reject);
      resolve();
    };
    proxy.stdout.on("data", ready);
    proxy.stderr.on("data", ready);
  });
  const page = await request({ port, method: "GET", path: "/" });
  const token = page.body.match(/x-ffb-token':"([0-9a-f]+)"/i)?.[1];
  assert.ok(token, "proxy page contains the send token");
  return {
    port,
    token,
    async close() {
      proxy.kill();
      await new Promise((resolve) => proxy.once("exit", resolve));
      await new Promise((resolve) => upstream.close(resolve));
    },
  };
}

function authorizedHeaders(port, token, contentType = "application/x-ffb-history") {
  return {
    host: "localhost:" + port,
    origin: "http://localhost:" + port,
    "x-ffb-token": token,
    "content-type": contentType,
  };
}

test("writeBatch stores PNG, metadata, and its completion marker, then listBatches returns newest first", async () => {
  await withHistory(async (dir) => {
    const first = meta("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "2026-07-25T10:00:00.000Z");
    const second = meta("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "2026-07-25T11:00:00.000Z");
    const png = Buffer.from([1, 2, 3]);

    await writeBatch(first, png);
    await writeBatch(second, png);

    assert.deepEqual(await readFile(join(dir, "history", first.id + ".png")), png);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "history", first.id + ".json"), "utf8")), first);
    assert.deepEqual((await listBatches()).map(({ id }) => id), [second.id, first.id]);
  });
});

test("listBatches hides a complete-looking batch until its done marker exists", async () => {
  await withHistory(async (dir) => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const historyDir = join(dir, "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(join(historyDir, id + ".png"), Buffer.from([1]));
    await writeFile(join(historyDir, id + ".json"), JSON.stringify(meta(id)));

    assert.deepEqual(await listBatches(), []);
  });
});

test("writeBatch rejects non-UUID ids before they can form history filenames", async () => {
  await withHistory(async () => {
    await assert.rejects(writeBatch(meta("../escape"), Buffer.from([1])), /UUID/i);
    await assert.rejects(writeBatch(meta("a/b"), Buffer.from([1])), /UUID/i);
  });
});

test("POST /__ffb__/history stores a framed batch and rejects invalid requests", async () => {
  await withHistory(async (dir) => {
    const proxy = await startProxy(dir);
    try {
      const batch = meta("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      const body = framed(batch);
      const headers = authorizedHeaders(proxy.port, proxy.token);

      assert.equal((await request({ port: proxy.port, headers: { "content-type": "application/x-ffb-history" }, body })).status, 403);
      assert.equal((await request({ port: proxy.port, headers: authorizedHeaders(proxy.port, proxy.token, "application/json"), body })).status, 415);
      assert.equal((await request({ port: proxy.port, headers, body: Buffer.from("not-a-frame") })).status, 400);
      assert.equal((await request({ port: proxy.port, headers, body: framed(meta("../escape")) })).status, 400);
      assert.equal((await request({ port: proxy.port, headers, body })).status, 200);
      assert.deepEqual(await readFile(join(dir, "history", batch.id + ".png")), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      await readFile(join(dir, "history", batch.id + ".done"));
    } finally {
      await proxy.close();
    }
  });
});

test("POST /__ffb__/history rejects bodies over the cap from both length checks", async () => {
  await withHistory(async (dir) => {
    const proxy = await startProxy(dir);
    try {
      const headers = authorizedHeaders(proxy.port, proxy.token);
      const oversizedBody = Buffer.alloc(MAX_HISTORY_BODY_BYTES + 1);
      assert.equal((await request({
        port: proxy.port,
        headers,
        body: oversizedBody,
      })).status, 413);
      assert.equal((await request({
        port: proxy.port,
        headers: { ...headers, "transfer-encoding": "chunked" },
        body: oversizedBody,
      })).status, 413);
    } finally {
      await proxy.close();
    }
  });
});
