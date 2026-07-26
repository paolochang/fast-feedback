import { randomBytes } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootAssignments, applyUpdate, saveScreenshot } from "./settings.mjs";
import * as inbox from "./inbox.mjs";
import * as history from "./history.mjs";
import { isOwnProxyOrigin } from "./proxy-guards.mjs";

const MAX_SEND_BODY_BYTES = 256 * 1024;
const MAX_HISTORY_BODY_BYTES = 12 * 1024 * 1024;

// Minted once per server process and never logged; the injected boot script
// embeds it and every /__ffb__ POST is checked against it.
export const FFB_SEND_TOKEN = randomBytes(24).toString("hex");

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function historySummary(meta) {
  const items = Array.isArray(meta.items) ? meta.items : [];
  const preview = items.find((item) => typeof item?.comment === "string" && item.comment.trim())?.comment.trim().slice(0, 160) || "";
  return { id: meta.id, ts: meta.ts, url: meta.url, count: items.length, preview };
}

async function markedHistoryBatch(id) {
  return (await history.listBatches()).find((batch) => batch.id.toLowerCase() === id.toLowerCase());
}

function historyPngPath(id) {
  const inboxDir = process.env.FFB_INBOX ? resolve(process.env.FFB_INBOX) : join(process.cwd(), ".ffb");
  return join(inboxDir, "history", id + ".png");
}

function parseHistoryBody(body) {
  const newline = body.indexOf(0x0a);
  if (newline < 1) throw new TypeError("invalid history framing");
  const lengthText = body.subarray(0, newline).toString("ascii");
  if (!/^\d+$/.test(lengthText)) throw new TypeError("invalid history framing");
  const jsonLength = Number(lengthText);
  const jsonStart = newline + 1;
  const jsonEnd = jsonStart + jsonLength;
  if (!Number.isSafeInteger(jsonLength) || jsonEnd > body.length) throw new TypeError("invalid history framing");
  let meta;
  try {
    meta = JSON.parse(body.subarray(jsonStart, jsonEnd).toString("utf8"));
  } catch {
    throw new TypeError("invalid history metadata");
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new TypeError("invalid history metadata");
  return { meta, png: body.subarray(jsonEnd) };
}

const here = dirname(fileURLToPath(import.meta.url));
const h2c = readFileSync(join(here, "..", "assets", "html2canvas.min.js"), "utf8");
const overlayPath = join(here, "..", "assets", "overlay.js");
const saveFn = "window.__FFB_SAVE=function(p){try{fetch('/__ffb__/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)});}catch(e){}};";
const saveShotFn = "window.__FFB_SAVE_SHOT=function(blob){return fetch('/__ffb__/screenshot',{method:'POST',headers:{'content-type':'image/png'},body:blob}).then(function(r){return r.json();}).then(function(j){return j&&j.path;});};";
const sendFn = "window.__FFB_SEND=function(items){return fetch('/__ffb__/send',{method:'POST',headers:{'content-type':'application/json','x-ffb-token':" + JSON.stringify(FFB_SEND_TOKEN) + "},body:JSON.stringify(items)}).then(function(r){if(!r.ok)throw new Error('Send failed: '+r.status);return r;});};";
const archiveFn = "window.__FFB_ARCHIVE=function(body){return fetch('/__ffb__/history',{method:'POST',headers:{'content-type':'application/x-ffb-history','x-ffb-token':" + JSON.stringify(FFB_SEND_TOKEN) + "},body:body}).then(function(r){if(!r.ok)throw new Error('Archive failed: '+r.status);return r;});};";
const historyReadFns = "window.__FFB_HISTORY_LIST=function(){return fetch('/__ffb__/history',{headers:{'x-ffb-token':" + JSON.stringify(FFB_SEND_TOKEN) + "}}).then(function(r){if(!r.ok)throw new Error('History request failed: '+r.status);return r.json();});};" +
  "window.__FFB_HISTORY_META=function(id){return fetch('/__ffb__/history/'+id+'.json',{headers:{'x-ffb-token':" + JSON.stringify(FFB_SEND_TOKEN) + "}}).then(function(r){if(!r.ok)throw new Error('History request failed: '+r.status);return r.json();});};" +
  "window.__FFB_HISTORY_BLOB=function(id){return fetch('/__ffb__/history/'+id+'.png',{headers:{'x-ffb-token':" + JSON.stringify(FFB_SEND_TOKEN) + "}}).then(function(r){if(!r.ok)throw new Error('History request failed: '+r.status);return r.blob();});};";

export function renderBoot({ fileLabel }) {
  const overlay = readFileSync(overlayPath, "utf8");
  const engine = (h2c + "\n" + overlay).replace(/<\/script/gi, "<\\/script");
  return "\n<script>window.__FFB_FILE=" + JSON.stringify(fileLabel) + ";" + bootAssignments() + saveFn + saveShotFn + sendFn + archiveFn + historyReadFns + "</script>\n" +
    "<script>\n" + engine + "\n</script>\n";
}

export function injectBoot(html, boot) {
  const idx = html.toLowerCase().lastIndexOf("</body>");
  return idx !== -1 ? html.slice(0, idx) + boot + html.slice(idx) : html + boot;
}

// Headers that would stop the overlay from running / the page from rendering in
// our origin. We're serving content we're authorized to view (your own dev
// server), so stripping them here is fine.
export const STRIP = new Set(["x-frame-options", "content-security-policy", "content-security-policy-report-only"]);

export function handleFfbRoute(creq, cres, { port }) {
  // History reads stay on the loopback-only proxy. The ID is validated before
  // it can become part of a file path, and listBatches limits visibility to
  // completion-marker-backed batches.
  if (creq.method === "GET" && creq.url.startsWith("/__ffb__/history")) {
    if (creq.headers["x-ffb-token"] !== FFB_SEND_TOKEN) {
      sendJson(cres, 403, { error: "forbidden" });
      return true;
    }
    if (creq.url === "/__ffb__/history") {
      history.listBatches().then((batches) => {
        sendJson(cres, 200, batches.map(historySummary));
      }).catch(() => {
        sendJson(cres, 500, { error: "could not read history" });
      });
      return true;
    }

    const match = creq.url.match(/^\/__ffb__\/history\/([^/]+)\.(json|png)$/);
    if (!match || !history.isUuid(match[1])) {
      sendJson(cres, 400, { error: "batch id must be a UUID" });
      return true;
    }
    const [, id, extension] = match;
    markedHistoryBatch(id).then((batch) => {
      if (!batch) {
        sendJson(cres, 404, { error: "history batch not found" });
        return;
      }
      if (extension === "json") {
        sendJson(cres, 200, batch);
        return;
      }
      const stream = createReadStream(historyPngPath(id));
      stream.once("open", () => {
        cres.writeHead(200, { "content-type": "image/png" });
        stream.pipe(cres);
      });
      stream.once("error", (error) => {
        if (cres.headersSent) {
          cres.destroy(error);
          return;
        }
        sendJson(cres, error?.code === "ENOENT" ? 404 : 500, { error: error?.code === "ENOENT" ? "history batch not found" : "could not read history" });
      });
    }).catch(() => {
      sendJson(cres, 500, { error: "could not read history" });
    });
    return true;
  }

  // Feedback submissions stay on the loopback-only proxy. Check all request
  // guards before buffering/parsing a body, and never forward this route.
  if (creq.method === "POST" && creq.url === "/__ffb__/send") {
    if (creq.headers["x-ffb-token"] !== FFB_SEND_TOKEN || !isOwnProxyOrigin(creq.headers, port)) {
      sendJson(cres, 403, { error: "forbidden" });
      return true;
    }
    if (String(creq.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      sendJson(cres, 415, { error: "content-type must be application/json" });
      return true;
    }
    if (Number(creq.headers["content-length"] || 0) > MAX_SEND_BODY_BYTES) {
      sendJson(cres, 413, { error: "request body too large" });
      return true;
    }

    let size = 0;
    let tooLarge = false;
    const chunks = [];
    creq.on("data", function (chunk) {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_SEND_BODY_BYTES) {
        tooLarge = true;
        sendJson(cres, 413, { error: "request body too large" });
        return;
      }
      chunks.push(chunk);
    });
    creq.on("end", async function () {
      if (tooLarge) return;
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (error) {
        sendJson(cres, 400, { error: "invalid JSON" });
        return;
      }
      const items = Array.isArray(parsed) ? parsed : parsed && parsed.items;
      if (!Array.isArray(items)) {
        sendJson(cres, 400, { error: "items must be an array" });
        return;
      }
      try {
        await inbox.appendItems(items);
        sendJson(cres, 200, { ok: true, count: await inbox.count() });
      } catch (error) {
        sendJson(cres, 500, { error: "could not store feedback" });
      }
    });
    return true;
  }

  // History uploads use a length-prefixed metadata frame followed by raw PNG.
  // This stays on the loopback-only proxy and is never forwarded upstream.
  if (creq.method === "POST" && creq.url === "/__ffb__/history") {
    if (creq.headers["x-ffb-token"] !== FFB_SEND_TOKEN || !isOwnProxyOrigin(creq.headers, port)) {
      sendJson(cres, 403, { error: "forbidden" });
      return true;
    }
    const contentType = String(creq.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/x-ffb-history" && contentType !== "application/octet-stream") {
      sendJson(cres, 415, { error: "content-type must be application/x-ffb-history" });
      return true;
    }
    if (Number(creq.headers["content-length"] || 0) > MAX_HISTORY_BODY_BYTES) {
      sendJson(cres, 413, { error: "request body too large" });
      return true;
    }

    let size = 0;
    let tooLarge = false;
    const chunks = [];
    creq.on("data", function (chunk) {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_HISTORY_BODY_BYTES) {
        tooLarge = true;
        sendJson(cres, 413, { error: "request body too large" });
        return;
      }
      chunks.push(chunk);
    });
    creq.on("end", async function () {
      if (tooLarge) return;
      let batch;
      try {
        batch = parseHistoryBody(Buffer.concat(chunks));
      } catch {
        sendJson(cres, 400, { error: "invalid history framing" });
        return;
      }
      if (!history.isUuid(batch.meta.id)) {
        sendJson(cres, 400, { error: "batch id must be a UUID" });
        return;
      }
      try {
        await history.writeBatch(batch.meta, batch.png);
        sendJson(cres, 200, { ok: true });
      } catch (error) {
        sendJson(cres, 500, { error: "could not store history" });
      }
    });
    return true;
  }

  // Settings write-back from the overlay — persist to the on-disk file and don't
  // forward it to the dev server. Global hotkeys / this project's theme.
  if (creq.method === "POST" && creq.url === "/__ffb__/settings") {
    let body = "";
    creq.on("data", function (c) { body += c; });
    creq.on("end", function () {
      try { applyUpdate(JSON.parse(body || "{}")); } catch (e) {}
      cres.writeHead(204); cres.end();
    });
    return true;
  }

  // Screenshot write-back — the overlay POSTs the raw PNG here and we save it to
  // the configured folder, replying with the absolute path so the toast can show
  // where it went. Not forwarded to the dev server.
  if (creq.method === "POST" && creq.url === "/__ffb__/screenshot") {
    const chunks = [];
    creq.on("data", function (c) { chunks.push(c); });
    creq.on("end", function () {
      try {
        const path = saveScreenshot(Buffer.concat(chunks));
        cres.writeHead(200, { "content-type": "application/json" });
        cres.end(JSON.stringify({ path: path }));
      } catch (e) {
        cres.writeHead(500, { "content-type": "application/json" });
        cres.end(JSON.stringify({ error: String(e && e.message || e) }));
      }
    });
    return true;
  }

  return false;
}
