import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("./serve-static.mjs", import.meta.url));

function request({ port, method = "GET", path = "/", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buffer, body: buffer.toString("utf8") });
      });
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

async function startStatic(file, inbox, { portBeforeFile = false } = {}) {
  const port = await unusedPort();
  const args = portBeforeFile ? ["--port", String(port), file] : [file, "--port", String(port)];
  const child = spawn(process.execPath, [scriptPath, ...args], {
    env: { ...process.env, FFB_INBOX: inbox, FFB_NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("static server did not start: " + output)), 5000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("static server exited early (" + code + "): " + output));
    });
    const ready = () => {
      // Wait for the LAST banner line (server is already listening) so the full
      // banner — including the advertised page URL — is present in output().
      if (!output.includes("overlay hot-read on")) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on("data", ready);
    child.stderr.on("data", ready);
  });
  return {
    port,
    output: () => output,
    async close() {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

async function withStatic(files, run, documentName = "mockup.html") {
  const dir = await mkdtemp(join(tmpdir(), "ffb-static-"));
  const inbox = join(dir, "inbox");
  try {
    for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
    await run({ dir, inbox, file: join(dir, documentName) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readSessionMarker(inbox) {
  const names = await readdir(join(inbox, "sessions"));
  assert.equal(names.length, 1);
  return JSON.parse(await readFile(join(inbox, "sessions", names[0]), "utf8"));
}

async function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { env: { ...process.env, FFB_NO_OPEN: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}

test("serves the selected document at / with an injected, uncached UTF-8 boot", async () => {
  await withStatic({ "mockup.html": "<!doctype html><html><head><title>café</title></head><body><main>mockup</main></body></html>" }, async ({ file, inbox }) => {
    const server = await startStatic(file, inbox);
    try {
      const response = await request({ port: server.port });
      assert.equal(response.status, 200);
      assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(Number(response.headers["content-length"]), Buffer.byteLength(response.body, "utf8"));
      assert.match(response.body, /<head>\s*<meta charset="utf-8">/i);
      assert.match(response.body, /window\.__FFB_FILE="mockup\.html"/);
      assert.match(response.body, /x-ffb-token':"[0-9a-f]+"/i);
      assert.ok(response.body.indexOf("window.__FFB_FILE") < response.body.toLowerCase().lastIndexOf("</body>"));
    } finally {
      await server.close();
    }
  });
});

test("writes a static session marker after binding the server port", async () => {
  await withStatic({ "mockup.html": "<body>page</body>" }, async ({ file, inbox }) => {
    const server = await startStatic(file, inbox);
    try {
      const marker = await readSessionMarker(inbox);
      assert.deepEqual({ ...marker, id: undefined, started_at: undefined }, {
        id: undefined,
        mode: "static",
        version: "0.3.0",
        url: "http://127.0.0.1:" + server.port,
        started_at: undefined,
      });
      assert.match(marker.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.match(marker.started_at, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await server.close();
    }
  });
});

test("returns the session marker id from the static server ping", async () => {
  await withStatic({ "mockup.html": "<body>page</body>" }, async ({ file, inbox }) => {
    const server = await startStatic(file, inbox);
    try {
      const marker = await readSessionMarker(inbox);
      const ping = await request({ port: server.port, path: "/__ffb__/ping" });
      assert.equal(ping.status, 200);
      assert.equal(JSON.parse(ping.body).id, marker.id);
    } finally {
      await server.close();
    }
  });
});

test("starts static serving when its session marker cannot be written", async () => {
  await withStatic({ "mockup.html": "<body>page</body>" }, async ({ file, inbox }) => {
    await writeFile(inbox, "not a directory", "utf8");
    const server = await startStatic(file, inbox);
    try {
      assert.match(server.output(), /fast-feedback static server running/);
    } finally {
      await server.close();
    }
  });
});

test("wraps an HTML fragment with a charset before injecting the boot", async () => {
  await withStatic({ "mockup.html": "<main>café fragment</main>" }, async ({ file, inbox }) => {
    const server = await startStatic(file, inbox);
    try {
      const response = await request({ port: server.port });
      assert.equal(response.status, 200);
      assert.match(response.body, /^<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">/i);
      assert.match(response.body, /<body>[\s\S]*window\.__FFB_FILE="mockup\.html"[\s\S]*<\/body>/i);
    } finally {
      await server.close();
    }
  });
});

test("serves static assets by extension and strips query strings", async () => {
  await withStatic({
    "mockup.html": "<body>page</body>",
    "app.mjs": "export const app = true;",
    "style.css": "body { color: red; }",
    "blob.bin": Buffer.from([1, 2, 3]),
  }, async ({ file, inbox }) => {
    const server = await startStatic(file, inbox);
    try {
      const js = await request({ port: server.port, path: "/app.mjs?cache=1" });
      assert.equal(js.status, 200);
      assert.match(js.headers["content-type"], /^application\/javascript/);
      assert.equal(js.body, "export const app = true;");
      assert.match((await request({ port: server.port, path: "/style.css" })).headers["content-type"], /^text\/css/);
      assert.equal((await request({ port: server.port, path: "/blob.bin" })).headers["content-type"], "application/octet-stream");
    } finally {
      await server.close();
    }
  });
});

test("rejects traversal and malformed URL encoding without taking down the server", async () => {
  await withStatic({ "mockup.html": "<body>page</body>" }, async ({ file, inbox }) => {
    const server = await startStatic(file, inbox);
    try {
      assert.equal((await request({ port: server.port, path: "/../secret" })).status, 403);
      assert.equal((await request({ port: server.port, path: "/broken%" })).status, 400);
      assert.equal((await request({ port: server.port, path: "/" })).status, 200);
    } finally {
      await server.close();
    }
  });
});

test("returns 404 for missing static files", async () => {
  await withStatic({ "mockup.html": "<body>page</body>" }, async ({ file, inbox }) => {
    const server = await startStatic(file, inbox);
    try {
      assert.equal((await request({ port: server.port, path: "/missing.css" })).status, 404);
    } finally {
      await server.close();
    }
  });
});

test("rejects null-byte asset paths without taking down the server", async () => {
  await withStatic({ "mockup.html": "<body>page</body>" }, async ({ file, inbox }) => {
    const server = await startStatic(file, inbox);
    try {
      assert.equal((await request({ port: server.port, path: "/x%00bar.css" })).status, 400);
      assert.equal((await request({ port: server.port, path: "/" })).status, 200);
    } finally {
      await server.close();
    }
  });
});

test("injects the boot into an extensionless selected document", async () => {
  await withStatic({ mockup: "<html><body>page</body></html>" }, async ({ file, inbox }) => {
    const server = await startStatic(file, inbox);
    try {
      const response = await request({ port: server.port });
      assert.equal(response.status, 200);
      assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
      assert.match(response.body, /window\.__FFB_FILE="mockup"/);
    } finally {
      await server.close();
    }
  }, "mockup");
});

test("POST /__ffb__/send accepts the injected token and loopback origin", async () => {
  await withStatic({ "mockup.html": "<body>page</body>" }, async ({ file, inbox }) => {
    const server = await startStatic(file, inbox);
    try {
      const page = await request({ port: server.port });
      const token = page.body.match(/x-ffb-token':"([0-9a-f]+)"/i)?.[1];
      assert.ok(token, "injected page contains a send token");
      const body = JSON.stringify([{ id: "item-1", comment: "send from static mode" }]);
      const response = await request({
        port: server.port,
        method: "POST",
        path: "/__ffb__/send",
        headers: {
          origin: "http://127.0.0.1:" + server.port,
          "x-ffb-token": token,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        body,
      });
      assert.equal(response.status, 200);
      const pendingDir = join(inbox, "pending");
      const [pendingFile] = (await readdir(pendingDir)).filter((name) => name.endsWith(".json"));
      const pending = await readFile(join(pendingDir, pendingFile), "utf8");
      assert.match(pending, /send from static mode/);
    } finally {
      await server.close();
    }
  });
});

test("rejects directory and nonexistent inputs with clear non-zero CLI errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ffb-static-input-"));
  try {
    const directory = await runCli([dir]);
    assert.notEqual(directory.code, 0);
    assert.match(directory.output, /input must be a file/i);

    const missing = await runCli([join(dir, "missing.html")]);
    assert.notEqual(missing.code, 0);
    assert.match(missing.output, /input file does not exist/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects missing and non-numeric --port values with clear CLI errors", async () => {
  const missing = await runCli(["--port"]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.output, /port must be an integer between 1 and 65535/i);

  const nonNumeric = await runCli(["--port", "not-a-port"]);
  assert.notEqual(nonNumeric.code, 0);
  assert.match(nonNumeric.output, /port must be an integer between 1 and 65535/i);
});

test("accepts --port before the selected document", async () => {
  await withStatic({ "mockup.html": "<body>page</body>" }, async ({ file, inbox }) => {
    const server = await startStatic(file, inbox, { portBeforeFile: true });
    try {
      assert.equal((await request({ port: server.port })).status, 200);
    } finally {
      await server.close();
    }
  });
});

test("labels an injected linked page with its own filename", async () => {
  await withStatic({ "mockup.html": "<body>home</body>", "page2.html": "<body>page two</body>" }, async ({ file, inbox }) => {
    const server = await startStatic(file, inbox);
    try {
      const response = await request({ port: server.port, path: "/page2.html" });
      assert.equal(response.status, 200);
      assert.match(response.body, /window\.__FFB_FILE="page2\.html"/);
    } finally {
      await server.close();
    }
  });
});

test("advertises the document's filename URL so Send carries the filename", async () => {
  await withStatic({ "mockup.html": "<body>page</body>" }, async ({ file, inbox }) => {
    const server = await startStatic(file, inbox);
    try {
      assert.match(server.output(), /http:\/\/127\.0\.0\.1:\d+\/mockup\.html/);
      const res = await request({ port: server.port, path: "/mockup.html" });
      assert.equal(res.status, 200);
      assert.match(res.body, /window\.__FFB_FILE="mockup\.html"/);
    } finally {
      await server.close();
    }
  });
});
