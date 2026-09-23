// Unit tests for the configuration health checks and token-expiry parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  diffEnvBlock,
  parseModelVersion,
  compareVersions,
  normalizeModelId,
  checkModels,
  configuredModelIds,
} from "../src/health.mjs";
import { tokenExpiryMs } from "../src/shim.mjs";

/** A config shaped like loadConfig()'s output. */
function cfg(overrides = {}) {
  return {
    shimPort: 4142,
    aliases: {
      opus: "claude-opus-4-8[1m]",
      haiku: "claude-haiku-4-5",
      fable: "gpt-6-astra[1m]",
      "gpt-56-sol-ultra": "gpt-5.6-sol",
    },
    tierLabels: { fable: { name: "GPT-6 Astra", description: "GPT-6 Astra via GitHub Copilot - 1M context" } },
    customModelOption: {
      id: "gpt-56-sol-ultra[1m]",
      name: "GPT-5.6 Sol Ultra (1M)",
      description: "GPT-5.6 Sol via GitHub Copilot - max reasoning, 1M context",
    },
    defaultModel: "gpt-56-sol-ultra[1m]",
    ...overrides,
  };
}

/* ------------------------------ diffEnvBlock ------------------------------- */

function matchingEnv() {
  return {
    CLAUDE_CODE_USE_FOUNDRY: "1",
    ANTHROPIC_FOUNDRY_BASE_URL: "http://localhost:4142",
    ANTHROPIC_FOUNDRY_API_KEY: "cc-copilot",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8[1m]",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "gpt-6-astra[1m]",
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: "GPT-6 Astra",
    ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION: "GPT-6 Astra via GitHub Copilot - 1M context",
    ANTHROPIC_CUSTOM_MODEL_OPTION: "gpt-56-sol-ultra[1m]",
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "GPT-5.6 Sol Ultra (1M)",
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "GPT-5.6 Sol via GitHub Copilot - max reasoning, 1M context",
  };
}

test("diffEnvBlock reports nothing when settings match the config", () => {
  assert.deepEqual(diffEnvBlock(cfg(), matchingEnv()), []);
});

test("diffEnvBlock catches a stale tier mapping — the models.json edit that never applied", () => {
  const env = { ...matchingEnv(), ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5[1m]" };
  const drift = diffEnvBlock(cfg(), env);
  assert.deepEqual(drift, [{
    key: "ANTHROPIC_DEFAULT_OPUS_MODEL",
    expected: "claude-opus-4-8[1m]",
    actual: "claude-opus-5[1m]",
  }]);
});

test("diffEnvBlock reports unset keys and ignores the descriptive marker", () => {
  const drift = diffEnvBlock(cfg(), {});
  assert.ok(drift.length > 0);
  assert.ok(drift.every((d) => !d.key.startsWith("//")), "marker key must not be reported");
  assert.equal(drift.find((d) => d.key === "ANTHROPIC_DEFAULT_OPUS_MODEL").actual, undefined);
});

/* --------------------------- version comparison ---------------------------- */

test("parseModelVersion splits family and numeric version", () => {
  assert.deepEqual(parseModelVersion("claude-opus-4.8"), { family: "claude-opus", version: [4, 8] });
  assert.deepEqual(parseModelVersion("claude-opus-5"), { family: "claude-opus", version: [5] });
  assert.deepEqual(parseModelVersion("gpt-5.6-sol"), null, "no trailing version -> null");
});

test("dashed canonical ids and dotted upstream ids are treated as the same model", () => {
  // Claude Code needs claude-haiku-4-5; Copilot lists claude-haiku-4.5.
  assert.equal(normalizeModelId("claude-haiku-4-5"), "claude-haiku-4.5");
  assert.equal(normalizeModelId("claude-opus-5"), "claude-opus-5");
  assert.deepEqual(parseModelVersion("claude-haiku-4-5"), { family: "claude-haiku", version: [4, 5] });
});

test("compareVersions orders versions numerically, not lexically", () => {
  assert.equal(compareVersions([5], [4, 8]), 1, "5 > 4.8");
  assert.equal(compareVersions([4, 10], [4, 9]), 1, "4.10 > 4.9");
  assert.equal(compareVersions([4, 8], [4, 8]), 0);
  assert.equal(compareVersions([4], [4, 1]), -1);
});

/* ------------------------------- checkModels ------------------------------- */

const UPSTREAM = [
  "claude-opus-4.6", "claude-opus-4.7", "claude-opus-4.8", "claude-opus-5",
  "claude-sonnet-5", "claude-haiku-4.5", "gpt-5.6-sol",
];

test("checkModels flags a newer version in the same family", () => {
  const { missing, newer } = checkModels(["claude-opus-4.8"], UPSTREAM);
  assert.deepEqual(missing, []);
  assert.deepEqual(newer, [{ configured: "claude-opus-4.8", latest: "claude-opus-5" }]);
});

test("checkModels is quiet when already on the latest", () => {
  assert.deepEqual(checkModels(["claude-opus-5", "gpt-5.6-sol"], UPSTREAM), { missing: [], newer: [] });
});

test("checkModels flags a model that disappeared upstream", () => {
  const { missing, newer } = checkModels(["claude-opus-9"], UPSTREAM);
  assert.deepEqual(missing, ["claude-opus-9"]);
  assert.deepEqual(newer, [], "a missing model is not also reported as outdated");
});

test("checkModels does not compare across families", () => {
  assert.deepEqual(checkModels(["claude-haiku-4.5"], UPSTREAM).newer, [], "opus-5 is not a haiku upgrade");
});

/* ------------------------------ bundled config ----------------------------- */

test("bundled config exposes Astra and GPT-6 Sol while keeping Sol Ultra as the default", () => {
  const models = JSON.parse(fs.readFileSync(new URL("../config/models.json", import.meta.url), "utf8"));
  assert.equal(models.aliases.fable, "gpt-6-astra[1m]");
  assert.equal(models.tierLabels.fable.name, "GPT-6 Astra");
  assert.equal(models.aliases.opus, "claude-opus-5-5[1m]");
  assert.equal(models.tierLabels.opus.name, "Claude Opus 5.5 (1M)");
  assert.equal(models.customModelOption.id, "gpt-6-sol[1m]");
  assert.equal(models.defaultModel, "gpt-56-sol-ultra[1m]");
  for (const id of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) assert.ok(models.responsesApiModels.includes(id));
  assert.equal(models.reasoningEffortOverrides["gpt-56-sol-ultra"], "max");
  assert.equal(models.reasoningEffortOverrides.fable, undefined);
});

/* --------------------------- configuredModelIds ---------------------------- */

test("configuredModelIds resolves aliases from tiers, custom option, and default", () => {
  const ids = configuredModelIds(cfg());
  assert.ok(ids.includes("claude-opus-4-8"));
  assert.ok(ids.includes("gpt-6-astra"));
  assert.ok(ids.includes("gpt-5.6-sol"), "custom/default alias must resolve to the real id");
  assert.ok(!ids.includes("gpt-56-sol-ultra"), "virtual aliases must not reach upstream health checks");
  assert.ok(!ids.some((i) => i.includes("[1m]")), "no [1m] suffixes should leak through");
});

/* ------------------------------ tokenExpiryMs ------------------------------ */

test("tokenExpiryMs reads exp from a Copilot token", () => {
  assert.equal(tokenExpiryMs("tid=abc;ol=1;exp=1784974816;sku=x"), 1784974816 * 1000);
});

test("tokenExpiryMs returns null when exp is absent or malformed", () => {
  assert.equal(tokenExpiryMs("tid=abc;sku=x"), null);
  assert.equal(tokenExpiryMs(""), null);
  assert.equal(tokenExpiryMs(null), null);
});

test("tokenExpiryMs does not match a lookalike suffixed key", () => {
  assert.equal(tokenExpiryMs("tid=abc;notexp=123"), null);
});
