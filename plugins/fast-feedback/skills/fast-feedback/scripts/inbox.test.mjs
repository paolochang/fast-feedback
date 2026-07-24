import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendItems, count, peek, readAndClear } from "./inbox.mjs";

async function withInbox(run) {
  const dir = await mkdtemp(join(tmpdir(), "ffb-inbox-"));
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

test("appendItems atomically spools every item and regenerates both mirrors", async () => {
  await withInbox(async (dir) => {
    const items = [
      { selector: "#save", comment: "Make this clearer" },
      { selector: ".cancel", comment: "Too prominent" },
    ];

    await appendItems(items);

    const pending = await readdir(join(dir, "pending"));
    assert.equal(pending.length, 2);
    assert.ok(pending.every((name) => /^[0-9a-f-]{36}\.json$/.test(name)));

    const spooled = await Promise.all(
      pending.map(async (name) => JSON.parse(await readFile(join(dir, "pending", name), "utf8"))),
    );
    assert.deepEqual(spooled.sort((a, b) => a.selector.localeCompare(b.selector)), items.sort((a, b) => a.selector.localeCompare(b.selector)));

    const jsonl = await readFile(join(dir, "inbox.jsonl"), "utf8");
    assert.deepEqual(jsonl.trim().split("\n").map((line) => JSON.parse(line)).sort((a, b) => a.selector.localeCompare(b.selector)), items.sort((a, b) => a.selector.localeCompare(b.selector)));

    const markdown = await readFile(join(dir, "inbox.md"), "utf8");
    assert.match(markdown, /^# Fast feedback inbox/m);
    assert.match(markdown, /#save/);
    assert.match(markdown, /Make this clearer/);
    assert.match(markdown, /\.cancel/);
  });
});

test("peek and count retain pending items until readAndClear consumes them", async () => {
  await withInbox(async (dir) => {
    const items = [{ selector: "main", comment: "Looks good" }];
    await appendItems(items);

    assert.equal(await count(), 1);
    assert.deepEqual(await peek(), items);
    assert.equal(await count(), 1);

    assert.deepEqual(await readAndClear(), items);
    assert.equal(await count(), 0);
    assert.deepEqual(await peek(), []);
    assert.deepEqual(await readAndClear(), []);
    assert.equal(await readFile(join(dir, "inbox.jsonl"), "utf8"), "");
    assert.equal(await readFile(join(dir, "inbox.md"), "utf8"), "(no feedback yet)\n");
  });
});

test("an item appended after a clear remains for the next clear", async () => {
  await withInbox(async () => {
    const first = { selector: "#first", comment: "First item" };
    const second = { selector: "#second", comment: "Second item" };
    await appendItems([first]);

    assert.deepEqual(await readAndClear(), [first]);
    await appendItems([second]);

    assert.deepEqual(await readAndClear(), [second]);
    assert.deepEqual(await readAndClear(), []);
  });
});

test("re-sending an item id overwrites its pending entry with the latest content", async () => {
  await withInbox(async (dir) => {
    await appendItems([{ id: "annotation-1", comment: "original" }]);
    await appendItems([{ id: "annotation-1", comment: "updated" }]);
    await appendItems([{ id: "annotation-2", comment: "separate" }]);

    assert.deepEqual((await readdir(join(dir, "pending"))).sort(), ["annotation-1.json", "annotation-2.json"]);
    assert.deepEqual(await readAndClear(), [
      { id: "annotation-1", comment: "updated" },
      { id: "annotation-2", comment: "separate" },
    ]);
  });
});

test("unsafe item ids are sanitized without escaping the pending directory", async () => {
  await withInbox(async (dir) => {
    const item = { id: "a/b", comment: "contained" };

    await appendItems([item]);

    assert.deepEqual(await readdir(join(dir, "pending")), ["a_b.json"]);
    await assert.rejects(readFile(join(dir, "a.json"), "utf8"), { code: "ENOENT" });
    assert.deepEqual(await readAndClear(), [item]);
  });
});

test("concurrent consumers tolerate files removed by the other consumer", async () => {
  await withInbox(async () => {
    await appendItems([{ id: "racing-item", comment: "race" }]);

    const results = await Promise.allSettled([readAndClear(), readAndClear()]);

    assert.ok(results.every(({ status }) => status === "fulfilled"));
  });
});
