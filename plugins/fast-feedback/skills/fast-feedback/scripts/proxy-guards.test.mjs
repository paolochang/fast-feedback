import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isLoopbackHost, isOwnProxyOrigin } from "./proxy-guards.mjs";

test("isLoopbackHost accepts local hosts and rejects remote hosts", () => {
  for (const hostname of ["localhost", "app.localhost", "127.0.0.1", "127.12.34.56", "::1", "[::1]"]) {
    assert.equal(isLoopbackHost(hostname), true, hostname);
  }
  assert.equal(isLoopbackHost("example.com"), false);
});

test("isOwnProxyOrigin normalizes default ports and rejects foreign hosts", () => {
  assert.equal(isOwnProxyOrigin({ host: "localhost", origin: "http://localhost" }, 80), true);
  assert.equal(isOwnProxyOrigin({ host: "localhost:5050", origin: "http://localhost:5050" }, 5050), true);
  assert.equal(isOwnProxyOrigin({ host: "example.com:5050", origin: "http://example.com:5050" }, 5050), false);
});

test("serve-proxy rejects a remote target unless explicitly allowed", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./serve-proxy.mjs", import.meta.url)), "--target", "http://example.com"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(exitCode, 1);
  assert.match(stderr, /allow-remote/);
});
