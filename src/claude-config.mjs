// Builds / merges cc-copilot's settings into Claude Code's user settings file.
//
// Uses Microsoft Foundry "provider mode" so Claude Code never shows a login
// gate (no claude.ai account required). The proxy is pointed at via
// ANTHROPIC_FOUNDRY_BASE_URL, and model aliases are pinned via the
// ANTHROPIC_DEFAULT_*_MODEL family.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { claudeSettingsPath } from "./paths.mjs";

const MARK = "//cc-copilot";

const TIER_ENV = {
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
};

// One extra "/model" picker row (Foundry supports a single custom option).
const CUSTOM_ENV = {
  id: "ANTHROPIC_CUSTOM_MODEL_OPTION",
  name: "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  description: "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
};

/** The exact set of env keys cc-copilot manages (so uninstall is clean). */
export function managedEnvKeys() {
  const tierKeys = Object.values(TIER_ENV).flatMap((k) => [k, k + "_NAME", k + "_DESCRIPTION"]);
  return [
    MARK,
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_FOUNDRY_API_KEY",
    ...tierKeys,
    ...Object.values(CUSTOM_ENV),
  ];
}

function readSettings(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return {}; }
}

function writeSettings(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

/** Compute the env block cc-copilot wants to apply. */
export function buildEnvBlock(cfg = loadConfig()) {
  const env = {
    [MARK]: "Managed by cc-copilot — routes Claude Code through your GitHub Copilot subscription via a local proxy in Microsoft Foundry provider mode (no claude.ai login required). Remove these keys to disable.",
    CLAUDE_CODE_USE_FOUNDRY: "1",
    ANTHROPIC_FOUNDRY_BASE_URL: `http://localhost:${cfg.shimPort}`,
    ANTHROPIC_FOUNDRY_API_KEY: "cc-copilot",
  };
  for (const [tier, key] of Object.entries(TIER_ENV)) {
    if (!cfg.aliases[tier]) continue;
    env[key] = cfg.aliases[tier];
    const label = cfg.tierLabels?.[tier];
    if (label?.name) env[key + "_NAME"] = label.name;
    if (label?.description) env[key + "_DESCRIPTION"] = label.description;
  }
  const custom = cfg.customModelOption;
  if (custom?.id) {
    env[CUSTOM_ENV.id] = custom.id;
    if (custom.name) env[CUSTOM_ENV.name] = custom.name;
    if (custom.description) env[CUSTOM_ENV.description] = custom.description;
  }
  return env;
}

/**
 * Apply cc-copilot config to Claude Code settings, preserving everything else.
 * @returns {{path:string, defaultModel:string, env:object}}
 */
export function installClaudeConfig(opts = {}) {
  const cfg = loadConfig();
  const file = opts.settingsPath || claudeSettingsPath();
  const settings = readSettings(file);

  settings.env = { ...(settings.env || {}), ...buildEnvBlock(cfg) };
  if (opts.setDefaultModel !== false) settings.model = cfg.defaultModel;

  // Claude Code only shows the login screen until onboarding is marked complete;
  // we don't touch ~/.claude.json here, but provider mode skips the login gate
  // regardless, so no further action is needed.

  writeSettings(file, settings);
  return { path: file, defaultModel: settings.model, env: settings.env };
}

/** Remove cc-copilot's managed keys from Claude Code settings. */
export function uninstallClaudeConfig(opts = {}) {
  const file = opts.settingsPath || claudeSettingsPath();
  if (!fs.existsSync(file)) return { path: file, removed: [] };
  const settings = readSettings(file);
  const removed = [];
  if (settings.env) {
    for (const k of managedEnvKeys()) {
      if (k in settings.env) { delete settings.env[k]; removed.push(k); }
    }
    if (Object.keys(settings.env).length === 0) delete settings.env;
  }
  writeSettings(file, settings);
  return { path: file, removed };
}
