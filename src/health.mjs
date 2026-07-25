// Health checks for cc-copilot's configuration.
//
// Two kinds of drift bite in practice:
//
//   1. Settings drift — config/models.json is the source of truth, but the
//      tier mapping Claude Code actually reads lives in ~/.claude/settings.json
//      and is only written by `cc-copilot install`. Editing models.json and
//      running `restart` changes nothing, silently.
//
//   2. Model drift — a pinned model id can disappear upstream, or Copilot can
//      ship a newer version of a family you're pinned to. We report both rather
//      than auto-switching: silently changing the model you talk to (and pay
//      for) mid-session is worse than a nudge.
import { buildEnvBlock } from "./claude-config.mjs";

/**
 * Compare the env block cc-copilot wants against what Claude Code has.
 * @returns {Array<{key:string, expected:string, actual:string|undefined}>} drifted keys
 */
export function diffEnvBlock(cfg, settingsEnv = {}) {
  const want = buildEnvBlock(cfg);
  const drift = [];
  for (const [key, expected] of Object.entries(want)) {
    if (key.startsWith("//")) continue; // descriptive marker, not a setting
    const actual = settingsEnv[key];
    if (actual !== expected) drift.push({ key, expected, actual });
  }
  return drift;
}

/**
 * Normalise a model id for comparison.
 *
 * Copilot's upstream ids use dotted versions (claude-haiku-4.5) while the
 * aliases use the dashed canonical form Claude Code needs to label a model
 * correctly (claude-haiku-4-5). Both name the same deployment, so collapse
 * digit-dash-digit to a dot before comparing.
 */
export function normalizeModelId(id) {
  return String(id ?? "").replace(/(\d)-(?=\d)/g, "$1.");
}

/**
 * Split a model id into family + numeric version, e.g.
 * "claude-opus-4.8" -> { family: "claude-opus", version: [4, 8] }.
 * Returns null when there's no trailing version to compare.
 */
export function parseModelVersion(id) {
  const m = /^(.*?)-(\d+(?:\.\d+)*)$/.exec(normalizeModelId(id));
  if (!m) return null;
  return { family: m[1], version: m[2].split(".").map(Number) };
}

/** Compare two version arrays like [4,8] vs [5]. Returns -1, 0 or 1. */
export function compareVersions(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * For each configured model, report whether it still exists upstream and
 * whether a newer version of the same family is available.
 *
 * @param {string[]} configured  model ids cc-copilot resolves to
 * @param {string[]} upstream    model ids copilot-api exposes
 * @returns {{missing:string[], newer:Array<{configured:string, latest:string}>}}
 */
export function checkModels(configured, upstream) {
  const available = new Set(upstream.map(normalizeModelId));
  const missing = [];
  const newer = [];

  for (const id of new Set(configured)) {
    if (!available.has(normalizeModelId(id))) { missing.push(id); continue; }
    const parsed = parseModelVersion(id);
    if (!parsed) continue;
    let latest = null;
    for (const candidate of upstream) {
      const c = parseModelVersion(candidate);
      if (!c || c.family !== parsed.family) continue;
      if (compareVersions(c.version, parsed.version) <= 0) continue;
      if (!latest || compareVersions(c.version, parseModelVersion(latest).version) > 0) latest = candidate;
    }
    if (latest) newer.push({ configured: id, latest });
  }
  return { missing, newer };
}

/** The concrete model ids the current config routes to (aliases resolved). */
export function configuredModelIds(cfg) {
  const ids = new Set();
  const strip = (v) => String(v ?? "").replace(/\[1m\]$/i, "");
  for (const value of Object.values(cfg.aliases ?? {})) {
    // Alias values may chain to another alias (e.g. fable -> gpt-56-sol-ultra).
    const direct = strip(value);
    ids.add(strip(cfg.aliases?.[direct] ?? direct));
  }
  if (cfg.customModelOption?.id) ids.add(strip(cfg.customModelOption.id));
  return [...ids];
}
