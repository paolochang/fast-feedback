---
name: fast-feedback
description: >-
  Fast-feedback (also invoked as "ffb", "/fast-feedback", or "/ffb"): put an
  in-browser highlight-and-comment overlay on top of ANY front-end — a static
  HTML mockup/prototype OR a running dev server (React, Vue, Angular, Next, plain
  HTML) — so the user drags boxes over the exact parts they mean, types the fix
  they want, and exports structured feedback that Claude reads to make precise
  edits. Use this whenever the user says "ffb", "fast-feedback", "/ffb", or wants
  to point at specific parts of a UI and say what to change while building or
  reviewing frontend work — e.g. "let me mark up this mockup", "annotate this
  design", "I want to highlight parts of this page", "give feedback on the
  running app", "I'm running the app, let me point at what's off", "add
  annotation to this screen", or when they paste a path to a *.mockup.html / an
  app URL and want to leave feedback on specific regions. This is for feedback
  DURING implementation (mockup stage or live dev server), not final code review.
  Works on any project, any framework. Prefer this over screenshotting and
  hand-describing changes — it removes that whole round-trip.
---

# Fast Feedback

Describing UI changes in prose ("the third card is too tight, and the label
under the basket should be bigger") is slow and ambiguous — Claude has to guess
which element you mean. This skill instead drops a lightweight overlay onto the
rendered UI so the user drags a box over the exact component and types the fix
next to it. The export names the element under each box (tag / id / class / a
snippet of its text) plus a rough region, so Claude maps each note straight back
to the source.

One engine (`assets/overlay.js`), two ways to apply it depending on whether the
frontend is a file or a running server. **Pick the mode first.**

## Which mode?

- **A static HTML file** exists on disk (a `*.mockup.html`, a prototype, an
  exported page) → **file mode**. Serves the file with the overlay injected;
  the original is never touched.
- **A dev server is running** (localhost:3000, a live React/Vue/Angular/Next app,
  HMR, routing, real state) → **live mode**. There is no single file to copy, so
  the overlay is served *in front of* the app by a small proxy and runs on the
  app's page.

Why not one iframe wrapper for both? For a running app an iframe would be
cross-origin (different port), and the browser then blocks the parent from
reading elements inside it — the Same-Origin Policy, which **CORS headers cannot
relax** — so the component auto-capture (the whole point) dies; many pages also
refuse to be framed at all. Live mode instead wraps the app on the SERVER (a
reverse proxy that injects the overlay into the dev server's HTML), so the
overlay runs *same-origin* with the app: full DOM access, no iframe.

## File mode (static mockup / prototype)

1. **Find the HTML file** the user is reviewing (a path they give, or the mockup
   you just produced).
2. **Serve the file with the overlay:**
   ```bash
   node <skill>/scripts/serve-static.mjs "<path/to/mockup.html>" [--port 5000]
   ```
   It serves the file and its relative assets at `http://127.0.0.1:5000` and
   **auto-opens it in the default browser**. Set `FFB_NO_OPEN=1` to skip
   auto-open (headless/CI). Run this command from the **project root** so the
   static server and MCP server share `<project-root>/.ffb/`; if they must use
   different working directories, set `FFB_INBOX` to the same absolute inbox
   path for both. Set `FFB_NO_UPDATE_CHECK=1` to disable the MCP server's
   update check.
   The server serves the mockup's own directory, so assets should be at or below it; `../parent` assets will not resolve.
3. **Tell the user to annotate** (see *Annotating* below), then use **Send to
   AI** to deliver new annotations to the MCP server. Settings write-back and
   saving screenshots to a folder work in served file mode too.
4. **Read the feedback and edit the original** file. Reload the served page for
   the next round if useful.

## Live mode (running dev server) — proxy (default)

The clean path: run a proxy in front of the dev server. No console paste, no
bookmarklet, no extension, and **the dev server is not restarted or edited** —
the proxy is a separate process, so invoking this while the app is already
running just adds a wrapper on a new port.

1. **Detect the dev server** from the project so you can match it. Read
   `package.json` (the `dev`/`start` script), and the framework config for the
   port / host / base path / protocol:
   - Vite (`vite.config.*` → `server.port`, default **5173**)
   - Next (`next dev -p`, default **3000**)
   - Angular (`angular.json` / `ng serve --port`, default **4200**)
   - CRA / webpack-dev-server (default **3000**)

   You do **not** need to replicate the app's own proxy rules (Vite
   `server.proxy`, Next rewrites, Angular `proxy.conf.json`): the proxy sits in
   front of the whole dev server, so those keep working inside it. You only need
   its front-door URL.
2. **Run the proxy**, pointed at the detected dev server:
   ```bash
   node <skill>/scripts/serve-proxy.mjs --target http://localhost:5173 [--port 5000]
   ```
   It injects the overlay (with `html2canvas` inlined) into the dev server's HTML,
   strips `X-Frame-Options`/CSP, and **forwards the HMR WebSocket** so hot reload
   keeps working. Everything else streams straight through. Run this command from
   the **project root**: the proxy and MCP server rendezvous through
   `<project-root>/.ffb/`. Add `.ffb/` to that project's `.gitignore`; it is local
   feedback state. If the processes must use different working directories, set
   `FFB_INBOX` to the same absolute inbox path for both.
3. **Tell the user to open `http://localhost:5000`** (the proxy) instead of the
   real dev port. The overlay bar is already there — annotate (below). Toggle the
   whole overlay with **Ctrl+.** whenever it's in the way; the app is otherwise
   untouched. HMR still reloads on save. The proxy **hot-reads `overlay.js`** on
   every HTML response, so if you change the overlay itself, a plain browser
   reload picks it up — no proxy restart, no re-inject.
4. **Read the feedback and edit the source components.** The element descriptor +
   text quote points you at the right component even when class names are
   hashed/utility.

### Send feedback directly to the AI (served file or live/proxy mode)

In served file or live/proxy mode, the overlay's **Send to AI** button (default hotkey:
**Ctrl+Backslash**) sends new annotations to the local inbox for the MCP server. Use it
after submitting the notes you want applied. **Copy All** (default **Ctrl+'**) is
the only path to the AI in console/bookmarklet mode, and is also available for
non-MCP clients, human reviewers, and web chat: paste the copied feedback into
the conversation as usual.

Claude Code auto-registers the Fast Feedback MCP server when this plugin is
installed. It provides four tools:

- `ffb_pull` reads and clears all pending feedback.
- `ffb_wait` waits for feedback, then reads and clears it.
- `ffb_peek` reads pending feedback without clearing it.
- `ffb_status` returns JSON with `pending` (the number of pending items),
  `inbox` (the absolute inbox path), `server`, and `version`. `server` is an
  object whose `state` is `none`, `running`, or `not_responding`; the marker
  tracks every server that has served the inbox, and `running` means at least
  one answers. It includes the selected server's `mode`, `url`, and
  `started_at`. `version` is `{ current, latest, outdated }`. A `hint` is
  included when the server is not running.

For the **watch loop** (review mode), call `ffb_wait`, apply the returned
feedback, then call `ffb_wait` again to re-arm it. For clients that do not support
long-polling, call `ffb_pull` once when the user says they sent feedback. Codex
and Cursor need a one-time `mcp add` registration for this server; they do not
need to add it for each use.

When `ffb_peek`, `ffb_pull`, or `ffb_wait` returns empty, call `ffb_status` to
diagnose the server and inbox being read. Their non-empty output is unchanged.
When empty, `ffb_peek` returns `[]` on the first line followed by a pointer to
`ffb_status`, so the full response is no longer JSON-parseable. `ffb_pull` and
`ffb_wait` retain `no pending feedback` and `none yet` respectively, with the
same pointer appended.

Limits (be honest): the proxy is built for **local dev servers** you're working
on. An **https** dev server needs a local cert — start it on http for the review,
or fall back to the snippet below. Rare HMR setups that hard-code the client
port may need a one-line dev-config tweak. It is not meant to wrap arbitrary
third-party/production sites (auth cookies, service workers, strict CSP). In
console/bookmarklet mode, **Send to AI cannot reach the AI** because there is no
server to receive it; **Copy All** is the only path to the AI.

## Live mode — console / bookmarklet (fallback)

When the proxy can't be used (https-only dev server, a hosted page you can't
proxy, a quick one-off), build a paste-ready overlay instead:

```bash
node <skill>/scripts/build-live.mjs [output-dir]
```

Writes `fast-feedback.snippet.js` (console) and
`fast-feedback.bookmarklet.txt`, and **copies the console snippet to the
clipboard**. Tell the user: open the app tab → **F12 → Console** → **paste
(Ctrl+V)** → Enter. (Bookmarklet alternative exists but is large now that
`html2canvas` is inlined — prefer the console.) Then annotate as below.
The action button is labelled **Archive locally**. **Send to AI does not work in
this mode:** there is no server to receive it. The button archives to History;
use **Copy All** to get the feedback to the AI.

## Annotating (both modes)

A top strip appears at the very top of the page (the app is pushed down so the
strip never overlaps its header): left shows `🖍 Feedback` + the file name,
right shows the **Write / List / Copy All / Screenshot / ⚙** buttons. Button
labels don't print their shortcut — the current combo is in each button's
**tooltip** (hover), kept in sync with whatever the shortcut is bound to. The
user:
- arms the highlight cursor — **Write** button or **Ctrl+/**. It's one-shot:
  after drawing one box it disarms, so no stray crosshair is left on. Pressing
  **Esc** while it's armed disarms it too.
- **drags a box** over any part; a **draggable form pops up at that box**,
- writes the fix and clicks **Submit** (or **Ctrl+Enter**) → the box is committed
  with a number and the list count goes up. Closing an unsaved box asks before
  discarding, so nothing is lost by accident.
- opens the list — **List** button or **Ctrl+[** — titled **Feedback (n)**, where
  each note shows as read-only text. Hovering a note reveals **✎ edit** and
  **🗑 delete** (top-right of the card); a committed box also has a **🗑 on its
  top-right corner**. Editing is inline; closing a changed edit asks before
  reverting. Deleting asks first (**Cancel / Discard**).
- the list header also has **Copy** and **Clear** — Clear wipes every note after a
  confirm (**Cancel / Clear**) and restarts numbering at [1].
- copies everything — **Copy All** button or **Ctrl+'** — and pastes it back.
- **Screenshot** — **Screenshot** button or **Ctrl+;** — renders the page (with
  the annotation boxes in it, minus this overlay's own bar) to a PNG and copies
  it straight to the **clipboard**, so you just **Ctrl+V** it into the chat. Uses
  a bundled `html2canvas` (inlined by the build scripts — no network). Over
  `https`/`localhost` the clipboard copy works; if the clipboard is blocked (e.g.
  over `file://`) it falls back to downloading `feedback-screenshot.png`.
  Optionally the shot is **also saved to a folder** (⚙ → *Save screenshots to a
  folder*, off by default). Because a browser can't write an arbitrary path, this
  fully applies in **served file and live/proxy modes**: the overlay POSTs the
  PNG to the server, which writes `feedback-<timestamp>.png` into the configured
  folder (blank = `<os-temp>/fast-feedback-shots`). In console/bookmarklet mode
  there is no server, so a "saved" shot downloads to the browser's Downloads
  folder instead.

- shows/hides the **whole overlay** with **Ctrl+.** — the bar, boxes and top
  spacer all disappear and the page behaves normally, so it stays out of the way
  when you're just using the app. The choice is remembered (localStorage) across
  reloads, which matters when it's always injected (e.g. via the dev proxy).
- opens **⚙ Settings** (a centered, non-draggable popup) for **theme**,
  **highlight color**, **screenshots**, and **hotkeys**:
  - **Theme** — Light / Dark, saved **per project** (keyed by the project's path)
    so each app reopens in the mode you last used for it.
  - **Highlight color** — the accent used for annotation boxes, **per project /
    per mode** (defaults: gold in dark, bright red in light). The swatch opens a
    custom picker popover (SV square + hue slider + hex/RGB + 6 presets); **Reset**
    returns to the mode default.
  - **Screenshots** — *Save screenshots to a folder* (global, off by default) +
    a folder path. See the Screenshot bullet above for the served-vs-console behavior.
  - **Hotkeys** — rebind any shortcut to **Ctrl** (or ⌘) plus optional **Alt** /
    **Shift** plus one key (e.g. `Ctrl+Alt+K`), so a user whose environment
    already grabs a default can pick a free combo. Matched by physical key
    (`e.code`, layout-independent), conflict-checked, resettable. Hotkeys are
    **global** (shared across every project) — a keyboard reflex shouldn't change
    per repo.

Persistence across triggers: settings live in **two files** — global
(`~/.config/fast-feedback/settings.json`: hotkeys + screenshot prefs) and project
(`<cwd>/.claude/skills/fast-feedback/settings.json`: theme + highlight). The build
scripts read both and inject them as `window.__FFB_SETTINGS`, so the next time the
skill runs it restores them. In **served file and live/proxy modes** the overlay
writes changes back to the right file automatically (the server exposes the
write route); in console/bookmarklet mode changes persist via `localStorage` for
that page.

Hotkeys (defaults — all rebindable in ⚙): **Ctrl+.** show/hide · **Ctrl+/**
annotate (**Esc** disarms) · **Ctrl+[** list · **Ctrl+'** copy · **Ctrl+;**
screenshot · **Ctrl+Backslash** Send · in a form **Ctrl+Enter** submit / **Esc** cancel.

## Feedback format you will receive

```
# Fast feedback (ep001-what_is_s&p500.mockup.html)
- [1] div.basket "the S&P 500"  [x30% y52% w40% h9%]  make this less flat, increase the height
- [2] span.gold "— in one basket"  [x28% y70% w44% h5%]  make this line's font bigger
- [3] div.tickers  [x8% y40% w84% h8%]  the chips are too cramped, add spacing
```

- `[n]` — annotation number (matches the numbered box on the page).
- **component descriptor**: `<tag>` + `#id`/`.class` if present + a short quote
  of the element's text. **Primary signal** — use it to find the element.
- `[x% y% w% h%]` — box position/size as a percentage of the page. Secondary,
  for disambiguation.
- Then the user's comment: what they want changed.

Map each item to its element in the source, apply the change, and briefly
confirm what you changed per item.

## Notes

- **Reusable across projects and frameworks.** Generic overlay; nothing is
  project-specific. Point file mode at any HTML, live mode at any running app.
- **Self-contained.** No dependencies, no network. The engine injects its own
  CSS and is prefixed `__ffb` so it won't clash with the host page. Pasting the
  live snippet twice is safe (it no-ops and re-shows the bar).
- **No `</body>`?** The file-mode server wraps fragment-y HTML and appends the
  overlay, so it still works.
- This skill produces the overlay and consumes the feedback — it does not itself
  edit the UI. You make the edits based on the feedback.
