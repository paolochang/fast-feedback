import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

function inboxDir() {
  return process.env.FFB_INBOX ? resolve(process.env.FFB_INBOX) : join(process.cwd(), ".ffb");
}

async function historyDir() {
  const dir = join(inboxDir(), "history");
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeAtomically(path, contents) {
  const temporaryPath = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporaryPath, contents);
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

export function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function writeBatch(meta, pngBuffer) {
  if (!isUuid(meta?.id)) throw new TypeError("batch id must be a UUID");
  if (!Buffer.isBuffer(pngBuffer)) throw new TypeError("pngBuffer must be a Buffer");

  const dir = await historyDir();
  const id = meta.id;
  await writeAtomically(join(dir, id + ".png"), pngBuffer);
  await writeAtomically(join(dir, id + ".json"), JSON.stringify(meta));
  await writeAtomically(join(dir, id + ".done"), "");
}

export async function listBatches() {
  const dir = await historyDir();
  const names = await readdir(dir);
  const doneIds = names.map((name) => {
    const match = name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.done$/i);
    return match?.[1];
  }).filter(Boolean);
  const batches = await Promise.all(doneIds.map(async (id) => {
    try {
      const [metaText, doneStat] = await Promise.all([
        readFile(join(dir, id + ".json"), "utf8"),
        stat(join(dir, id + ".done")),
      ]);
      const meta = JSON.parse(metaText);
      return isUuid(meta?.id) && meta.id.toLowerCase() === id.toLowerCase()
        ? { meta, timestamp: Number.isFinite(Date.parse(meta.ts)) ? Date.parse(meta.ts) : doneStat.mtimeMs }
        : null;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }));
  return batches.filter(Boolean)
    .sort((left, right) => right.timestamp - left.timestamp || right.meta.id.localeCompare(left.meta.id))
    .map(({ meta }) => meta);
}
