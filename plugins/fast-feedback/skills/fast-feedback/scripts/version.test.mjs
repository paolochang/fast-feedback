import assert from "node:assert/strict";
import test from "node:test";

import { extractLatestVersion, isNewer } from "./version.mjs";

test("isNewer compares valid three-segment numeric versions", () => {
  assert.equal(isNewer("0.2.0", "0.2.0"), false);
  assert.equal(isNewer("0.3.0", "0.2.0"), true);
  assert.equal(isNewer("0.2.0", "0.3.0"), false);
  assert.equal(isNewer("0.2.1", "0.2.0"), true);
});

test("isNewer treats malformed, missing, non-string, and differently-sized versions as current", () => {
  for (const [latest, current] of [
    ["0.3", "0.2.0"],
    ["0.3.0.1", "0.2.0"],
    ["0.3.0", "0.2"],
    ["latest", "0.2.0"],
    ["0.3.0", "current"],
    ["", "0.2.0"],
    [undefined, "0.2.0"],
    ["0.3.0", null],
    [3, "0.2.0"],
    ["0.3.0", {}],
  ]) {
    assert.equal(isNewer(latest, current), false);
  }
});

test("isNewer source is a self-contained function declaration", () => {
  const source = isNewer.toString();
  const isolatedIsNewer = eval(`(${source})`);

  assert.match(source, /function/);
  for (const [latest, current] of [
    ["0.2.0", "0.2.0"],
    ["0.3.0", "0.2.0"],
    ["0.2.0", "0.3.0"],
    ["invalid", "0.2.0"],
  ]) {
    assert.equal(isolatedIsNewer(latest, current), isNewer(latest, current));
  }
});

test("extractLatestVersion returns the matching plugin version", () => {
  assert.equal(
    extractLatestVersion({
      metadata: { version: "9.9.9" },
      plugins: [
        { name: "other-plugin", version: "1.0.0" },
        { name: "fast-feedback", version: "0.3.0" },
      ],
    }),
    "0.3.0",
  );
});

test("extractLatestVersion returns null without a valid matching plugin version", () => {
  const cases = [
    { metadata: { version: "9.9.9" }, plugins: [{ name: "other-plugin", version: "1.0.0" }] },
    { metadata: { version: "9.9.9" } },
    { metadata: { version: "9.9.9" }, plugins: {} },
    { plugins: [null] },
    { plugins: [{ name: "fast-feedback" }] },
    { plugins: [{ name: "fast-feedback", version: 3 }] },
    null,
    "not an object",
  ];

  for (const marketplaceJson of cases) {
    assert.equal(extractLatestVersion(marketplaceJson), null);
  }
});
