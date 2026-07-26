// Settings store for fast-feedback, split by scope across TWO files so choices
// carry over to the next skill trigger:
//
//   GLOBAL  (hotkeys — same everywhere, a keyboard reflex shouldn't change per repo)
//     ~/.config/fast-feedback/settings.json             -> { "hotkeys": {...} }
//     (kept OUTSIDE the skill dir so reinstalling/updating the skill never
//      clobbers it, and it's never accidentally committed with the skill)
//
//   PROJECT (theme + highlight color — per app being reviewed)
//     <cwd>/.claude/skills/fast-feedback/settings.json  -> { "theme": "...", "highlight": {...} }
//     (add it to the project's .gitignore if you don't want it committed)
//
// The build scripts read both and inject window.__FFB_SETTINGS; served file and
// proxy servers write the matching file back when the user changes something in the ⚙ dialog.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { currentLatest, versionInfo, ensureVersionChecked } from "./update-check.mjs";

const PLUGIN_VERSION = (() => {
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".claude-plugin", "plugin.json");
    const { version } = JSON.parse(readFileSync(path, "utf8"));
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
})();

export { ensureVersionChecked };

export function globalPath() { return join(homedir(), ".config", "fast-feedback", "settings.json"); }
export function projectPath() { return join(process.cwd(), ".claude", "skills", "fast-feedback", "settings.json"); }

// Where screenshots land when "save to folder" is on but no folder is set. A
// per-user temp dir keeps the default zero-config and out of any repo.
export function defaultShotDir() { return join(tmpdir(), "fast-feedback-shots"); }

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")) || {}; }
  catch (e) { return {}; }
}
function writeJson(p, obj) {
  try { mkdirSync(dirname(p), { recursive: true }); } catch (e) {}
  writeFileSync(p, JSON.stringify(obj, null, 2));
}

// A stable id for the project (its path), used by the overlay only to namespace
// its localStorage fallback — the on-disk scoping is by file location.
export function projectId() { return process.env.FFB_PROJECT || process.cwd(); }

// What to inject: global hotkeys + screenshot prefs + this project's theme &
// highlight. screenshot.dir is passed through RAW ("" = use the default) and the
// resolved default is sent alongside so the ⚙ dialog can show it as a placeholder.
export function readForProject() {
  const g = readJson(globalPath());
  const p = readJson(projectPath());
  const s = g.screenshot || {};
  return {
    hotkeys: g.hotkeys || null,
    theme: p.theme || null,
    highlight: p.highlight || null,
    screenshot: { save: !!s.save, dir: s.dir || "" },
    screenshotDefaultDir: defaultShotDir()
  };
}

// Resolve the folder screenshots actually get written to (custom or default).
export function screenshotDir() {
  const g = readJson(globalPath());
  const s = g.screenshot || {};
  return s.dir || defaultShotDir();
}

// Write a captured PNG to the configured folder; returns the absolute path. Only
// served file and proxy servers call this; console/bookmarklet mode has no server
// to write with. The name carries a timestamp so repeated shots do not clobber each other.
export function saveScreenshot(buffer) {
  const dir = screenshotDir();
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const file = join(dir, "feedback-" + stamp + ".png");
  writeFileSync(file, buffer);
  return file;
}

export function bootAssignments() {
  const info = versionInfo(PLUGIN_VERSION, currentLatest());
  return "window.__FFB_PROJECT=" + JSON.stringify(projectId()) + ";" +
    "window.__FFB_SETTINGS=" + JSON.stringify(readForProject()) + ";" +
    "window.__FFB_VERSION=" + JSON.stringify(info.current) + ";" +
    "window.__FFB_LATEST=" + JSON.stringify(info.latest) + ";" +
    "window.__FFB_OUTDATED=" + JSON.stringify(info.outdated) + ";";
}

// Merge a change from the overlay into the correct file.
export function applyUpdate(partial) {
  if (!partial || typeof partial !== "object") return;
  if (partial.hotkeys && typeof partial.hotkeys === "object") {
    const g = readJson(globalPath());
    g.hotkeys = partial.hotkeys;
    writeJson(globalPath(), g);
  }
  if (partial.screenshot && typeof partial.screenshot === "object") {
    const g = readJson(globalPath());
    g.screenshot = { save: !!partial.screenshot.save, dir: partial.screenshot.dir || "" };
    writeJson(globalPath(), g);
  }
  if (partial.theme === "light" || partial.theme === "dark" || (partial.highlight && typeof partial.highlight === "object")) {
    const p = readJson(projectPath());
    if (partial.theme === "light" || partial.theme === "dark") p.theme = partial.theme;
    if (partial.highlight && typeof partial.highlight === "object") {
      p.highlight = { light: partial.highlight.light || null, dark: partial.highlight.dark || null };
    }
    writeJson(projectPath(), p);
  }
}
