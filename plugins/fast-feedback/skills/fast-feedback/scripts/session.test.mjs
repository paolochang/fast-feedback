import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseSessions, renderSessions } from "./session.mjs";

const session = {
  id: "session-identity",
  mode: "static",
  version: "0.3.0",
  url: "http://127.0.0.1:5000",
  started_at: "2026-07-28T12:00:00.000Z",
};

test("renderSessions and parseSessions round-trip valid sessions", () => {
  assert.deepEqual(parseSessions(renderSessions([session])), [session]);
});

test("parseSessions accepts legacy markers and drops invalid entries", () => {
  assert.deepEqual(parseSessions(JSON.stringify(session)), [session]);
  assert.deepEqual(parseSessions(JSON.stringify({ sessions: [session, { ...session, id: undefined }, { ...session, id: 1 }] })), [session]);
  assert.deepEqual(parseSessions("not JSON"), []);
  assert.deepEqual(parseSessions(JSON.stringify({ sessions: session })), []);
});

test("session helpers do not read a clock or process state", async () => {
  const source = await readFile(new URL("./session.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bDate\b|\bprocess\b/);
});
