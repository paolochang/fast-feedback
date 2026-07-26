import { get } from "node:https";
import { isNewer, extractLatestVersion } from "./version.mjs";

const MARKETPLACE_URL = "https://raw.githubusercontent.com/paolochang/fast-feedback/main/.claude-plugin/marketplace.json";

let cachedLatest = null;
let started = null;

export function parseMarketplace(text) {
  try {
    return extractLatestVersion(JSON.parse(text));
  } catch {
    return null;
  }
}

export function versionInfo(current, latest) {
  return {
    current: current ?? null,
    latest: latest ?? null,
    outdated: typeof current === "string" && typeof latest === "string"
      ? isNewer(latest, current)
      : false,
  };
}

export function currentLatest() {
  return cachedLatest;
}

function fetchMarketplace() {
  return new Promise((resolve, reject) => {
    const request = get(MARKETPLACE_URL, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`Unexpected status: ${response.statusCode}`));
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve(body));
      response.on("error", reject);
    });

    request.setTimeout(3000, () => request.destroy(new Error("Version check timed out")));
    request.on("error", reject);
  });
}

export function ensureVersionChecked({ fetchImpl } = {}) {
  if (started) return started;

  started = Promise.resolve().then(async () => {
    try {
      const body = fetchImpl ? await fetchImpl() : await fetchMarketplace();
      cachedLatest = parseMarketplace(body);
    } catch {
      cachedLatest = null;
    }
  });

  return started;
}
