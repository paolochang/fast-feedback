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
import { isLoopbackHost } from "./proxy-guards.mjs";
import { FFB_SEND_TOKEN, STRIP, handleFfbRoute, injectBoot, renderBoot } from "./serve-core.mjs";

export { FFB_SEND_TOKEN };

const argv = process.argv.slice(2);
function opt(name, def) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; }

const target = opt("--target", argv.find(function (a) { return /^https?:\/\//.test(a); }));
if (!target) {
  console.error("Usage: node serve-proxy.mjs --target http://localhost:3000 [--port 5000]");
  process.exit(1);
}
const targetUrl = new URL(target);
if (!argv.includes("--allow-remote") && !isLoopbackHost(targetUrl.hostname)) {
  console.error("Refusing non-loopback --target; pass --allow-remote only for a target you trust.");
  process.exit(1);
}
if (targetUrl.protocol !== "http:") {
  console.error("Only http:// dev servers are supported for now (an https dev server would need a local cert).\n" +
    "Most dev servers run on http://localhost — start yours on http, or run it without HTTPS for the review.");
  process.exit(1);
}
const PORT = parseInt(opt("--port", "5000"), 10);
const THOST = targetUrl.hostname;
const TPORT = targetUrl.port || "80";

const server = http.createServer(function (creq, cres) {
  if (handleFfbRoute(creq, cres, { port: PORT })) return;

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
        const boot = renderBoot({ fileLabel: targetUrl.host });
        body = injectBoot(body, boot);
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

server.listen(PORT, "127.0.0.1", function () {
  console.log("fast-feedback proxy running:");
  console.log("  http://localhost:" + PORT + "  →  " + target);
  console.log("");
  console.log("Open http://localhost:" + PORT + " in your browser (instead of " + target + ").");
  console.log("The feedback bar is injected automatically. Ctrl+. shows / hides it.");
  console.log("Your dev server keeps running untouched — no restart, no code change.");
  console.log("Overlay hot-read is on: edits to the skill apply on a plain browser reload.");
});
