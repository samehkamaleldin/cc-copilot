// Cross-platform path helpers for cc-copilot.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** Repo root (one level up from src/). */
export const REPO_ROOT = path.resolve(__dirname, "..");

/** Bundled default config dir. */
export const CONFIG_DIR = path.join(REPO_ROOT, "config");

/**
 * Per-user data directory for cc-copilot (logs, pid files, user config copy).
 *   macOS / Linux : ~/.local/share/cc-copilot   (or $XDG_DATA_HOME)
 *   Windows       : %LOCALAPPDATA%\cc-copilot
 */
export function dataDir() {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "cc-copilot");
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "cc-copilot");
}

export function logDir() {
  return path.join(dataDir(), "logs");
}

/** Claude Code's user settings file. */
export function claudeSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

/** Where the user can override the bundled models.json. */
export function userModelsConfigPath() {
  return path.join(dataDir(), "models.json");
}

/** Persistent per-user usage accumulator (token totals across restarts). */
export function usageStatePath() {
  return path.join(dataDir(), "usage.json");
}

/**
 * Structured per-call telemetry sink (one JSON object per LLM call, JSONL).
 * Captures model/route/latency/status, token + prompt-cache figures, per-call
 * spend and lightweight request metadata. Disable with CC_COPILOT_TELEMETRY=0;
 * relocate with CC_COPILOT_TELEMETRY_FILE.
 */
export function telemetryPath() {
  return process.env.CC_COPILOT_TELEMETRY_FILE || path.join(logDir(), "telemetry.jsonl");
}

/**
 * Directory for opt-in full request/response body traces (the actual prompts).
 * Only written when CC_COPILOT_TRACE_BODIES is set (may contain sensitive
 * prompt content — off by default).
 */
export function traceDir() {
  return path.join(logDir(), "bodies");
}

/** Path to the npx executable, accounting for Windows. */
export function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

/**
 * Absolute path to the locally-installed `copilot-api` CLI entry
 * (`node_modules/copilot-api/dist/main.js`). Running this with `node` directly
 * avoids spawning `npx.cmd` through a shell — which, with an args array, trips
 * Node's DEP0190 deprecation warning — and pins the vendored version instead of
 * re-resolving `@latest` on every start.
 */
export function copilotApiEntry() {
  const candidates = [];
  try { candidates.push(require.resolve("copilot-api/dist/main.js")); } catch { /* not resolvable */ }
  candidates.push(path.join(REPO_ROOT, "node_modules", "copilot-api", "dist", "main.js"));
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  throw new Error(`copilot-api not found — run \`npm install\` in ${REPO_ROOT}`);
}
