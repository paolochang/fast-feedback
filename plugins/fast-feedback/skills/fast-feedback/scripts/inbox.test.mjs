import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rmdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendItems, count, peek, readAndClear, withLock } from "./inbox.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function assertMirrorMatchesSpool(dir) {
  const jsonl = await readFile(join(dir, "inbox.jsonl"), "utf8");
  const mirror = jsonl.trim() ? jsonl.trim().split("\n").map((line) => JSON.parse(line)) : [];
  assert.deepEqual(mirror, await peek());
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

test("appendItems retains pending items when mirror regeneration fails", async () => {
  await withInbox(async (dir) => {
    const item = { selector: "main", comment: "Keep this" };
    await mkdir(join(dir, "inbox.jsonl"));

    await appendItems([item]);

    assert.deepEqual((await peek()).map(({ id, ...entry }) => entry), [item]);
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

test("concurrent consumers deliver an aged pending item exactly once", async () => {
  await withInbox(async (dir) => {
    const item = { comment: "aged before claim" };
    await appendItems([item]);
    const [name] = await readdir(join(dir, "pending"));
    const pendingPath = join(dir, "pending", name);
    await utimes(pendingPath, new Date(Date.now() - 120000), new Date(Date.now() - 120000));

    const returned = (await Promise.all([readAndClear(), readAndClear()])).flat();

    assert.deepEqual(returned.map(({ comment }) => comment), [item.comment]);
  });
});

test("readAndClear does not return an item when its claimed file disappears before deletion", async () => {
  await withInbox(async () => {
    const item = { comment: "recover and delete me" };
    await appendItems([item]);

    const returned = await readAndClear({ remove: async (path) => {
      await rm(path);
      const error = new Error("already removed");
      error.code = "ENOENT";
      throw error;
    } });

    assert.deepEqual(returned, []);
    assert.deepEqual(await readAndClear(), []);
  });
});

test("spool operations wait for the operation lock instead of skipping", async () => {
  await withInbox(async (dir) => {
    const lockDir = join(dir, ".lock");
    await mkdir(lockDir);
    const append = appendItems([{ comment: "wait for lock" }]);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(readFile(join(dir, "inbox.jsonl"), "utf8"), { code: "ENOENT" });

    await rmdir(lockDir);
    await append;
    assert.deepEqual((await peek()).map(({ comment }) => comment), ["wait for lock"]);
  });
});

test("a live lock holder renews its lease so a contender does not overlap", async () => {
  await withInbox(async (dir) => {
    const previousLease = process.env.FFB_LOCK_LEASE_MS;
    process.env.FFB_LOCK_LEASE_MS = "120";
    try {
      const events = [];
      const first = withLock(dir, async () => {
        events.push("A-start");
        await delay(5400);
        events.push("A-end");
      });

      await delay(30);
      const second = withLock(dir, async () => {
        events.push("B-start");
      });

      await Promise.all([first, second]);
      assert.deepEqual(events, ["A-start", "A-end", "B-start"]);
    } finally {
      if (previousLease === undefined) delete process.env.FFB_LOCK_LEASE_MS;
      else process.env.FFB_LOCK_LEASE_MS = previousLease;
    }
  });
});

test("a lock holder leaves a lock owned by someone else intact", async () => {
  await withInbox(async (dir) => {
    const lockDir = join(dir, ".lock");
    try {
      await withLock(dir, async () => {
        await writeFile(join(lockDir, "owner"), "FOREIGN-OWNER", "utf8");
      });

      await stat(lockDir);
      assert.equal(await readFile(join(lockDir, "owner"), "utf8"), "FOREIGN-OWNER");
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });
});

test("readAndClear returns delivered items even when lock cleanup fails", async () => {
  await withInbox(async (dir) => {
    await appendItems([{ comment: "deliver me" }]);
    const lockDir = join(dir, ".lock");
    try {
      const delivered = await readAndClear({
        remove: async (target) => {
          await rm(target);
          // Sabotage the lock release: leave a stray entry so the finally's
          // rmdir(lockDir) fails with ENOTEMPTY after the item is delivered.
          await writeFile(join(lockDir, "stray"), "x", "utf8");
        },
      });
      assert.deepEqual(delivered.map(({ comment }) => comment), ["deliver me"]);
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });
});

test("a non-empty leftover lock is recovered by the next operation", async () => {
  await withInbox(async (dir) => {
    const lockDir = join(dir, ".lock");
    const previousLease = process.env.FFB_LOCK_LEASE_MS;
    process.env.FFB_LOCK_LEASE_MS = "20";
    try {
      // Simulate what a failed release leaves behind: a non-empty, ownerless,
      // already-stale lock directory (the owner file gone, a stray entry left).
      await mkdir(lockDir);
      await writeFile(join(lockDir, "stray"), "x", "utf8");
      const stale = new Date(Date.now() - 10000);
      await utimes(lockDir, stale, stale);

      // The next operation must steal (recover) the stale non-empty lock, not wedge.
      await appendItems([{ comment: "after recovery" }]);
      assert.deepEqual((await peek()).map(({ comment }) => comment), ["after recovery"]);
    } finally {
      if (previousLease === undefined) delete process.env.FFB_LOCK_LEASE_MS;
      else process.env.FFB_LOCK_LEASE_MS = previousLease;
      await rm(lockDir, { recursive: true, force: true });
    }
  });
});

test("concurrent spool mutations leave the mirror equal to the final spool", async () => {
  await withInbox(async (dir) => {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const initial = { comment: "initial " + iteration };
      const appended = { comment: "appended " + iteration };
      await appendItems([initial]);
      await assertMirrorMatchesSpool(dir);

      await Promise.all([appendItems([appended]), readAndClear()]);

      await assertMirrorMatchesSpool(dir);
      await readAndClear();
      await assertMirrorMatchesSpool(dir);
    }
  });
});

test("readAndClear returns consumed items when mirror regeneration fails", async () => {
  await withInbox(async (dir) => {
    const items = [{ selector: "main", comment: "Keep this" }];
    await appendItems(items);
    await rm(join(dir, "inbox.jsonl"));
    await mkdir(join(dir, "inbox.jsonl"));

    assert.deepEqual((await readAndClear()).map(({ id, ...item }) => item), items);
    assert.deepEqual(await readAndClear(), []);
  });
});

test("readAndClear quarantines unreadable claims and returns valid items", async () => {
  await withInbox(async (dir) => {
    const item = { selector: "main", comment: "Keep this" };
    const badName = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json";
    await appendItems([item]);
    await writeFile(join(dir, "pending", badName), "not json", "utf8");

    assert.deepEqual((await readAndClear()).map(({ id, ...entry }) => entry), [item]);
    const files = await readdir(join(dir, "pending"));
    assert.equal(files.filter((name) => name.endsWith(".claimed")).length, 0);
    assert.ok(files.some((name) => name.startsWith(badName + ".") && name.endsWith(".claimed.corrupt")));
    assert.deepEqual(await readAndClear(), []);
  });
});

test("readAndClear returns a failed deletion once after its claim expires", async () => {
  await withInbox(async (dir) => {
    const items = [{ comment: "first" }, { comment: "second" }];
    let failed = false;
    let failedComment;
    await appendItems(items);

    const returned = await readAndClear({ remove: async (path) => {
      if (!failed) {
        failed = true;
        failedComment = JSON.parse(await readFile(path, "utf8")).comment;
        const error = new Error("locked");
        error.code = "EPERM";
        throw error;
      }
      await rm(path);
    } });

    assert.equal(failed, true);
    assert.deepEqual(returned.map(({ comment }) => comment), items.map(({ comment }) => comment).filter((comment) => comment !== failedComment));
    const claimedName = (await readdir(join(dir, "pending"))).find((name) => name.endsWith(".claimed"));
    assert.ok(claimedName);
    await utimes(join(dir, "pending", claimedName), new Date(Date.now() - 120000), new Date(Date.now() - 120000));

    assert.deepEqual((await readAndClear()).map(({ comment }) => comment), [failedComment]);
    assert.deepEqual(await readAndClear(), []);
  });
});

test("count, peek, and readAndClear recover expired claims", async () => {
  await withInbox(async (dir) => {
    const item = { comment: "abandoned" };
    const claimedName = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.claimed";
    const claimedPath = join(dir, "pending", claimedName);
    await appendItems([]);
    await writeFile(claimedPath, JSON.stringify(item), "utf8");
    await utimes(claimedPath, new Date(Date.now() - 120000), new Date(Date.now() - 120000));

    assert.equal(await count(), 1);
    assert.deepEqual(await peek(), [item]);
    assert.deepEqual(await readAndClear(), [item]);
  });
});

test("readAndClear preserves a newer resend when recovering an expired claim", async () => {
  await withInbox(async (dir) => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const claimedName = id + ".json.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.claimed";
    const claimedPath = join(dir, "pending", claimedName);
    await appendItems([]);
    await writeFile(claimedPath, JSON.stringify({ id, comment: "stale" }), "utf8");
    await utimes(claimedPath, new Date(Date.now() - 120000), new Date(Date.now() - 120000));
    await appendItems([{ id, comment: "newer" }]);

    assert.ok((await readAndClear()).some((item) => item.comment === "newer"));
  });
});

test("count, peek, and readAndClear ignore fresh claims", async () => {
  await withInbox(async (dir) => {
    const claimedName = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.claimed";
    await appendItems([]);
    await writeFile(join(dir, "pending", claimedName), JSON.stringify({ comment: "in flight" }), "utf8");

    assert.equal(await count(), 0);
    assert.deepEqual(await peek(), []);
    assert.deepEqual(await readAndClear(), []);
    assert.ok((await readdir(join(dir, "pending"))).includes(claimedName));
  });
});
