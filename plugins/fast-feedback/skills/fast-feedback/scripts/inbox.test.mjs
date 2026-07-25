import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rmdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendItems, count, peek, readAndClear, regenerateMirrors, withMirrorLock } from "./inbox.mjs";

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

test("concurrent consumers do not recover an aged item after it is claimed", async () => {
  await withInbox(async (dir) => {
    const item = { comment: "aged before claim" };
    let releaseRemove;
    let claimed;
    const removeClaimed = new Promise((resolve) => {
      claimed = resolve;
    });
    const waitForRemove = new Promise((resolve) => {
      releaseRemove = resolve;
    });
    const previousTtl = process.env.FFB_CLAIM_TTL_MS;
    process.env.FFB_CLAIM_TTL_MS = "1000";
    try {
      await appendItems([item]);
      const [name] = await readdir(join(dir, "pending"));
      const pendingPath = join(dir, "pending", name);
      await utimes(pendingPath, new Date(Date.now() - 120000), new Date(Date.now() - 120000));

      const first = readAndClear({ remove: async (path) => {
        claimed();
        await waitForRemove;
        await rm(path);
      } });
      await removeClaimed;
      const second = await readAndClear();
      releaseRemove();
      const returned = (await first).concat(second);

      assert.deepEqual(returned.map(({ comment }) => comment), [item.comment]);
    } finally {
      if (previousTtl === undefined) delete process.env.FFB_CLAIM_TTL_MS;
      else process.env.FFB_CLAIM_TTL_MS = previousTtl;
    }
  });
});

test("a consumer does not return an item when recovery reassigns and deletes its expired claim", async () => {
  await withInbox(async (dir) => {
    const item = { comment: "recover and delete me" };
    let firstDeleteReady;
    let releaseFirstDelete;
    const firstDeleteStarted = new Promise((resolve) => {
      firstDeleteReady = resolve;
    });
    const releaseDelete = new Promise((resolve) => {
      releaseFirstDelete = resolve;
    });
    const previousTtl = process.env.FFB_CLAIM_TTL_MS;
    process.env.FFB_CLAIM_TTL_MS = "1";
    try {
      await appendItems([item]);

      const first = readAndClear({ remove: async (path) => {
        firstDeleteReady();
        await releaseDelete;
        await rm(path);
      } });
      await firstDeleteStarted;
      const claimedName = (await readdir(join(dir, "pending"))).find((name) => name.endsWith(".claimed"));
      await utimes(join(dir, "pending", claimedName), new Date(Date.now() - 1000), new Date(Date.now() - 1000));

      const second = await readAndClear();
      releaseFirstDelete();
      const firstItems = await first;

      assert.deepEqual(firstItems, []);
      assert.deepEqual(second.map(({ comment }) => comment), [item.comment]);
    } finally {
      if (previousTtl === undefined) delete process.env.FFB_CLAIM_TTL_MS;
      else process.env.FFB_CLAIM_TTL_MS = previousTtl;
    }
  });
});

test("withMirrorLock excludes overlapping critical sections", async () => {
  await withInbox(async (dir) => {
    let inFlight = false;
    let overlapped = false;
    let releaseFirst;
    let enteredFirst;
    const firstEntered = new Promise((resolve) => {
      enteredFirst = resolve;
    });
    const release = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    const first = withMirrorLock(dir, async () => {
      inFlight = true;
      enteredFirst();
      await release;
      inFlight = false;
    });
    await firstEntered;
    const second = withMirrorLock(dir, async () => {
      overlapped = inFlight;
    });
    releaseFirst();
    await Promise.all([first, second]);

    assert.equal(overlapped, false);
  });
});

test("serialized mirror regeneration publishes the current spool after an interleaved clear", async () => {
  await withInbox(async (dir) => {
    const item = { comment: "clear me" };
    let releaseAcquire;
    let acquired;
    const waitForClear = new Promise((resolve) => {
      releaseAcquire = resolve;
    });
    const holderAcquired = new Promise((resolve) => {
      acquired = resolve;
    });
    await appendItems([item]);

    const stale = regenerateMirrors(dir, join(dir, "pending"), { afterAcquire: () => {
      acquired();
      return waitForClear;
    } });
    await holderAcquired;
    await readAndClear();
    releaseAcquire();
    await stale;

    const jsonl = await readFile(join(dir, "inbox.jsonl"), "utf8");
    assert.deepEqual(jsonl.trim() ? jsonl.trim().split("\n").map((line) => JSON.parse(line)) : [], await peek());
  });
});

test("regenerateMirrors skips and marks dirty when the mirror lock cannot be acquired", async () => {
  await withInbox(async (dir) => {
    await appendItems([]);
    await rm(join(dir, "inbox.jsonl"));
    const lockDir = join(dir, ".mirror.lock");
    await mkdir(lockDir);
    try {
      await writeFile(
        join(dir, "pending", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json"),
        JSON.stringify({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", comment: "blocked" }),
        "utf8",
      );
      await Promise.race([
        regenerateMirrors(dir, join(dir, "pending")),
        new Promise((_, reject) => setTimeout(() => reject(new Error("mirror regeneration timed out")), 3000)),
      ]);
      await assert.rejects(readFile(join(dir, "inbox.jsonl"), "utf8"), { code: "ENOENT" });
      assert.equal(await readFile(join(dir, ".mirror.dirty"), "utf8"), "");
    } finally {
      await rmdir(lockDir);
    }
  });
});

test("regenerateMirrors clears dirty and refreshes the current spool", async () => {
  await withInbox(async (dir) => {
    const item = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", comment: "refresh me" };
    await appendItems([]);
    await writeFile(join(dir, "pending", item.id + ".json"), JSON.stringify(item), "utf8");
    await writeFile(join(dir, "inbox.jsonl"), JSON.stringify({ comment: "stale" }) + "\n", "utf8");
    await writeFile(join(dir, ".mirror.dirty"), "", "utf8");

    await regenerateMirrors(dir, join(dir, "pending"));

    const jsonl = await readFile(join(dir, "inbox.jsonl"), "utf8");
    assert.deepEqual(jsonl.trim().split("\n").map((line) => JSON.parse(line)), await peek());
    await assert.rejects(readFile(join(dir, ".mirror.dirty"), "utf8"), { code: "ENOENT" });
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
