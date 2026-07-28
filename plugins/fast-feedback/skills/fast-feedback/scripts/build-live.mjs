// LIVE MODE — overlay the feedback engine onto a RUNNING front-end (a dev
// server: React, Vue, Next, plain HTML served over http, etc.). There is no
// static file to copy, so instead this emits the engine in two paste-ready
// forms that run INSIDE the app's own page (same origin — which is why the
// component auto-capture works here but not through a cross-origin iframe):
//
//   1) a console snippet  — paste into DevTools Console and hit Enter
//   2) a bookmarklet       — save as a bookmark, click it on the app tab
//
// Both are written to files next to the cwd (or an output dir you pass) so the
// user can copy the whole thing without terminal wrapping mangling it.
//
// Usage:
//   node build-live.mjs [output-dir]     (default: current directory)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { bootAssignments, ensureVersionChecked } from "./settings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// Inline the vendored html2canvas (MIT) AHEAD of the engine so the Screenshot
// button works offline — window.html2canvas is defined before overlay.js runs.
// This makes the console snippet large (~210KB); it pastes fine. The bookmarklet
// is likewise large and may exceed some browsers' URL cap — prefer the console.
// Between them, seed saved settings (global hotkeys + this project's theme).
// Console mode has no server, so there's no write-back — changes persist via
// localStorage only.
const h2c = readFileSync(join(here, "..", "assets", "html2canvas.min.js"), "utf8");
await ensureVersionChecked();
const boot = bootAssignments();
const engine = h2c + "\n" + boot + "\n" + readFileSync(join(here, "..", "assets", "overlay.js"), "utf8");

const outDir = resolve(process.argv[2] || process.cwd());
const snippetPath = join(outDir, "fast-feedback.snippet.js");
const bookmarkletPath = join(outDir, "fast-feedback.bookmarklet.txt");

// Console snippet: the engine as-is (already an IIFE). Safe to paste twice —
// the engine no-ops the second run and just re-shows the bar.
writeFileSync(snippetPath, engine);

// Bookmarklet: same engine URL-encoded behind a javascript: scheme.
const bookmarklet = "javascript:" + encodeURIComponent(engine);
writeFileSync(bookmarkletPath, bookmarklet);

// Auto-copy the console snippet to the clipboard so the user can go straight
// to the running app's DevTools console and paste — no file-opening needed.
const copied = process.env.FFB_NO_OPEN ? false : copyToClipboard(engine);

console.log(`Wrote:
  ${snippetPath}       (console snippet)
  ${bookmarkletPath}  (bookmarklet)
${copied ? "\n✓ The console snippet is now on your CLIPBOARD.\n" : ""}
LIVE MODE — how the user applies it to a running app (can't auto-open the app
itself — it's already running in the user's browser):
  A) Console (recommended)${copied ? " — snippet already copied" : ""}:
     open the app tab → F12 → Console → ${copied ? "paste (Ctrl+V)" : "paste the contents of fast-feedback.snippet.js"} → Enter.
  B) Bookmarklet: open fast-feedback.bookmarklet.txt, copy the whole line,
     make a new bookmark, paste it as the URL, click it on the app tab. (If the
     app has a strict CSP that blocks it, use the console.)

Then: click "Write" (Ctrl+/), drag a box, write + Submit, "Copy All" (Ctrl+') → paste back here.
Toggle "Write" off to interact with / navigate the app, then back on.`);

function copyToClipboard(text) {
  const plat = process.platform;
  const [cmd, args] =
    plat === "win32" ? ["clip", []] :
    plat === "darwin" ? ["pbcopy", []] :
    ["xclip", ["-selection", "clipboard"]];
  try {
    const p = spawn(cmd, args);
    p.stdin.write(text); p.stdin.end();
    return true;
  } catch { return false; }
}
