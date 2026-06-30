// Loads and normalises cc-copilot configuration.
//
// Precedence (low -> high):
//   1. bundled config/models.json
//   2. user override at <dataDir>/models.json (if present)
//   3. environment variables (CC_COPILOT_SHIM_PORT, CC_COPILOT_API_PORT)
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR, userModelsConfigPath } from "./paths.mjs";

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

let cached = null;

export function loadConfig() {
  if (cached) return cached;

  const bundled = readJsonIfExists(path.join(CONFIG_DIR, "models.json")) || {};
  const user = readJsonIfExists(userModelsConfigPath()) || {};

  const merged = {
    ports: { ...(bundled.ports || {}), ...(user.ports || {}) },
    aliases: { ...(bundled.aliases || {}), ...(user.aliases || {}) },
    defaultModel: user.defaultModel || bundled.defaultModel || "opus",
    responsesApiModels: user.responsesApiModels || bundled.responsesApiModels || [],
    discovery: user.discovery || bundled.discovery || [],
  };

  // Env overrides for ports.
  const shimPort = Number(process.env.CC_COPILOT_SHIM_PORT || merged.ports.shim || 4142);
  const apiPort = Number(process.env.CC_COPILOT_API_PORT || merged.ports.copilotApi || 4141);

  // Derived lookups.
  const canonicalById = {};
  for (const m of merged.discovery) {
    if (m.id && m.canonical && m.id !== m.canonical) canonicalById[m.id] = m.canonical;
  }

  cached = {
    shimPort,
    apiPort,
    aliases: merged.aliases,
    defaultModel: merged.defaultModel,
    responsesApiModels: new Set(merged.responsesApiModels),
    discovery: merged.discovery,
    canonicalById,
    discoveryAllow: new Set(merged.discovery.map((m) => m.id)),
  };
  return cached;
}

/** Reset the cache (used by tests / config reloads). */
export function resetConfigCache() {
  cached = null;
}
