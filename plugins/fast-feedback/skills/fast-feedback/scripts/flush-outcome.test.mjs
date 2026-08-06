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

function overlaySendToAI(anns, archive) {
  const overlay = readFileSync(new URL("../assets/overlay.js", import.meta.url), "utf8");
  const match = overlay.match(/^  function sendToAI\(\) \{[\s\S]*?^  }\n\n(?=  \/\/ ---- screenshot)/m);
  assert.ok(match);
  const factory = new Function("input", "var anns=input.anns;var window={};var sendInFlight=false;var capturesInFlight=0;var historyRows=null;var historyError=false;var historyVisibleCount=10;var location={href:'http://example.test/'};var crypto={randomUUID:function(){return 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';}};var hasIndexedDb=function(){return true;};var showToast=function(){};var capturePng=function(){return Promise.resolve({w:1,h:1,blob:new Uint8Array()});};var captureRegion=function(){return null;};var historyStore={archive:input.archive};var flushOutcome=function(flush){return {clear:false,toast:'',isError:false};};var renderList=function(){};" + match[0].replace(/^  /gm, "") + ";return {sendToAI:sendToAI,state:function(){return {sendInFlight:sendInFlight,anns:anns};}};");
  return factory({ anns, archive });
}

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
