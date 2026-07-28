// FILE MODE — serve one static HTML mockup with the feedback overlay injected.
// Usage: node serve-static.mjs <path> [--port 5000]

import http from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { handleFfbRoute, injectBoot, renderBoot } from "./serve-core.mjs";
import { inboxPath, writeSession } from "./inbox.mjs";
import { ensureVersionChecked } from "./update-check.mjs";

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../../.claude-plugin/plugin.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

const argv = process.argv.slice(2);
const portIndex = argv.indexOf("--port");
const input = argv.find((arg, index) => (portIndex < 0 || (index !== portIndex && index !== portIndex + 1)) && !arg.startsWith("-"));
const PORT = Number(portIndex >= 0 ? argv[portIndex + 1] : "5000");

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("Port must be an integer between 1 and 65535");
  process.exit(1);
}

if (!input) {
  console.error("Usage: node serve-static.mjs <path> [--port 5000]");
  process.exit(1);
}

const documentPath = resolve(input);
let inputStats;
try {
  inputStats = statSync(documentPath);
} catch (error) {
  if (error?.code === "ENOENT") {
    console.error("Input file does not exist: " + documentPath);
    process.exit(1);
  }
  throw error;
}
if (!inputStats.isFile()) {
  console.error("Input must be a file: " + documentPath);
  process.exit(1);
}

const root = dirname(documentPath);
const rootBoundary = root.endsWith(sep) ? root : root + sep;
const documentName = basename(documentPath);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".map": "application/json; charset=utf-8",
};

function ensureCharset(html) {
  if (/<meta[^>]+charset/i.test(html)) return html;
  const meta = '<meta charset="utf-8">';
  let match = html.match(/<head[^>]*>/i);
  if (match) return html.slice(0, match.index + match[0].length) + "\n" + meta + html.slice(match.index + match[0].length);
  match = html.match(/<html[^>]*>/i);
  if (match) return html.slice(0, match.index + match[0].length) + "\n<head>" + meta + "</head>" + html.slice(match.index + match[0].length);
  return meta + "\n" + html;
}

function renderHtml(path) {
  const source = readFileSync(path, "utf8");
  // Label each injected page by the file actually being served, not the CLI
  // input — a mockup that links to a sibling .html gets feedback attributed to
  // that page, so the agent edits the right file.
  const boot = renderBoot({ fileLabel: basename(path) });
  if (/<\/body\s*>/i.test(source)) return injectBoot(ensureCharset(source), boot);
  return "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n</head>\n<body>\n" + source + "\n" + boot + "\n</body>\n</html>\n";
}

function openInBrowser(url) {
  const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] :
    process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

const server = http.createServer((creq, cres) => {
  if (handleFfbRoute(creq, cres, { port: server.address().port, mode: "static" })) return;

  const requestPath = (creq.url || "/").split("?", 1)[0];
  let urlPath;
  try {
    urlPath = decodeURIComponent(requestPath);
  } catch {
    cres.writeHead(400);
    cres.end("Bad Request");
    return;
  }
  if (urlPath.includes("\0")) {
    cres.writeHead(400);
    cres.end("Bad Request");
    return;
  }

  const path = resolve(join(root, urlPath === "/" ? documentName : urlPath));
  if (path !== root && !path.startsWith(rootBoundary)) {
    cres.writeHead(403);
    cres.end("Forbidden");
    return;
  }

  if (path === documentPath || [".html", ".htm"].includes(extname(path).toLowerCase())) {
    try {
      const html = renderHtml(path);
      cres.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html, "utf8"),
        "cache-control": "no-store",
      });
      cres.end(html);
    } catch (error) {
      cres.writeHead(error?.code === "ENOENT" ? 404 : 500);
      cres.end(error?.code === "ENOENT" ? "Not Found" : "Could not read file");
    }
    return;
  }

  const stream = createReadStream(path);
  stream.once("open", () => {
    cres.writeHead(200, { "content-type": contentTypes[extname(path).toLowerCase()] || "application/octet-stream" });
    stream.pipe(cres);
  });
  stream.once("error", (error) => {
    if (cres.headersSent) {
      cres.destroy(error);
      return;
    }
    cres.writeHead(error?.code === "ENOENT" ? 404 : 500);
    cres.end(error?.code === "ENOENT" ? "Not Found" : "Could not read file");
  });
});

// Run the version check before opening the port (bounded to ~3s by the
// wall-clock timeout, fail-silent) so no request — including a stale browser
// tab from a prior run — can be served before the badge state is resolved.
await ensureVersionChecked();
server.listen(PORT, "127.0.0.1", async () => {
  const url = "http://127.0.0.1:" + server.address().port;
  await writeSession({ mode: "static", version: PLUGIN_VERSION, url, started_at: new Date().toISOString() }).catch(() => {});
  // Open/advertise the document by its filename, not "/", so location.href
  // carries the name. overlay.js serializes location.href into each Send item,
  // so this is what lets the receiving agent attribute file-mode feedback to
  // the source file (the "/" default document still serves it too).
  const pageUrl = url + "/" + encodeURIComponent(documentName);
  console.log("fast-feedback static server running:");
  console.log("  " + pageUrl + "  →  " + documentPath);
  console.log("  inbox: " + inboxPath());
  console.log("  settings project/cwd: " + (process.env.FFB_PROJECT || process.cwd()));
  console.log("Open " + pageUrl + " in your browser. Ctrl+. toggles · overlay hot-read on.");
  if (!process.env.FFB_NO_OPEN) openInBrowser(pageUrl);
});
