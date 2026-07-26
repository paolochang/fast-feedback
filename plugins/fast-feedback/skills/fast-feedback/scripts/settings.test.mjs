import test from "node:test";
import assert from "node:assert/strict";

import { bootAssignments, ensureVersionChecked } from "./settings.mjs";

const check = ensureVersionChecked({
  fetchImpl: async () => JSON.stringify({
    plugins: [{ name: "fast-feedback", version: "0.2.1" }],
  }),
});

test("bootAssignments injects plain version values after the version check", async () => {
  await check;
  const assignments = bootAssignments();

  assert.match(assignments, /window\.__FFB_VERSION="0\.2\.0";/);
  assert.match(assignments, /window\.__FFB_LATEST="0\.2\.1";/);
  assert.match(assignments, /window\.__FFB_OUTDATED=true;/);
  assert.doesNotMatch(assignments, /window\.__FFB_isNewer|function/);
});
