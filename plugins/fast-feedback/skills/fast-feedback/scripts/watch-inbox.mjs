// Wake an idle Claude Code session when feedback lands in the spool.
//
// MCP tool calls are always client-initiated, so nothing can start a turn in an
// idle session when the user hits Send — the feedback used to sit in the spool
// until the user typed "I sent it". This watcher closes that gap through the
// harness instead of the protocol: the session runs it as a background Bash
// task; it blocks until the inbox has pending feedback, prints one line, and
// exits 0. The harness's background-task completion notification re-invokes
// the session, which calls ffb_pull, applies the items, and re-arms the
// watcher.
//
// Read-only on purpose: it never consumes the spool, so delivery bookkeeping
// (flush outcomes, progress records) keeps its single ffb_pull/ffb_wait
// consumption path.
//
// Exit codes: 0 = feedback pending (call ffb_pull, then re-arm),
//             2 = lifetime expired with no feedback (just re-arm).
//
// Usage: node watch-inbox.mjs
// Run from the project root so it resolves the same <root>/.ffb/ as the ffb
// server and MCP server, or set FFB_INBOX to the same absolute path.

import { count, inboxPath } from "./inbox.mjs";

const POLL_INTERVAL_MS = 500;
// A session that dies without cleaning up must not leave an immortal poller.
const MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const deadline = Date.now() + MAX_LIFETIME_MS;
for (;;) {
  // Pending is checked before the deadline so a watcher armed while feedback
  // already waits (a send that landed between ffb_pull and the re-arm) exits
  // immediately instead of the send waiting for the next watcher.
  const pending = await count();
  if (pending > 0) {
    console.log("fast-feedback: " + pending + " pending item(s) in " + inboxPath() + " — call ffb_pull");
    process.exit(0);
  }
  if (Date.now() >= deadline) {
    console.log("fast-feedback: watcher lifetime expired with no feedback — re-arm to keep watching");
    process.exit(2);
  }
  await delay(POLL_INTERVAL_MS);
}
