import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { bootAssignments, ensureVersionChecked } from "./settings.mjs";

const pluginJson = JSON.parse(readFileSync(
  fileURLToPath(new URL("../../../.claude-plugin/plugin.json", import.meta.url)),
  "utf8",
));
const currentVersion = pluginJson.version;

const check = ensureVersionChecked({
  fetchImpl: async () => JSON.stringify({
    plugins: [{ name: "fast-feedback", version: "999.0.0" }],
  }),
});

test("bootAssignments injects plain version values after the version check", async () => {
  await check;
  const assignments = bootAssignments();

  assert.ok(assignments.includes(`window.__FFB_VERSION="${currentVersion}";`));
  assert.match(assignments, /window\.__FFB_LATEST="999\.0\.0";/);
  assert.match(assignments, /window\.__FFB_OUTDATED=true;/);
  assert.doesNotMatch(assignments, /window\.__FFB_isNewer|function/);
});
