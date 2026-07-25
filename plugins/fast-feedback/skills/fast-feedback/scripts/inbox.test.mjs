import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
    assert.deepEqual(
      spooled.map(({ id, ...item }) => item).sort((a, b) => a.selector.localeCompare(b.selector)),
      items.sort((a, b) => a.selector.localeCompare(b.selector)),
    );

    const jsonl = await readFile(join(dir, "inbox.jsonl"), "utf8");
    assert.deepEqual(
      jsonl.trim().split("\n").map((line) => JSON.parse(line)).map(({ id, ...item }) => item).sort((a, b) => a.selector.localeCompare(b.selector)),
      items.sort((a, b) => a.selector.localeCompare(b.selector)),
    );

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
    assert.deepEqual((await peek()).map(({ id, ...item }) => item), items);
    assert.equal(await count(), 1);

    assert.deepEqual((await readAndClear()).map(({ id, ...item }) => item), items);
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

    assert.deepEqual((await readAndClear()).map(({ id, ...item }) => item), [first]);
    await appendItems([second]);

    assert.deepEqual((await readAndClear()).map(({ id, ...item }) => item), [second]);
    assert.deepEqual(await readAndClear(), []);
  });
});

test("UUID item ids name and update their own pending entry", async () => {
  await withInbox(async (dir) => {
    const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await appendItems([{ id: firstId, comment: "original" }]);
    await appendItems([{ id: firstId, comment: "updated" }]);
    await appendItems([{ id: secondId, comment: "separate" }]);

    assert.deepEqual((await readdir(join(dir, "pending"))).sort(), [firstId + ".json", secondId + ".json"]);
    assert.deepEqual(await readAndClear(), [
      { id: firstId, comment: "updated" },
      { id: secondId, comment: "separate" },
    ]);
  });
});

test("non-UUID ids are replaced with distinct UUIDs before spooling", async () => {
  await withInbox(async (dir) => {
    await appendItems([
      { id: "a/b", comment: "slash" },
      { id: "a_b", comment: "underscore" },
    ]);

    const names = await readdir(join(dir, "pending"));
    assert.equal(names.length, 2);
    assert.ok(names.every((name) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(name)));
    assert.ok(names.every((name) => !name.includes("a_b")));
    assert.deepEqual(
      (await readAndClear()).map(({ comment, id }) => ({ comment, validId: /^[0-9a-f-]{36}$/i.test(id) })).sort((left, right) => left.comment.localeCompare(right.comment)),
      [{ comment: "slash", validId: true }, { comment: "underscore", validId: true }],
    );
  });
});

test("peek and count ignore files claimed by another consumer", async () => {
  await withInbox(async (dir) => {
    await appendItems([]);
    const claimed = join(dir, "pending", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json.claimed");
    await writeFile(claimed, JSON.stringify({ comment: "already claimed" }), "utf8");

    assert.equal(await count(), 0);
    assert.deepEqual(await peek(), []);
  });
});

test("concurrent consumers exclusively claim every pending item", async () => {
  await withInbox(async () => {
    const items = Array.from({ length: 12 }, (_, index) => ({ comment: "race " + index }));
    await appendItems(items);

    const results = await Promise.all([readAndClear(), readAndClear()]);
    const returned = results.flat();

    assert.equal(returned.length, items.length);
    assert.equal(new Set(returned.map(({ id }) => id)).size, items.length);
    assert.deepEqual(returned.map(({ comment }) => comment).sort(), items.map(({ comment }) => comment).sort());
  });
});
