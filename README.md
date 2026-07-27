# fast-feedback

**Point at the exact part of a UI, type the change you want, and hand it to your AI coding agent.**

fast-feedback drops an in-browser highlight-and-comment overlay on top of **any**
frontend — a static HTML mockup or a **running dev server** (React, Vue, Angular,
Next, plain HTML). You drag a box over the exact region you mean, write the fix,
and export structured feedback that [Claude Code](https://claude.com/claude-code)
reads to make precise edits. It replaces the slow "screenshot it and describe
where" round-trip.

```
[1] div.basket "the S&P 500"  [x30% y52% w40% h9%]  make this taller, less flat
[2] button.cta                [x71% y8%  w14% h6%]  use the accent color, bigger
```

Your agent gets an element descriptor + a text quote + a normalized region, so it
finds the right component even when class names are hashed or utility-based.

---

## Install (Claude Code plugin)

```
/plugin marketplace add paolochang/fast-feedback
/plugin install fast-feedback@fast-feedback
```

Because it's installed from a marketplace (this git repo), you get updates when a
new version is pushed here — no re-copying.

Prefer to just copy it? Clone the repo and drop
`plugins/fast-feedback/skills/fast-feedback/` into `~/.claude/skills/`. (You lose
the auto-update path that way.)

**Requirements:** Node.js 18+ (the scripts use built-in `fetch`/`http`), and a
modern browser.

---

## Updating

When the settings popup shows the in-overlay **update available** badge, run:

```text
/plugin marketplace update fast-feedback
/plugin update fast-feedback@fast-feedback
/reload-plugins
```

ffb checks for a newer version when the ffb process starts (the proxy/static
server, or when generating the console snippet), from your own machine — the
same place `/plugin` already talks to GitHub. It checks at most once per run and
is fully fail-silent: offline or blocked means no badge and no error. Because
the check runs in the Node process, not in the page, it does not send anything
about the app you are reviewing to GitHub.

---

## Three ways to use it

Ask Claude to run it ("annotate this mockup", "let me mark up the running app"),
or run the scripts directly. Script paths below are relative to the skill dir
(`plugins/fast-feedback/skills/fast-feedback/` in this repo).

### 1. Static mockup / prototype (file mode)

Serves an HTML file with the overlay injected (the original is never touched):

```bash
node scripts/serve-static.mjs path/to/mockup.html [--port 5000]
# opens http://127.0.0.1:5000 with Send to AI and write-back available
```

Run it from the project root so it and the MCP server share `.ffb/`, or set
`FFB_INBOX` to the same absolute inbox path for both processes.

### 2. Running dev server (proxy mode — recommended for apps)

Runs a tiny proxy **in front of** your dev server and injects the overlay into its
HTML, so the overlay runs same-origin (full DOM access) with **no console paste,
no bookmarklet, no extension, and without restarting or editing the dev server**:

```bash
node scripts/serve-proxy.mjs --target http://localhost:5173 [--port 5000]
# then open http://localhost:5000 instead of the dev port
```

HMR/WebSocket is forwarded, so hot reload keeps working. The proxy **hot-reads**
the overlay, so if you tweak the skill, a plain browser reload picks it up.

### 3. Console snippet / bookmarklet (fallback)

When you can't proxy (an https-only dev server, a hosted page):

```bash
node scripts/build-live.mjs
# writes a console snippet (auto-copied to clipboard) + a bookmarklet
```

Open the app tab → F12 → Console → paste → Enter.

---

## Using the overlay

A slim bar appears at the top of the page:

- **Write** — arm the highlight cursor, then drag a box over what you mean and type
  your note. One-shot: it disarms after each box so you can keep interacting with
  the app.
- **List** — every annotation, editable, with a running count.
- **Copy All** — copies the whole structured list to paste back to your agent.
- **Screenshot** — renders the page (annotation boxes included, the bar excluded)
  to a PNG straight to your **clipboard**. Optionally also saved to a folder.
- **⚙ Settings** — theme, highlight color, screenshot saving, and hotkeys.

### Hotkeys (defaults — all rebindable in ⚙)

| Action | Default |
|---|---|
| Show / hide the whole overlay | `Ctrl+.` |
| Write (annotate) | `Ctrl+/` |
| List | `Ctrl+[` |
| Copy all | `Ctrl+'` |
| Screenshot | `Ctrl+;` |
| Open settings | `Ctrl+,` |

`Ctrl+.` works even while the overlay is hidden, so it's always one keypress away.
On macOS the shortcuts use `⌘`; combos support `Ctrl(+Alt/+Shift)+key`.

### Settings & persistence

- **Theme** (Light / Dark) and **highlight color** — saved **per project**.
- **Hotkeys** and **screenshot save** — saved **globally**.
- Global settings live in `~/.config/fast-feedback/settings.json`; project settings
  in `<project>/.claude/skills/fast-feedback/settings.json`. In served file and
  proxy mode the overlay writes changes back automatically so they survive to the
  next run.

---

## How your agent uses the feedback

Paste the copied list into Claude Code. Each line carries an element descriptor, a
short text quote, and an `[x% y% w% h%]` region — enough to locate the exact
component and make the change, then you re-annotate the result. That tight
**annotate → edit → re-annotate** loop is the whole point.

---

## Development

This repository is the source of truth. The plugin bundles a single skill at
`plugins/fast-feedback/skills/fast-feedback/`; the overlay engine is
`assets/overlay.js` (a self-contained IIFE, prefixed `__ffb`), with a vendored
`html2canvas` (MIT) for offline screenshots. On each release, bump these three
version fields in lockstep:

- `plugins/fast-feedback/.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json` `metadata.version`
- `.claude-plugin/marketplace.json` `plugins[fast-feedback].version`

`server.mjs` reads `plugin.json`, so it follows automatically. The overlay badge
is driven by `marketplace.json` `plugins[fast-feedback].version`; if that field
is not bumped, users will not see the update.

Versions are 3-part `X.Y.Z` — fast-feedback does not publish prereleases. The
update check compares only 3-part versions and is fail-safe: anything it does
not recognize simply shows no badge, never a wrong one.

## License

[MIT](./LICENSE) © Paolo Chang. Copy it, fork it, use it freely.
