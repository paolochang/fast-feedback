import test from "node:test";
import assert from "node:assert/strict";

import * as successfulCheck from "./update-check.mjs?successful-test";
import * as failedCheck from "./update-check.mjs?failed-test";

const marketplace = JSON.stringify({
  plugins: [{ name: "fast-feedback", version: "0.2.1" }],
});

const successfulFetch = successfulCheck.ensureVersionChecked({
  fetchImpl: async () => marketplace,
});
const failedFetch = failedCheck.ensureVersionChecked({
  fetchImpl: async () => { throw new Error("offline"); },
});

test("parseMarketplace returns the fast-feedback version from valid marketplace JSON", () => {
  assert.equal(successfulCheck.parseMarketplace(marketplace), "0.2.1");
});

test("parseMarketplace returns null for malformed JSON", () => {
  assert.equal(successfulCheck.parseMarketplace("not json"), null);
});

test("parseMarketplace returns null when fast-feedback is absent", () => {
  assert.equal(successfulCheck.parseMarketplace(JSON.stringify({ plugins: [] })), null);
});

test("parseMarketplace rejects non-semver fast-feedback versions", () => {
  for (const version of ["1.0.0</script>", "latest", "1.2"]) {
    assert.equal(successfulCheck.parseMarketplace(JSON.stringify({
      plugins: [{ name: "fast-feedback", version }],
    })), null);
  }
});

test("versionInfo reports whether the latest version is newer", () => {
  assert.deepEqual(successfulCheck.versionInfo("0.2.0", "0.2.1"), {
    current: "0.2.0",
    latest: "0.2.1",
    outdated: true,
  });
  assert.deepEqual(successfulCheck.versionInfo("0.2.1", "0.2.1"), {
    current: "0.2.1",
    latest: "0.2.1",
    outdated: false,
  });
  assert.deepEqual(successfulCheck.versionInfo(null, "0.2.1"), {
    current: null,
    latest: "0.2.1",
    outdated: false,
  });
});

test("ensureVersionChecked caches the injected marketplace version", async () => {
  await successfulFetch;
  assert.equal(successfulCheck.currentLatest(), "0.2.1");
  assert.strictEqual(
    successfulCheck.ensureVersionChecked({ fetchImpl: async () => "different" }),
    successfulFetch,
  );
});

test("ensureVersionChecked resolves after a failed injected fetch without caching a version", async () => {
  await failedFetch;
  assert.equal(failedCheck.currentLatest(), null);
});
