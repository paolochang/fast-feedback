import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { flushOutcome, sendLabel } from "./flush-outcome.mjs";

test("flushOutcome locks Live feedback after inbox delivery", () => {
  assert.deepEqual(flushOutcome({ sentToInbox: true, count: 3 }), {
    clear: false,
    lock: true,
    toast: "Sent 3 items · AI is working…",
    isError: false,
  });
});

test("flushOutcome reports feedback that is already in flight", () => {
  assert.deepEqual(flushOutcome({ sentToInbox: false, archivedNew: 0, count: 2, inFlight: 2 }), {
    clear: false,
    lock: false,
    toast: "Already sent — the AI is working on these",
    isError: false,
  });
});

test("flushOutcome reports already archived feedback when no local archive is new", () => {
  assert.deepEqual(flushOutcome({ sentToInbox: false, archivedNew: 0, count: 2 }), {
    clear: false,
    lock: false,
    toast: "Already archived — the AI did not receive this. Use Copy All.",
    isError: true,
  });
});

test("flushOutcome reports a new local archive when delivery is not confirmed", () => {
  assert.deepEqual(flushOutcome({ sentToInbox: false, archivedNew: 2, count: 2 }), {
    clear: false,
    lock: false,
    toast: "Archived 2 locally — the AI did not receive this. Use Copy All.",
    isError: true,
  });
});

test("flushOutcome reports no work for an empty flush regardless of delivery", () => {
  for (const sentToInbox of [true, false, undefined]) {
    assert.deepEqual(flushOutcome({ sentToInbox, count: 0 }), {
      clear: false,
      lock: false,
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
    { sentToInbox: false, archivedNew: 0, count: 4, inFlight: 4 },
    { sentToInbox: false, archivedNew: 0, count: 4 },
    { sentToInbox: false, archivedNew: 4, count: 4 },
    { sentToInbox: true, count: 0 },
  ]) {
    assert.deepEqual(isolatedFlushOutcome(input), flushOutcome(input));
  }
});

test("overlay keeps an exact inline copy of flushOutcome", () => {
  const overlay = readFileSync(new URL("../assets/overlay.js", import.meta.url), "utf8");
  const match = overlay.match(/^  function flushOutcome\(flush\) \{[\s\S]*?^  }\n\n(?=  function)/m);
  assert.ok(match);
  assert.equal(match[0].trimEnd().replace(/^  /gm, ""), flushOutcome.toString());
});

function overlaySendToAI(anns, archive, options = {}) {
  const overlay = readFileSync(new URL("../assets/overlay.js", import.meta.url), "utf8");
  const match = overlay.match(/^  function sendToAI\(\) \{[\s\S]*?^  }\n\n(?=  \/\/ ---- screenshot)/m);
  assert.ok(match);
  const factory = new Function("input", "var anns=input.anns;var window=input.window||{};var progressCapable=false;var sendInFlight=false;var capturesInFlight=0;var historyRows=null;var historyError=false;var historyVisibleCount=10;var historyCount=null;var location={href:'http://example.test/'};var crypto={randomUUID:function(){return 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';}};var hasIndexedDb=function(){return true;};var showToast=input.showToast||function(){};var capturePng=function(){return Promise.resolve({w:1,h:1,blob:new Uint8Array()});};var captureRegion=function(){return null;};var historyStore={archive:input.archive};var flushOutcome=input.flushOutcome||function(flush){return {clear:false,lock:false,toast:'',isError:false};};var renderList=function(){};var scheduleProgress=function(){};var updateHistoryCount=function(){};var refreshHistoryCount=function(){};" + match[0].replace(/^  /gm, "") + ";return {sendToAI:sendToAI,state:function(){return {sendInFlight:sendInFlight,anns:anns};}};");
  return factory({ anns, archive, ...options });
}

test("progressOutcome diffs statuses and settles only after every item is terminal", () => {
  const overlay = readFileSync(new URL("../assets/overlay.js", import.meta.url), "utf8");
  const match = overlay.match(/^  function progressOutcome\(current, updates\) \{[\s\S]*?^  \}\n/m);
  assert.ok(match);
  const reduce = eval(`(${match[0].trim()})`);
  assert.deepEqual(reduce({ p1: "processing", p2: "processing" }, [{ progress_id: "p1", status: "completed" }]), {
    states: { p1: "completed", p2: "processing" }, changed: true, locked: 1, completed: 1, settled: false,
  });
  assert.deepEqual(reduce({ p1: "completed", p2: "processing" }, [{ progress_id: "p2", status: "failed" }]), {
    states: { p1: "completed", p2: "failed" }, changed: true, locked: 0, completed: 1, settled: true,
  });
});

test("sendToAI guards an empty second inbox flush", () => {
  const overlay = readFileSync(new URL("../assets/overlay.js", import.meta.url), "utf8");
  const match = overlay.match(/^  function sendToAI\(\) \{[\s\S]*?^  \}\n\n(?=  \/\/ ---- screenshot)/m);
  assert.ok(match);
  assert.match(match[0], /if \(canSend && toSend\.length\) \{\s*sentToInbox = true;/);
});

test("a second flush with nothing new produces the already-sent outcome", async () => {
  const ann = {
    id: "annotation-1", n: 1, sel: "button", region: null, comment: "change it",
    sentToInbox: true, revision: 0, archivedRevision: 0,
    boxEl: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) },
  };
  let sendCalls = 0;
  let flush;
  const overlay = overlaySendToAI([ann], () => Promise.resolve(), {
    window: { __FFB_SEND: () => { sendCalls++; return Promise.resolve(); } },
    flushOutcome: (value) => { flush = value; return { clear: false, lock: false, toast: "Already sent — the AI is working on these", isError: false }; },
  });
  overlay.sendToAI();
  await waitFor(() => !overlay.state().sendInFlight);
  assert.equal(sendCalls, 0);
  assert.equal(flush.sentToInbox, false);
  assert.equal(flush.inFlight, 1);
});

test("console mode does not enable progress UI", () => {
  const overlay = readFileSync(new URL("../assets/overlay.js", import.meta.url), "utf8");
  assert.match(overlay, /var progressCapable = typeof window\.__FFB_PROGRESS === "function";/);
  assert.match(overlay, /if \(!progressCapable \|\| !a\.state\) return "";/);
});

test("full renders and progress patches share completed control holding", () => {
  const overlay = readFileSync(new URL("../assets/overlay.js", import.meta.url), "utf8");
  const predicate = overlay.match(/^  function isHeld\(a\) \{[^\n]+\}/m);
  const render = overlay.match(/^  function renderLiveList\(\) \{[\s\S]*?^  \}\n\n(?=  function statusChipHtml)/m);
  const patch = overlay.match(/^  function patchProgressChips\(\) \{[\s\S]*?^  \}\n\n(?=  function settleProgress)/m);
  assert.ok(predicate);
  assert.ok(render);
  assert.ok(patch);
  assert.match(render[0], /var locked = isHeld\(a\);/);
  assert.match(patch[0], /var held = isHeld\(a\);/);
});

test("progress scheduling requires a tracked locked annotation", () => {
  const overlay = readFileSync(new URL("../assets/overlay.js", import.meta.url), "utf8");
  const schedule = overlay.match(/^  function scheduleProgress\(\) \{[\s\S]*?^  \}\n/m);
  assert.ok(schedule);
  assert.match(schedule[0], /anns\.some\(function \(a\) \{ return isLocked\(a\) && a\.progressId; \}\)/);
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for overlay flush");
}

test("console archive skips an unchanged revision and archives an edited revision", async () => {
  const ann = {
    id: "annotation-1",
    n: 1,
    sel: "amount",
    region: null,
    comment: "change amount to 99.99",
    revision: 0,
    archivedRevision: -1,
    boxEl: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) },
  };
  let archives = 0;
  const overlay = overlaySendToAI([ann], () => { archives++; return Promise.resolve(); });

  overlay.sendToAI();
  await waitFor(() => !overlay.state().sendInFlight);
  assert.equal(archives, 1);
  assert.equal(ann.archivedRevision, 0);

  overlay.sendToAI();
  await waitFor(() => !overlay.state().sendInFlight);
  assert.equal(archives, 1);

  ann.comment = "change amount to 100.00";
  ann.revision++;
  overlay.sendToAI();
  await waitFor(() => !overlay.state().sendInFlight);
  assert.equal(archives, 2);
  assert.equal(ann.archivedRevision, 1);
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
