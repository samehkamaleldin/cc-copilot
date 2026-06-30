// Cross-platform path helpers for cc-copilot.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

/** Path to the npx executable, accounting for Windows. */
export function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}
