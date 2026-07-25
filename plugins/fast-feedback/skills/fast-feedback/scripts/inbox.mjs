import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

function inboxDir() {
  return process.env.FFB_INBOX ? resolve(process.env.FFB_INBOX) : join(process.cwd(), ".ffb");
}

async function ensureInbox() {
  const dir = inboxDir();
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

async function regenerateMirrors(dir, pendingDir) {
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
  await Promise.all(normalizedItems.map((item) => writeAtomically(
    join(pendingDir, filenameForItem(item)),
    JSON.stringify(item),
  )));
  await regenerateMirrors(dir, pendingDir);
}

export async function peek() {
  const { pendingDir } = await ensureInbox();
  return readPending(pendingDir);
}

export async function count() {
  const { pendingDir } = await ensureInbox();
  return (await pendingFiles(pendingDir)).length;
}

export async function readAndClear({ remove = rm } = {}) {
  const { dir, pendingDir } = await ensureInbox();
  await recoverAbandonedClaims(pendingDir);
  const files = await pendingFiles(pendingDir);
  const claims = await Promise.all(files.map(async ({ name }) => {
    const claimedName = name + "." + randomUUID() + ".claimed";
    try {
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
  await Promise.all(readableEntries.map(async ({ claimedName }) => {
    try {
      await remove(join(pendingDir, claimedName));
    } catch (error) {
      console.error(error);
    }
  }));
  try {
    await regenerateMirrors(dir, pendingDir);
  } catch (error) {
    console.error(error);
  }
  return readableEntries.map(({ item }) => item);
}
