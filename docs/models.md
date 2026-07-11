# Models & configuration

cc-copilot's model routing and aliases live in
[`config/models.json`](../config/models.json). To customise without editing the
repo, copy that file to your per-user data dir and edit it there:

```bash
# path is printed by `cc-copilot doctor`
mkdir -p ~/.local/share/cc-copilot
cp config/models.json ~/.local/share/cc-copilot/models.json
```

User config is merged over the bundled defaults. After editing, run
`cc-copilot install` (to rewrite Claude settings) and `cc-copilot restart`.

## Format

```jsonc
{
  "ports": { "shim": 4142, "copilotApi": 4141 },

  // Tier alias -> real Copilot model id.
  // Dashed ids (claude-opus-4-8) make Claude Code label them correctly.
  // The [1m] suffix asks Claude Code to budget the 1M window; the shim strips it.
  "aliases": {
    "opus":   "claude-opus-4-8[1m]",
    "sonnet": "claude-sonnet-5[1m]",
    "haiku":  "claude-haiku-4-5",
    "fable":  "gpt-5.6-sol[1m]",
    "gpt-56-sol":   "gpt-5.6-sol",
    "gpt-56-luna":  "gpt-5.6-luna",
    "gpt-56-terra": "gpt-5.6-terra"
  },

  // Written to Claude Code's `model` setting (alias or full id).
  "defaultModel": "opus",

  // Models that ONLY work on Copilot's /v1/responses endpoint.
  "responsesApiModels": ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"],

  // Optional display name/description for a repurposed tier row in the /model
  // picker (emits ANTHROPIC_DEFAULT_<TIER>_MODEL_NAME/_DESCRIPTION).
  "tierLabels": {
    "fable": { "name": "GPT-5.6 Sol (1M)", "description": "GPT-5.6 Sol via GitHub Copilot — 1M context" }
  },

  // One extra /model picker row (Foundry supports a single custom option).
  // Emits ANTHROPIC_CUSTOM_MODEL_OPTION[_NAME|_DESCRIPTION].
  "customModelOption": {
    "id": "gpt-5.6-luna[1m]",
    "name": "GPT-5.6 Luna (1M)",
    "description": "GPT-5.6 Luna via GitHub Copilot — 1M context"
  },

  // Curated /v1/models discovery list (only used in gateway mode).
  // `id` = copilot-api's upstream (dotted) id; `canonical` = the dashed id
  // Claude Code recognises; non-claude ids get a synthetic prefix so discovery
  // keeps them.
  "discovery": [
    { "id": "claude-opus-4.8",  "canonical": "claude-opus-4-8",  "name": "Claude Opus 4.8" },
    { "id": "claude-sonnet-5",  "canonical": "claude-sonnet-5",  "name": "Claude Sonnet 5" },
    { "id": "claude-haiku-4.5", "canonical": "claude-haiku-4-5", "name": "Claude Haiku 4.5" },
    { "id": "gpt-5.5",          "canonical": "gpt-5.5",          "name": "GPT-5.5" },
    { "id": "gpt-5.6-sol",      "canonical": "gpt-56-sol",       "name": "GPT-5.6 Sol" },
    { "id": "gpt-5.6-luna",     "canonical": "gpt-56-luna",      "name": "GPT-5.6 Luna" },
    { "id": "gpt-5.6-terra",    "canonical": "gpt-56-terra",     "name": "GPT-5.6 Terra" }
  ]
}
```

## How aliases reach Claude Code

`cc-copilot install` writes these into `~/.claude/settings.json` `env`:

```json
{
  "CLAUDE_CODE_USE_FOUNDRY": "1",
  "ANTHROPIC_FOUNDRY_BASE_URL": "http://localhost:4142",
  "ANTHROPIC_FOUNDRY_API_KEY": "cc-copilot",
  "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-8[1m]",
  "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5[1m]",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
  "ANTHROPIC_DEFAULT_FABLE_MODEL": "gpt-5.6-sol[1m]",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "GPT-5.6 Sol (1M)",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION": "GPT-5.6 Sol via GitHub Copilot — 1M context",
  "ANTHROPIC_CUSTOM_MODEL_OPTION": "gpt-5.6-luna[1m]",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "GPT-5.6 Luna (1M)",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": "GPT-5.6 Luna via GitHub Copilot — 1M context"
}
```

So in Claude Code:
- `/model opus` → `claude-opus-4-8[1m]`
- `/model sonnet` → `claude-sonnet-5[1m]`
- `/model haiku` → `claude-haiku-4-5`
- `/model fable` → `gpt-5.6-sol[1m]` (shows as **GPT-5.6 Sol (1M)**)
- **GPT-5.6 Luna (1M)** custom row → `gpt-5.6-luna[1m]`

You can also select a model by full id, e.g. `/model claude-opus-4-8`, or type
any GPT-5.6 alias directly: `/model gpt-56-terra` (200K) or
`/model gpt-56-terra[1m]` (1M).

### Extra picker rows & the 1M window

In Foundry provider mode the `/model` picker has a fixed set of slots — the four
tiers (opus/sonnet/haiku/fable) plus **one** `customModelOption`. To surface a
non-tier model as its own row, either repurpose the `fable` slot (with an
optional `tierLabels` label) or set `customModelOption`. Additional models stay
reachable by typing their id in `/model`.

The `[1m]` suffix budgets the 1M context window; the shim strips it before the
request reaches Copilot. The suffix is read **per env variable**, so the same
model can appear at 200K in one slot and 1M in another. For the full
200K-and-1M matrix across many models (more rows than Foundry allows), switch to
gateway mode and let `discovery` drive the picker.

## Discovering what Copilot offers

To see every model your Copilot subscription exposes (so you can add ids to the
config), query the running proxy:

```bash
# all models copilot-api sees (raw, dotted ids)
curl -s http://localhost:4141/v1/models | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>JSON.parse(d).data.forEach(m=>console.log(m.id)))'
```

Not every listed model is usable: some are blocked on `/chat/completions`
("not accessible via the /chat/completions endpoint") and only work on
`/v1/responses` — add those to `responsesApiModels`.

## Adding a model

1. Add the alias (or use the full id directly).
2. If it only works on the Responses API, add its id to `responsesApiModels`.
3. For the `/model` picker label in gateway mode, add a `discovery` entry with
   the dashed `canonical` id.
4. `cc-copilot install && cc-copilot restart`.

## Reasoning effort

For Responses-API models (e.g. GPT‑5.5), Claude Code's effort level
(`/effort low|medium|high|xhigh|max`) is forwarded as `reasoning.effort`
(`max` maps to `xhigh`, the Responses API ceiling). Claude models use their
native adaptive thinking.
