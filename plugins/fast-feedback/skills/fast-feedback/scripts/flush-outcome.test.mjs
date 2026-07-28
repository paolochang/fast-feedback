import assert from "node:assert/strict";
import test from "node:test";

import { flushOutcome, sendLabel } from "./flush-outcome.mjs";

test("flushOutcome clears Live feedback after inbox delivery", () => {
  assert.deepEqual(flushOutcome({ sentToInbox: true, count: 3 }), {
    clear: true,
    toast: "Sent 3 items ✓",
    isError: false,
  });
});

test("flushOutcome retains Live feedback when delivery is not confirmed", () => {
  assert.deepEqual(flushOutcome({ sentToInbox: false, count: 2 }), {
    clear: false,
    toast: "Archived 2 locally — the AI did not receive this. Use Copy All.",
    isError: true,
  });
});

test("flushOutcome treats an undefined inbox result as not delivered", () => {
  assert.deepEqual(flushOutcome({ count: 1 }), {
    clear: false,
    toast: "Archived 1 locally — the AI did not receive this. Use Copy All.",
    isError: true,
  });
});

test("flushOutcome reports no work for an empty flush regardless of delivery", () => {
  for (const sentToInbox of [true, false, undefined]) {
    assert.deepEqual(flushOutcome({ sentToInbox, count: 0 }), {
      clear: false,
      toast: "Nothing new to send",
      isError: false,
    });
  }
});

test("flushOutcome source is a self-contained function declaration", () => {
  const source = flushOutcome.toString();
  const isolatedFlushOutcome = eval(`(${source})`);

  assert.match(source, /function/);
  for (const input of [
    { sentToInbox: true, count: 4 },
    { sentToInbox: false, count: 4 },
    { count: 4 },
    { sentToInbox: true, count: 0 },
  ]) {
    assert.deepEqual(isolatedFlushOutcome(input), flushOutcome(input));
  }
});

test("sendLabel distinguishes server delivery from local archiving", () => {
  assert.deepEqual(sendLabel(true), {
    label: "Send to AI",
    title: "Send new feedback to AI",
  });
  assert.deepEqual(sendLabel(false), {
    label: "Archive locally",
    title: "No server in this mode — archives to History. Use Copy All to reach the AI.",
  });
});
