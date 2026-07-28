import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseSession, renderSession } from "./session.mjs";

export function inboxPath() {
  return process.env.FFB_INBOX ? resolve(process.env.FFB_INBOX) : join(process.cwd(), ".ffb");
}

function sessionPath() {
  return join(inboxPath(), "session.json");
}

async function ensureInbox() {
  const dir = inboxPath();
  const pendingDir = join(dir, "pending");
  await mkdir(pendingDir, { recursive: true });
  return { dir, pendingDir };
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

export async function writeSession(session) {
  const path = sessionPath();
  await mkdir(inboxPath(), { recursive: true });
  await writeAtomically(path, renderSession(session));
}

export async function readSession() {
  try {
    return parseSession(await readFile(sessionPath(), "utf8"));
  } catch {
    return null;
  }
}

async function recoverAbandonedClaims(pendingDir) {
  const ttlMs = process.env.FFB_CLAIM_TTL_MS === undefined ? 60000 : Number(process.env.FFB_CLAIM_TTL_MS);
  const claims = (await readdir(pendingDir)).map((name) => {
    const match = name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.claimed$/i);
    return match ? { claimedName: name } : null;
  }).filter(Boolean);
  await Promise.all(claims.map(async ({ claimedName }) => {
    try {
      if ((await stat(join(pendingDir, claimedName))).mtimeMs >= Date.now() - ttlMs) return;
      await rename(join(pendingDir, claimedName), join(pendingDir, randomUUID() + ".json"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }));
}

async function pendingFiles(pendingDir) {
  await recoverAbandonedClaims(pendingDir);
  const names = (await readdir(pendingDir)).filter((name) => name.endsWith(".json"));
  const files = await Promise.all(names.map(async (name) => {
    try {
      return { name, mtimeMs: (await stat(join(pendingDir, name))).mtimeMs };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }));
  return files.filter(Boolean).sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
}

async function readPending(pendingDir) {
  const files = await pendingFiles(pendingDir);
  const entries = await Promise.all(files.map(async ({ name }) => {
    try {
      return { item: JSON.parse(await readFile(join(pendingDir, name), "utf8")) };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }));
  return entries.filter(Boolean).map(({ item }) => item);
}

function filenameForItem(item) {
  return isUuid(item?.id) ? item.id + ".json" : randomUUID() + ".json";
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item) || isUuid(item.id)) return item;
  return { ...item, id: randomUUID() };
}

function buildMarkdown(items) {
  if (!items.length) return "(no feedback yet)\n";

  let markdown = "# Fast feedback inbox\n";
  items.forEach((item, index) => {
    const feedback = item && typeof item === "object" ? item : {};
    const region = feedback.region || {};
    const selector = feedback.selector || feedback.sel || "(no selector)";
    const comment = feedback.comment || "(no comment)";
    const number = feedback.n || index + 1;
    const coordinates = ["x", "y", "w", "h"].every((key) => region[key] !== undefined)
      ? "  [x" + region.x + "% y" + region.y + "% w" + region.w + "% h" + region.h + "%]"
      : "";
    markdown += "- [" + number + "] " + selector + coordinates + "  " + comment + "\n";
  });
  return markdown;
}

// Best-effort serializer for the DERIVED mirror (inbox.jsonl / inbox.md) — a
// human-only view that no MCP tool reads; peek/count/readAndClear read the spool
// directly. Exactly-once delivery is owned by claim-by-rename in readAndClear (an
// atomic single-winner rename with ENOENT -> skip), NOT by this lock. So a
// pathological stall that lets two operations overlap here can at worst leave a
// transiently stale mirror, which the next operation's writeMirrors() self-heals;
// it can never cause duplicate delivery or spool corruption.
export async function withLock(dir, run) {
  const lockDir = join(dir, ".lock");
  const ownerFile = join(lockDir, "owner");
  const token = randomUUID();
  const leaseMs = process.env.FFB_LOCK_LEASE_MS === undefined ? 5000 : Number(process.env.FFB_LOCK_LEASE_MS);
  for (;;) {
    try {
      await mkdir(lockDir);
      await writeFile(ownerFile, token, "utf8");
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if ((await stat(lockDir)).mtimeMs < Date.now() - leaseMs) {
          // Recursive+force so a stale lock is recoverable even if it is
          // non-empty (e.g. an ownerless directory a failed release left behind);
          // a plain rmdir would throw ENOTEMPTY and wedge every future operation.
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  const renewMs = Math.max(15, Math.floor(leaseMs / 2));
  const renew = setInterval(() => {
    utimes(lockDir, new Date(), new Date()).catch(() => {});
  }, renewMs);
  if (typeof renew.unref === "function") renew.unref();
  try {
    return await run();
  } finally {
    // Keep renewing through the release so our own lock cannot go stale (and be
    // stolen + re-acquired by another holder) between the ownership check and the
    // removal — which would otherwise let us clobber the successor's lock. Stop the
    // renewal only after we have released, in a nested finally so it never leaks.
    try {
      // Release is best-effort: run() has already produced its result (for
      // readAndClear, the items are already delivered and removed from the spool),
      // so a cleanup failure must never propagate and discard that result. A lock
      // left behind is self-healing — the next acquirer steals it after the lease.
      let ownsLock = false;
      try {
        ownsLock = (await readFile(ownerFile, "utf8")) === token;
      } catch (error) {
        if (error?.code !== "ENOENT") console.error(error);
      }
      if (ownsLock) {
        try {
          // Recursive+force so release also clears a non-empty lock in one step
          // and never leaves an unrecoverable directory behind.
          await rm(lockDir, { recursive: true, force: true });
        } catch (error) {
          if (error?.code !== "ENOENT") console.error(error);
        }
      }
    } finally {
      clearInterval(renew);
    }
  }
}

async function writeMirrors(dir, pendingDir) {
  const items = await readPending(pendingDir);
  const jsonl = items.map((item) => JSON.stringify(item)).join("\n") + (items.length ? "\n" : "");
  await Promise.all([
    writeAtomically(join(dir, "inbox.jsonl"), jsonl),
    writeAtomically(join(dir, "inbox.md"), buildMarkdown(items)),
  ]);
  return items;
}

export async function appendItems(items) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");

  const { dir, pendingDir } = await ensureInbox();
  const normalizedItems = items.map(normalizeItem);
  await withLock(dir, async () => {
    await Promise.all(normalizedItems.map((item) => writeAtomically(
      join(pendingDir, filenameForItem(item)),
      JSON.stringify(item),
    )));
    try {
      await writeMirrors(dir, pendingDir);
    } catch (error) {
      console.error(error);
    }
  });
}

export async function peek() {
  const { dir, pendingDir } = await ensureInbox();
  return withLock(dir, () => readPending(pendingDir));
}

export async function count() {
  const { dir, pendingDir } = await ensureInbox();
  return withLock(dir, async () => (await pendingFiles(pendingDir)).length);
}

export async function readAndClear({ remove = rm } = {}) {
  const { dir, pendingDir } = await ensureInbox();
  return withLock(dir, async () => {
    await recoverAbandonedClaims(pendingDir);
    const files = await pendingFiles(pendingDir);
    const claims = await Promise.all(files.map(async ({ name }) => {
      const claimedName = name + "." + randomUUID() + ".claimed";
      try {
        await utimes(join(pendingDir, name), new Date(), new Date());
        await rename(join(pendingDir, name), join(pendingDir, claimedName));
        return { claimedName };
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    }));
    const entries = await Promise.all(claims.filter(Boolean).map(async ({ claimedName }) => {
      try {
        return {
          claimedName,
          item: JSON.parse(await readFile(join(pendingDir, claimedName), "utf8")),
        };
      } catch (error) {
        try {
          await rename(join(pendingDir, claimedName), join(pendingDir, claimedName + ".corrupt"));
        } catch (renameError) {
          if (renameError?.code !== "ENOENT") throw renameError;
        }
        console.error(error);
        return null;
      }
    }));
    const readableEntries = entries.filter(Boolean);
    const removed = await Promise.all(readableEntries.map(async (entry) => {
      try {
        await remove(join(pendingDir, entry.claimedName));
        return entry;
      } catch (error) {
        console.error(error);
        return null;
      }
    }));
    const deliveredEntries = removed.filter(Boolean);
    try {
      await writeMirrors(dir, pendingDir);
    } catch (error) {
      console.error(error);
    }
    return deliveredEntries.map(({ item }) => item);
  });
}
