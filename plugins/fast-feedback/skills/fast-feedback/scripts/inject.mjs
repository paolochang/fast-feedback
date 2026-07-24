// FILE MODE — inject the feedback overlay into a COPY of a static HTML file
// (a mockup, a prototype, an exported page). Non-destructive: the original is
// never modified. The copy is written to the SAME directory so its relative
// assets (css/images) still resolve.
//
// Usage:
//   node inject.mjs <mockup.html> [output.html]
// Default output: <input-without-ext>.review.html  (next to the original)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, basename, join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { bootAssignments } from "./settings.mjs";

const input = process.argv[2];
if (!input) {
  console.error("Usage: node inject.mjs <mockup.html> [output.html]");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
// Inline the vendored html2canvas (MIT) AHEAD of the engine so the Screenshot
// button works offline — window.html2canvas is defined before overlay.js runs.
const h2c = readFileSync(join(here, "..", "assets", "html2canvas.min.js"), "utf8");
const engine = h2c + "\n" + readFileSync(join(here, "..", "assets", "overlay.js"), "utf8");
let src = readFileSync(input, "utf8");

const ext = extname(input);
const base = basename(input, ext);
const output = process.argv[3] || join(dirname(input), `${base}.review${ext || ".html"}`);

// Guard: if the engine text ever contains the literal "</script", the HTML
// parser would close our <script> early and the rest would leak into the page.
// The standard fix is to break the sequence — harmless inside JS.
const safeEngine = engine.replace(/<\/script/gi, "<\\/script");

// Name the file for the export header, seed saved settings (global hotkeys +
// this project's theme), then run the shared engine. No write-back in file mode
// (no server) — changes there persist via localStorage only.
const injection = `\n<script>window.__FFB_FILE=${JSON.stringify(basename(input))};${bootAssignments()}</script>\n<script>\n${safeEngine}\n</script>\n`;

const hasBody = /<\/body\s*>/i.test(src);
const hasCharset = /<meta[^>]+charset/i.test(src);

let out;
if (hasBody) {
  // Full document: guarantee a UTF-8 charset (so Korean/CJK renders no matter
  // how the file is opened), then inject the overlay before the last </body>.
  if (!hasCharset) src = ensureCharset(src);
  const idx = src.toLowerCase().lastIndexOf("</body>");
  out = src.slice(0, idx) + injection + src.slice(idx);
} else {
  // Fragment (hand-written mockups often skip <html>/<head>/<body>). Injecting
  // a <script> at EOF of a fragment is unreliable — the parser can leave it
  // inert — and without a charset such files render as mojibake. Wrapping the
  // fragment in a well-formed document fixes both: a real </body> is a reliable
  // injection point, and the meta charset makes UTF-8 render correctly.
  out =
    `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n` +
    src +
    `\n${injection}\n</body>\n</html>\n`;
}

writeFileSync(output, out);
console.log(`Wrote ${output}`);

// Auto-open in the default browser so the user doesn't have to. Set
// FFB_NO_OPEN=1 to skip (e.g. in headless/CI or automated tests).
if (!process.env.FFB_NO_OPEN) {
  openInBrowser(resolve(output));
  console.log(`Opened in your default browser. Click "Write" (Ctrl+/), drag a box, write + Submit.`);
} else {
  console.log(`Open it in a browser, click "Write" (Ctrl+/), drag a box, write + Submit.`);
}

function openInBrowser(p) {
  const plat = process.platform;
  const [cmd, args] =
    plat === "win32" ? ["cmd", ["/c", "start", "", p]] :
    plat === "darwin" ? ["open", [p]] :
    ["xdg-open", [p]];
  try { spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); } catch { /* best-effort */ }
}

// Insert <meta charset="utf-8"> as early as possible: just inside <head>, else
// just after <html>, else at the very top.
function ensureCharset(html) {
  const meta = `<meta charset="utf-8">`;
  let m = html.match(/<head[^>]*>/i);
  if (m) return html.slice(0, m.index + m[0].length) + `\n${meta}` + html.slice(m.index + m[0].length);
  m = html.match(/<html[^>]*>/i);
  if (m) return html.slice(0, m.index + m[0].length) + `\n<head>${meta}</head>` + html.slice(m.index + m[0].length);
  return `${meta}\n` + html;
}
