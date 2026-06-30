# Architecture

cc-copilot sits between Claude Code and GitHub Copilot's model API.

```
Claude Code ──Anthropic Messages──▶ shim (:4142) ──┬─▶ Copilot /v1/messages   (Claude models, native)
                                                    ├─▶ Copilot /v1/responses  (gpt-5.5, translated)
                                                    └─▶ copilot-api (:4141) ─▶ /chat/completions (fallback)
                                                            │
                                                            └─ GitHub device auth + Copilot token refresh
```

## Components

### `copilot-api` (child process, port 4141)
A third-party reverse-engineered proxy
([ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api)) that:
- runs the GitHub **device authentication** flow (`cc-copilot auth`),
- exchanges your GitHub token for short-lived **Copilot tokens** and refreshes them,
- exposes `GET /token` (used by the shim) and an OpenAI-compatible
  `/chat/completions` + `/v1/models`.

cc-copilot launches it as a child of the daemon; you never call it directly.

### The shim (`src/shim.mjs`, port 4142)
An HTTP server that accepts the **Anthropic Messages API** and routes each
request:

| Incoming model            | Route                              | Why |
| ------------------------- | ---------------------------------- | --- |
| `claude-*`                | Copilot `POST /v1/messages`        | Copilot serves Claude natively in Anthropic format — zero translation, preserves thinking/effort/1M context. |
| `gpt-5.5` (responses set) | Copilot `POST /v1/responses`       | GPT‑5.5 is only available on the OpenAI Responses API. The shim translates Anthropic ⇄ Responses, including SSE streaming. |
| anything else             | `copilot-api /chat/completions`    | Fallback for other OpenAI-format models. |

It also serves `GET /v1/models` (curated discovery list) and `GET /healthz`.

The shim fetches the Copilot bearer token from `copilot-api`'s `GET /token` and
then calls `api.githubcopilot.com` **directly** for the messages/responses
paths.

### The daemon (`src/daemon.mjs`)
Runs both pieces in one process: spawns `copilot-api`, waits for it, then starts
the shim. If `copilot-api` dies, the daemon exits so the OS service manager
restarts the whole stack.

### The service (`src/service.mjs`)
Installs the daemon under the platform's service manager so it survives reboots.
See [platforms.md](platforms.md).

## Request fix-ups

The shim normalises requests so Copilot accepts them:

1. **Trailing system messages.** Claude Code appends a `role:"system"` message
   (its subagent registry) as the last array entry. Copilot requires the array
   to end with a user turn, so the shim **hoists** in-array system messages into
   the top-level `system` field.

2. **`[1m]` suffix.** Claude Code appends `[1m]` to request the 1M context
   window behind a gateway. Copilot wants the bare id, so the shim **strips** it
   (the 1M window is enforced Copilot-side regardless).

3. **Beta field whitelist.** Claude Code sends beta extensions
   (`context_management`, `output_config`, …) that Copilot's `/v1/messages`
   rejects with `Extra inputs are not permitted`. On the native path the shim
   keeps only the standard Messages fields.

4. **Reasoning effort.** For Responses-API models, Claude Code's
   `output_config.effort` is mapped to `reasoning.effort` (`max → xhigh`).

5. **Canonical ids.** Copilot uses dotted ids (`claude-opus-4.8`); Claude Code's
   model registry recognises dashed ids (`claude-opus-4-8`). The discovery list
   exposes dashed ids so labels read correctly and no "retired" warning appears.

## Why Foundry provider mode

Pointing `ANTHROPIC_BASE_URL` at the shim works, but Claude Code still treats it
as a gateway behind a claude.ai login and can show a login gate in interactive
mode. Microsoft **Foundry provider mode** (`CLAUDE_CODE_USE_FOUNDRY=1`) instead
makes Claude Code authenticate as a *provider deployment* — no login wizard, no
`/logout`, pure provider credential (which the shim ignores). Foundry uses the
Anthropic Messages format, so the shim handles it unchanged.

Trade-off: provider mode disables Claude Code's **gateway model discovery**, so
the `/model` picker is populated from the alias env vars
(`ANTHROPIC_DEFAULT_*_MODEL`) rather than auto-discovered. All four models remain
selectable by alias.
