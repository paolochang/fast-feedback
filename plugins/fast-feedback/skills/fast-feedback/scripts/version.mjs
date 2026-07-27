// Report whether `latest` is strictly newer than `current`. Only strict 3-part
// numeric versions (X.Y.Z) are compared; anything else — including semver
// prereleases like "0.3.0-rc.1" — returns false. This is intentional and
// fail-safe: fast-feedback publishes only 3-part versions (see README's release
// bump), and the badge is advisory, so an unrecognized version shows no badge
// rather than a possibly-wrong "update available".
export function isNewer(latest, current) {
  if (
    typeof latest !== "string" ||
    typeof current !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(latest) ||
    !/^\d+\.\d+\.\d+$/.test(current)
  ) {
    return false;
  }

  const latestSegments = latest.split(".").map(Number);
  const currentSegments = current.split(".").map(Number);

  for (let index = 0; index < latestSegments.length; index += 1) {
    if (latestSegments[index] !== currentSegments[index]) {
      return latestSegments[index] > currentSegments[index];
    }
  }

  return false;
}

export function extractLatestVersion(marketplaceJson) {
  if (
    marketplaceJson === null ||
    typeof marketplaceJson !== "object" ||
    !Array.isArray(marketplaceJson.plugins)
  ) {
    return null;
  }

  const plugin = marketplaceJson.plugins.find(
    (entry) => entry !== null && typeof entry === "object" && entry.name === "fast-feedback",
  );

  return typeof plugin?.version === "string" ? plugin.version : null;
}
