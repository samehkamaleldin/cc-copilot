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
    "fable":  "gpt-5.5"
  },

  // Written to Claude Code's `model` setting (alias or full id).
  "defaultModel": "opus",

  // Models that ONLY work on Copilot's /v1/responses endpoint.
  "responsesApiModels": ["gpt-5.5"],

  // Curated /v1/models discovery list (only used in gateway mode).
  // `id` = copilot-api's upstream (dotted) id; `canonical` = the dashed id
  // Claude Code recognises; non-claude ids get a synthetic prefix so discovery
  // keeps them.
  "discovery": [
    { "id": "claude-opus-4.8",  "canonical": "claude-opus-4-8",  "name": "Claude Opus 4.8" },
    { "id": "claude-sonnet-5",  "canonical": "claude-sonnet-5",  "name": "Claude Sonnet 5" },
    { "id": "claude-haiku-4.5", "canonical": "claude-haiku-4-5", "name": "Claude Haiku 4.5" },
    { "id": "gpt-5.5",          "canonical": "gpt-5.5",          "name": "GPT-5.5" }
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
  "ANTHROPIC_DEFAULT_FABLE_MODEL": "gpt-5.5"
}
```

So in Claude Code:
- `/model opus` → `claude-opus-4-8[1m]`
- `/model sonnet` → `claude-sonnet-5[1m]`
- `/model haiku` → `claude-haiku-4-5`
- `/model fable` → `gpt-5.5`

You can also select a model by full id, e.g. `/model claude-opus-4-8`.

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
