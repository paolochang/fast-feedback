// LIVE MODE (proxy) — wrap a RUNNING dev server (Vite / Next / Angular / CRA,
// i.e. a React/Vue/Angular/Next app in development) so the feedback overlay
// shows up with NO console paste, NO bookmarklet, NO browser extension, and
// WITHOUT restarting or editing the dev server.
//
// How it dodges the iframe problem: an iframe around a cross-origin dev server
// can't be read from the parent (Same-Origin Policy — and that is NOT something
// CORS headers can relax), and many pages refuse to be framed at all. So instead
// of wrapping in the BROWSER, we wrap on the SERVER: this proxy fetches the dev
// server's HTML in Node (no browser SOP involved), injects the overlay into it,
// and serves it from its own origin. The overlay then runs SAME-ORIGIN with the
// app — full DOM access, exactly what the element auto-capture needs.
//
// The proxy sits in FRONT of the whole dev server, so whatever internal proxying
// the app already does (Vite server.proxy, Next rewrites, Angular proxy.conf)
// keeps working untouched — we only need to point at the dev server's front door.
//
// Usage:
//   node serve-proxy.mjs --target http://localhost:3000 [--port 5000]
//   node serve-proxy.mjs http://localhost:3000            (shorthand for --target)
//
// Then open http://localhost:<port>. Ctrl+.  shows/hides the overlay.

import http from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootAssignments, applyUpdate, saveScreenshot } from "./settings.mjs";

const argv = process.argv.slice(2);
function opt(name, def) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; }

const target = opt("--target", argv.find(function (a) { return /^https?:\/\//.test(a); }));
if (!target) {
  console.error("Usage: node serve-proxy.mjs --target http://localhost:3000 [--port 5000]");
  process.exit(1);
}
const targetUrl = new URL(target);
if (targetUrl.protocol !== "http:") {
  console.error("Only http:// dev servers are supported for now (an https dev server would need a local cert).\n" +
    "Most dev servers run on http://localhost — start yours on http, or run it without HTTPS for the review.");
  process.exit(1);
}
const PORT = parseInt(opt("--port", "5000"), 10);
const THOST = targetUrl.hostname;
const TPORT = targetUrl.port || "80";

// Build the overlay bundle exactly like the other modes: vendored html2canvas
// (MIT) inlined ahead of the engine so Screenshot works offline, then the engine.
const here = dirname(fileURLToPath(import.meta.url));
// html2canvas is a vendored, never-changing dependency — read it once. overlay.js
// is OUR engine, which we iterate on, so re-read it from disk on every HTML
// response (hot-read): edit the skill, just reload the browser, no proxy restart.
const h2c = readFileSync(join(here, "..", "assets", "html2canvas.min.js"), "utf8");
const overlayPath = join(here, "..", "assets", "overlay.js");
function buildEngine() {
  const overlay = readFileSync(overlayPath, "utf8");
  // If the bundle ever contains "</script", the HTML parser would close our tag
  // early — break the sequence (harmless inside JS).
  return (h2c + "\n" + overlay).replace(/<\/script/gi, "<\\/script");
}
// window.__FFB_SAVE lets the overlay persist changes to disk (this route below),
// so global hotkeys + this project's theme/highlight survive to the next trigger.
const saveFn = "window.__FFB_SAVE=function(p){try{fetch('/__ffb__/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)});}catch(e){}};";
// window.__FFB_SAVE_SHOT posts a captured PNG blob to the route below so the
// server writes it to the configured folder (the browser can't write a path
// itself). Resolves to the saved absolute path so the overlay can show it.
const saveShotFn = "window.__FFB_SAVE_SHOT=function(blob){return fetch('/__ffb__/screenshot',{method:'POST',headers:{'content-type':'image/png'},body:blob}).then(function(r){return r.json();}).then(function(j){return j&&j.path;});};";
// Rebuilt per HTML response so a fresh reload reflects the latest saved settings.
function bootScript() {
  return "\n<script>window.__FFB_FILE=" + JSON.stringify(targetUrl.host) + ";" + bootAssignments() + saveFn + saveShotFn + "</script>\n" +
    "<script>\n" + buildEngine() + "\n</script>\n";
}

// Headers that would stop the overlay from running / the page from rendering in
// our origin. We're serving content we're authorized to view (your own dev
// server), so stripping them here is fine.
const STRIP = new Set(["x-frame-options", "content-security-policy", "content-security-policy-report-only"]);

const server = http.createServer(function (creq, cres) {
  // Settings write-back from the overlay — persist to the on-disk file and don't
  // forward it to the dev server. Global hotkeys / this project's theme.
  if (creq.method === "POST" && creq.url === "/__ffb__/settings") {
    let body = "";
    creq.on("data", function (c) { body += c; });
    creq.on("end", function () {
      try { applyUpdate(JSON.parse(body || "{}")); } catch (e) {}
      cres.writeHead(204); cres.end();
    });
    return;
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
    return;
  }

  // Forward to the dev server. Rewrite Host so vhost-based dev servers answer,
  // and force identity encoding so HTML comes back uncompressed (we inject into
  // it as text — no need to gunzip).
  const headers = Object.assign({}, creq.headers, { host: targetUrl.host, "accept-encoding": "identity" });
  const preq = http.request({ host: THOST, port: TPORT, method: creq.method, path: creq.url, headers }, function (pres) {
    const ct = String(pres.headers["content-type"] || "");
    const outHeaders = {};
    for (const k in pres.headers) if (!STRIP.has(k.toLowerCase())) outHeaders[k] = pres.headers[k];

    if (ct.indexOf("text/html") !== -1) {
      // Buffer HTML so we can inject the overlay, then re-set content-length.
      const chunks = [];
      pres.on("data", function (c) { chunks.push(c); });
      pres.on("end", function () {
        let body = Buffer.concat(chunks).toString("utf8");
        const lower = body.toLowerCase();
        const idx = lower.lastIndexOf("</body>");
        const boot = bootScript();
        body = idx !== -1 ? body.slice(0, idx) + boot + body.slice(idx) : body + boot;
        const buf = Buffer.from(body, "utf8");
        // We've buffered the whole body and are sending it with an explicit
        // Content-Length, so any upstream Transfer-Encoding (dev servers like
        // Next often send HTML chunked) must go — Content-Length together with
        // Transfer-Encoding is an invalid response the browser rejects.
        delete outHeaders["transfer-encoding"];
        delete outHeaders["content-length"];
        outHeaders["content-length"] = Buffer.byteLength(buf);
        cres.writeHead(pres.statusCode, outHeaders);
        cres.end(buf);
      });
    } else {
      // Everything else (JS/CSS/images/API/JSON) streams straight through.
      cres.writeHead(pres.statusCode, outHeaders);
      pres.pipe(cres);
    }
  });
  preq.on("error", function (e) { cres.writeHead(502); cres.end("fast-feedback proxy: upstream error — " + e.message); });
  creq.pipe(preq);
});

// WebSocket / HMR passthrough — without this, save-and-reload (hot reload) in
// the dev server would stop working when viewed through the proxy. We forward
// the raw upgrade handshake to the dev server and pipe the two sockets together.
server.on("upgrade", function (creq, csocket, head) {
  const psocket = net.connect(TPORT, THOST, function () {
    const headers = Object.assign({}, creq.headers, { host: targetUrl.host });
    let raw = creq.method + " " + creq.url + " HTTP/1.1\r\n";
    for (const k in headers) raw += k + ": " + headers[k] + "\r\n";
    raw += "\r\n";
    psocket.write(raw);
    if (head && head.length) psocket.write(head);
    psocket.pipe(csocket);
    csocket.pipe(psocket);
  });
  psocket.on("error", function () { csocket.destroy(); });
  csocket.on("error", function () { psocket.destroy(); });
});

server.listen(PORT, function () {
  console.log("fast-feedback proxy running:");
  console.log("  http://localhost:" + PORT + "  →  " + target);
  console.log("");
  console.log("Open http://localhost:" + PORT + " in your browser (instead of " + target + ").");
  console.log("The feedback bar is injected automatically. Ctrl+. shows / hides it.");
  console.log("Your dev server keeps running untouched — no restart, no code change.");
  console.log("Overlay hot-read is on: edits to the skill apply on a plain browser reload.");
});
