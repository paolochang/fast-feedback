import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { withLock } from "./inbox.mjs";
import {
  PROCESSING_STALL_MS,
  QUEUED_STALL_MS,
  createQueued,
  markProcessing,
  markSettled,
  progressDir,
  readStatuses,
  withdraw,
} from "./progress.mjs";

const FIRST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SENT_AT = "2026-08-01T12:00:00.000Z";

async function withProgress(run) {
  const dir = await mkdtemp(join(tmpdir(), "ffb-progress-"));
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

const queued = (progress_id = FIRST, sent_at = SENT_AT) => ({ progress_id, item_id: ITEM, sent_at });

test("progressDir respects FFB_INBOX without adding another .ffb segment", { concurrency: false }, async () => {
  await withProgress(async (dir) => {
    assert.equal(progressDir(), join(resolve(dir), "progress"));
    await createQueued([queued()]);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "progress", FIRST + ".json"), "utf8")), {
      ...queued(), status: "queued", claimed_at: null, settled_at: null,
    });
    assert.deepEqual((await readdir(join(dir, "progress"))).filter((name) => name.endsWith(".tmp")), []);
  });
});

test("transitions are monotonic and terminal records are never reopened", async () => {
  await withProgress(async () => {
    await createQueued([queued()]);
    assert.deepEqual(await markProcessing([FIRST], { now: () => Date.parse("2026-08-01T12:01:00.000Z") }), { updated: [FIRST], unknown: [] });
    await createQueued([queued(FIRST, "2026-08-01T13:00:00.000Z")]);
    assert.equal((await readStatuses([FIRST], { now: () => Date.parse("2026-08-01T12:02:00.000Z") }))[0].status, "processing");
    assert.deepEqual(await markSettled([FIRST], "completed", { now: () => Date.parse("2026-08-01T12:03:00.000Z") }), { updated: [FIRST], unknown: [] });
    await markProcessing([FIRST], { now: () => Date.parse("2026-08-01T12:04:00.000Z") });
    await markSettled([FIRST], "failed", { now: () => Date.parse("2026-08-01T12:05:00.000Z") });
    await createQueued([queued()], { now: () => Date.parse("2026-08-01T12:06:00.000Z") });
    const record = (await readStatuses([FIRST], { now: () => Date.parse("2026-08-01T12:06:00.000Z") }))[0];
    assert.equal(record.status, "completed");
    assert.equal(record.settled_at, "2026-08-01T12:03:00.000Z");
  });
});

test("settling accepts queued records and mutations report unknown ids", async () => {
  await withProgress(async () => {
    await createQueued([queued()]);
    assert.deepEqual(await markSettled([FIRST, SECOND], "completed"), { updated: [FIRST], unknown: [SECOND] });
    assert.equal((await readStatuses([FIRST], { now: () => Date.parse("2026-08-01T12:01:00.000Z") }))[0].status, "completed");
    await assert.rejects(markSettled([FIRST], "processing"), /completed or failed/);
  });
});

test("readStatuses derives stalled deadlines without persisting stalled", async () => {
  await withProgress(async (dir) => {
    await createQueued([queued(FIRST, new Date(1000).toISOString()), queued(SECOND, new Date(1000).toISOString())]);
    await markProcessing([SECOND], { now: () => 2000 });
    assert.equal((await readStatuses([FIRST], { now: () => 1000 + QUEUED_STALL_MS }))[0].status, "queued");
    assert.equal((await readStatuses([FIRST], { now: () => 1001 + QUEUED_STALL_MS }))[0].status, "stalled");
    assert.equal((await readStatuses([SECOND], { now: () => 2001 + PROCESSING_STALL_MS }))[0].status, "stalled");
    assert.equal(JSON.parse(await readFile(join(dir, "progress", FIRST + ".json"), "utf8")).status, "queued");
    assert.equal(JSON.parse(await readFile(join(dir, "progress", SECOND + ".json"), "utf8")).status, "processing");
  });
});

test("createQueued rolls back the batch when a later record cannot be written", async () => {
  await withProgress(async (dir) => {
    // A directory squatting on the second record's path makes its atomic
    // rename fail after the first record was already written.
    await mkdir(join(dir, "progress"), { recursive: true });
    await mkdir(join(dir, "progress", SECOND + ".json"));
    await assert.rejects(createQueued([queued(FIRST), queued(SECOND)]));
    assert.deepEqual((await readdir(join(dir, "progress"))).filter((name) => name !== SECOND + ".json"), []);
  });
});

test("createQueued sweeps observed terminal records on the window and unobserved ones on the long leash", async () => {
  await withProgress(async (dir) => {
    const fresh = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const unobserved = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await createQueued([queued(FIRST, new Date(1000).toISOString()), queued(SECOND, new Date(1000).toISOString()), queued(unobserved, new Date(1000).toISOString())]);
    await markProcessing([SECOND, unobserved], { now: () => 2000 });
    await markSettled([SECOND, unobserved], "completed", { now: () => 3000 });
    await readStatuses([SECOND], { now: () => 4000 });   // acknowledgement starts SECOND's sweep clock
    const afterWindow = 4000 + 24 * 60 * 60 * 1000 + 1;
    await createQueued([queued(fresh, new Date(afterWindow).toISOString())], { now: () => afterWindow });
    // Queued FIRST always survives; observed SECOND is collected; the record
    // no tab has read yet is kept for a hidden tab that may still return.
    assert.deepEqual((await readdir(join(dir, "progress"))).sort(), [FIRST + ".json", unobserved + ".json", fresh + ".json"].sort());
    const afterLeash = 3000 + 7 * 24 * 60 * 60 * 1000 + 1;
    await createQueued([], { now: () => afterLeash });
    assert.deepEqual((await readdir(join(dir, "progress"))).sort(), [FIRST + ".json", fresh + ".json"].sort());
  });
});

test("reads keep records past the GC window so late observers still see them", async () => {
  await withProgress(async (dir) => {
    await createQueued([queued(FIRST, new Date(1000).toISOString()), queued(SECOND, new Date(1000).toISOString())]);
    await markProcessing([SECOND], { now: () => 2000 });
    await markSettled([SECOND], "completed", { now: () => 3000 });
    const statuses = await readStatuses([FIRST, SECOND], { now: () => 3001 + 24 * 60 * 60 * 1000 });
    // A tab hidden past the window must still observe the completion when it
    // returns; only createQueued's sweep collects expired terminal records.
    assert.deepEqual(statuses.map(({ progress_id, status }) => ({ progress_id, status })), [
      { progress_id: FIRST, status: "stalled" },
      { progress_id: SECOND, status: "completed" },
    ]);
    await stat(join(dir, "progress", FIRST + ".json"));
    await stat(join(dir, "progress", SECOND + ".json"));
  });
});

test("withdraw deletes records and reports only ids that existed", async () => {
  await withProgress(async () => {
    await createQueued([queued()]);
    assert.deepEqual(await withdraw([FIRST, SECOND]), [FIRST]);
    assert.deepEqual(await withdraw([FIRST]), []);
    assert.deepEqual(await readStatuses([FIRST]), [{ progress_id: FIRST, status: "unknown" }]);
  });
});

test("all id inputs are rejected before path construction", async () => {
  await withProgress(async (dir) => {
    await assert.rejects(createQueued([{ progress_id: "../escape", item_id: ITEM, sent_at: SENT_AT }]), /UUID/i);
    await assert.rejects(createQueued([{ progress_id: FIRST, item_id: "../escape", sent_at: SENT_AT }]), /UUID/i);
    for (const operation of [
      () => markProcessing(["../escape"]),
      () => markSettled(["../escape"], "completed"),
      () => readStatuses(["../escape"]),
      () => withdraw(["../escape"]),
    ]) await assert.rejects(operation(), /UUID/i);
    await assert.rejects(stat(join(dir, "escape.json")), { code: "ENOENT" });
  });
});

test("progress mutations complete while the inbox lock is held", async () => {
  await withProgress(async (dir) => {
    await createQueued([queued()]);
    await Promise.race([
      withLock(dir, () => markProcessing([FIRST])),
      new Promise((_, reject) => setTimeout(() => reject(new Error("progress lock deadlocked with inbox lock")), 500)),
    ]);
    assert.equal((await readStatuses([FIRST]))[0].status, "processing");
  });
});

test("malformed records read as unknown and do not break other ids", async () => {
  await withProgress(async (dir) => {
    await createQueued([queued()]);
    await writeFile(join(dir, "progress", SECOND + ".json"), "not json", "utf8");
    assert.deepEqual((await readStatuses([FIRST, SECOND], { now: () => Date.parse("2026-08-01T12:01:00.000Z") })).map(({ status }) => status), ["queued", "unknown"]);
  });
});
