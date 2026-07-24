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
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function pendingFiles(pendingDir) {
  const names = (await readdir(pendingDir)).filter((name) => name.endsWith(".json"));
  const files = await Promise.all(names.map(async (name) => ({
    name,
    mtimeMs: (await stat(join(pendingDir, name))).mtimeMs,
  })));
  return files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
}

async function readPending(pendingDir) {
  const files = await pendingFiles(pendingDir);
  return Promise.all(files.map(async ({ name }) => JSON.parse(await readFile(join(pendingDir, name), "utf8"))));
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
  await Promise.all(items.map((item) => writeAtomically(
    join(pendingDir, randomUUID() + ".json"),
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

export async function readAndClear() {
  const { dir, pendingDir } = await ensureInbox();
  const files = await pendingFiles(pendingDir);
  const items = await Promise.all(files.map(async ({ name }) => ({
    name,
    item: JSON.parse(await readFile(join(pendingDir, name), "utf8")),
  })));
  await Promise.all(items.map(({ name }) => rm(join(pendingDir, name))));
  await regenerateMirrors(dir, pendingDir);
  return items.map(({ item }) => item);
}
