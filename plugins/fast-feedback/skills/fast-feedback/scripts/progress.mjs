import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inboxPath, withLock } from "./inbox.mjs";

export const QUEUED_STALL_MS = 30 * 60 * 1000;
export const PROCESSING_STALL_MS = 10 * 60 * 1000;
export const PROGRESS_GC_MS = 24 * 60 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

export function progressDir() {
  return join(inboxPath(), "progress");
}

function requireUuid(value, label = "progress id") {
  if (!(typeof value === "string" && UUID_PATTERN.test(value))) {
    throw new TypeError(label + " must be a UUID");
  }
}

function requireIds(ids) {
  if (!Array.isArray(ids)) throw new TypeError("ids must be an array");
  ids.forEach((id) => requireUuid(id));
}

function timestamp(value, label) {
  if (!(typeof value === "string" && Number.isFinite(Date.parse(value)))) {
    throw new TypeError(label + " must be an ISO timestamp");
  }
  return value;
}

async function ensureProgressDir() {
  const dir = progressDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeAtomically(path, contents) {
  const temporaryPath = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporaryPath, contents, "utf8");
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporaryPath, path);
        break;
      } catch (error) {
        if (error?.code !== "EPERM" || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function validRecord(record, id) {
  return record
    && typeof record === "object"
    && !Array.isArray(record)
    && record.progress_id === id
    && UUID_PATTERN.test(record.progress_id)
    && UUID_PATTERN.test(record.item_id)
    && ["queued", "processing", "completed", "failed"].includes(record.status)
    && Number.isFinite(Date.parse(record.sent_at));
}

async function readRecord(path, id) {
  try {
    const record = JSON.parse(await readFile(path, "utf8"));
    return validRecord(record, id) ? record : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function isoNow(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError("now must return a valid time");
  return new Date(milliseconds).toISOString();
}

export async function createQueued(entries) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  const records = entries.map((entry) => {
    requireUuid(entry?.progress_id);
    requireUuid(entry?.item_id, "item id");
    return {
      progress_id: entry.progress_id,
      item_id: entry.item_id,
      status: "queued",
      sent_at: timestamp(entry.sent_at, "sent_at"),
      claimed_at: null,
      settled_at: null,
    };
  });
  const dir = await ensureProgressDir();
  return withLock(dir, async () => {
    const created = [];
    for (const record of records) {
      const path = join(dir, record.progress_id + ".json");
      // A delivery id is single-use. Even replacing another queued record could
      // change which annotation and send timestamp a later completion belongs to.
      if (await readRecord(path, record.progress_id)) continue;
      await writeAtomically(path, JSON.stringify(record));
      created.push(record.progress_id);
    }
    return created;
  });
}

async function transition(ids, from, to, field, { now = Date.now } = {}) {
  requireIds(ids);
  const dir = await ensureProgressDir();
  return withLock(dir, async () => {
    const updated = [];
    const unknown = [];
    let transitionTime;
    for (const id of ids) {
      const path = join(dir, id + ".json");
      const record = await readRecord(path, id);
      if (!record) {
        unknown.push(id);
        continue;
      }
      if (!(Array.isArray(from) ? from.includes(record.status) : record.status === from)) continue;
      transitionTime ??= isoNow(now);
      await writeAtomically(path, JSON.stringify({ ...record, status: to, [field]: transitionTime }));
      updated.push(id);
    }
    return { updated, unknown };
  });
}

export async function markProcessing(ids, options = {}) {
  return transition(ids, "queued", "processing", "claimed_at", options);
}

export async function markSettled(ids, status, options = {}) {
  if (!TERMINAL_STATUSES.has(status)) throw new TypeError("status must be completed or failed");
  return transition(ids, ["queued", "processing"], status, "settled_at", options);
}

function newestTimestamp(record) {
  return Math.max(...[record.sent_at, record.claimed_at, record.settled_at]
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite));
}

function displayedStatus(record, nowMs) {
  if (record.status === "queued" && nowMs - Date.parse(record.sent_at) > QUEUED_STALL_MS) return "stalled";
  if (record.status === "processing" && Number.isFinite(Date.parse(record.claimed_at))
      && nowMs - Date.parse(record.claimed_at) > PROCESSING_STALL_MS) return "stalled";
  return record.status;
}

export async function readStatuses(ids, { now = Date.now } = {}) {
  requireIds(ids);
  const nowValue = now();
  const nowMs = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue);
  if (!Number.isFinite(nowMs)) throw new TypeError("now must return a valid time");
  const dir = await ensureProgressDir();
  return withLock(dir, async () => {
    const results = [];
    for (const id of ids) {
      const path = join(dir, id + ".json");
      const record = await readRecord(path, id);
      if (!record || nowMs - newestTimestamp(record) > PROGRESS_GC_MS) {
        if (record) await rm(path, { force: true });
        results.push({ progress_id: id, status: "unknown" });
        continue;
      }
      results.push({ ...record, status: displayedStatus(record, nowMs) });
    }
    return results;
  });
}

export async function withdraw(ids) {
  requireIds(ids);
  const dir = await ensureProgressDir();
  return withLock(dir, async () => {
    const withdrawn = [];
    for (const id of ids) {
      const path = join(dir, id + ".json");
      if (!await readRecord(path, id)) continue;
      try {
        await rm(path);
        withdrawn.push(id);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return withdrawn;
  });
}
