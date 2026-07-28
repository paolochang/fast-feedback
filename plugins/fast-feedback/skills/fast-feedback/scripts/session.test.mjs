import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseSession, renderSession } from "./session.mjs";

const session = {
  mode: "static",
  version: "0.3.0",
  url: "http://127.0.0.1:5000",
  started_at: "2026-07-28T12:00:00.000Z",
};

test("renderSession and parseSession round-trip an injected timestamp", () => {
  assert.deepEqual(parseSession(renderSession(session)), session);
});

test("parseSession returns null for malformed JSON and missing fields", () => {
  assert.equal(parseSession("not JSON"), null);
  assert.equal(parseSession(JSON.stringify({ ...session, mode: undefined })), null);
});

test("session helpers do not read a clock or process state", async () => {
  const source = await readFile(new URL("./session.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bDate\b|\bprocess\b/);
});
