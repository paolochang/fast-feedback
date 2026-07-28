import { get } from "node:https";
import { isNewer, extractLatestVersion } from "./version.mjs";

const MARKETPLACE_URL = "https://raw.githubusercontent.com/paolochang/fast-feedback/main/.claude-plugin/marketplace.json";
const MAX_BODY = 256 * 1024;

let cachedLatest = null;
let started = null;

export function parseMarketplace(text) {
  try {
    const latest = extractLatestVersion(JSON.parse(text));
    // Same strict-X.Y.Z contract as isNewer (fast-feedback ships only 3-part
    // versions); this also keeps a non-conforming value out of the inline boot
    // <script> it is injected into.
    return typeof latest === "string" && /^\d+\.\d+\.\d+$/.test(latest) ? latest : null;
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
    const request = get(MARKETPLACE_URL, { signal: AbortSignal.timeout(3000) }, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`Unexpected status: ${response.statusCode}`));
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        if (body.length + chunk.length > MAX_BODY) {
          request.destroy(new Error("Marketplace response too large"));
          return;
        }
        body += chunk;
      });
      response.on("end", () => resolve(body));
      response.on("error", reject);
    });

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
