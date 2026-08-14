import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appendItems, count } from "./inbox.mjs";

const scriptPath = fileURLToPath(new URL("./watch-inbox.mjs", import.meta.url));

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function withInbox(run) {
  const dir = await mkdtemp(join(tmpdir(), "ffb-watch-"));
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

function spawnWatcher(inbox) {
  const child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, FFB_INBOX: inbox },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const exited = once(child, "exit").then(([code]) => code);
  return { child, exited, stdout: () => stdout };
}

test("the watcher outlives an empty inbox, exits 0 on feedback, and never consumes the spool", { concurrency: false }, async () => {
  await withInbox(async (dir) => {
    const watcher = spawnWatcher(dir);
    try {
      // Assert "no exit event fired" over a window of at least 2x the poll
      // interval, rather than sampling process state.
      let exitCode = null;
      watcher.exited.then((code) => { exitCode = code; });
      await delay(1200);
      assert.equal(exitCode, null);

      await appendItems([{ sel: "div.card", comment: "tighten spacing" }]);

      assert.equal(await watcher.exited, 0);
      assert.match(watcher.stdout(), /1 pending item\(s\)/);
      assert.ok(watcher.stdout().includes(dir), "stdout names the inbox being watched");
      assert.match(watcher.stdout(), /ffb_pull/);
      // Read-only contract: the watcher signalled without consuming.
      assert.equal(await count(), 1);
    } finally {
      watcher.child.kill();
    }
  });
});

test("a watcher armed while feedback already waits exits immediately", { concurrency: false }, async () => {
  await withInbox(async (dir) => {
    await appendItems([{ sel: "span.gold", comment: "bigger font" }]);

    const watcher = spawnWatcher(dir);
    try {
      assert.equal(await watcher.exited, 0);
      assert.equal(await count(), 1);
    } finally {
      watcher.child.kill();
    }
  });
});
