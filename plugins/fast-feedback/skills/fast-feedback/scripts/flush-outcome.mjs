// NOTE: both functions are written in the same ES5 style as `assets/overlay.js`
// (no destructuring, no const/let, no arrow functions) because the overlay mirrors
// them inline — it is concatenated as plain script text and cannot import. Keeping
// the syntax identical means the mirror is a literal copy of this source, which is
// what `flush-outcome.test.mjs`'s self-containment test pins.
export function flushOutcome(flush) {
  var sentToInbox = flush.sentToInbox;
  var archivedNew = flush.archivedNew;
  var count = flush.count;

  if (count === 0) {
    return { clear: false, toast: "Nothing new to send", isError: false };
  }

  if (sentToInbox === true) {
    return { clear: true, toast: "Sent " + count + " items ✓", isError: false };
  }

  if (archivedNew === 0) {
    return { clear: false, toast: "Already archived — the AI did not receive this. Use Copy All.", isError: true };
  }

  return {
    clear: false,
    toast: "Archived " + count + " locally — the AI did not receive this. Use Copy All.",
    isError: true,
  };
}

export function sendLabel(canSend) {
  if (canSend === true) {
    return { label: "Send to AI", title: "Send new feedback to AI" };
  }

  return {
    label: "Archive locally",
    title: "No server in this mode — archives to History. Use Copy All to reach the AI.",
  };
}
