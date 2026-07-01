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

---

## Authentication & token flow

There are two distinct credentials. Keeping them straight explains most auth
issues (see [gotchas §5](gotchas.md#5-authentication--login)).

```
                        one-time, interactive
  cc-copilot auth ─────────────────────────────▶ GitHub device flow
                                                       │ stores
                                                       ▼
                                          GitHub OAuth token (long-lived)
                                                       │  copilot-api exchanges
                                                       ▼  + auto-refreshes
                                          Copilot token  "tid=…"  (short-lived)
                                                       │  GET /token (localhost:4141)
                                                       ▼
   shim ── Authorization: Bearer <copilot-token> ──▶ api.githubcopilot.com
           + Editor-Version / Copilot-Integration-Id headers
```

- **`cc-copilot auth`** runs `copilot-api auth`, which prints a device code +
  URL. You approve once; the GitHub token is persisted by copilot-api in its own
  data dir.
- **copilot-api** exchanges that for short-lived Copilot tokens and refreshes
  them transparently. It exposes `GET /token` so the shim can read the current
  one.
- **The shim** fetches the token (from `GET /token`) for each request and calls
  Copilot directly for the `/v1/messages` and `/v1/responses` paths. Editor-
  identifying headers are required (`COPILOT_HEADERS`).

Claude Code itself authenticates to the **shim** using Foundry provider mode
(`ANTHROPIC_FOUNDRY_API_KEY`), whose value the shim ignores — the real Copilot
credential never leaves copilot-api ⇄ shim.

---

## Request lifecycle

What happens to a single `POST /v1/messages` from Claude Code:

```
1. Claude Code sends Anthropic Messages JSON (Foundry mode) to shim :4142
       body: { model, system, messages[…, {role:"system", …}], thinking,
               context_management, output_config, max_tokens, … }

2. shim.resolveModel(model)
       strip "anthropic-copilot-" prefix → strip "[1m]" → apply alias → strip "[1m]"
       e.g.  "opus" → "claude-opus-4-8[1m]" → "claude-opus-4-8"

3. route by resolved id:
   ├─ responsesApiModels.has(id)   → Responses path  (translate ⇄, see below)
   ├─ /^claude-/                    → native path
   └─ else                          → forward to copilot-api /chat/completions

4a. NATIVE path (claude-*):
      hoistSystemMessages(body)            # trailing role:system → top-level system
      drop non-whitelisted fields          # context_management, output_config, …
      GET copilot-api:4141/token           # current Copilot bearer
      POST api.githubcopilot.com/v1/messages  (Bearer + editor headers)
      pipe Copilot's response/stream straight back  (no response parsing)

4b. RESPONSES path (gpt-5.5):
      anthropicToResponses(body)           # messages→input, system→instructions,
                                           # max_tokens→max_output_tokens,
                                           # output_config.effort→reasoning.effort (max→xhigh)
      GET /token ; POST /v1/responses
      stream  → translate Responses SSE → Anthropic SSE  (streamResponsesToAnthropic)
      non-stream → responsesToAnthropic()  # output[type=message].content[output_text]
```

`GET /v1/models` (discovery) and `GET /healthz` are handled directly by the shim.

---

## Component internals

### `src/shim.mjs` — `createShimServer(cfg, log)`
Pure, dependency-free Node `http` server. Everything is closed over `cfg`
(ports, aliases, `responsesApiModels`, `canonicalById`, `discoveryAllow`) so it's
unit-testable without globals. Key functions:

| Function | Role |
| -------- | ---- |
| `resolveModel` | prefix/`[1m]`/alias normalisation (order matters — gotchas §2.3) |
| `hoistSystemMessages` | move in-array system turns to top-level `system` |
| `handleClaudeNative` | whitelist-drop + native `/v1/messages` + pipe |
| `anthropicToResponses` / `responsesToAnthropic` | format translation |
| `streamResponsesToAnthropic` | SSE translation with cross-chunk `eventType` |
| `handleModelsDiscovery` | curated `/v1/models` with dashed canonical ids |
| `forwardToCopilotApi` | fallback proxy to `:4141` |

### `src/daemon.mjs` — `runDaemon()`
Spawns `copilot-api` as a child, `waitForPort(4141)`, then starts the shim. On
child exit/error it tears down and `process.exit(1)` so the OS service manager
restarts the stack. Handles `SIGTERM`/`SIGINT` for clean stop. Logs to
`<dataDir>/logs/{daemon,copilot-api,shim}.log`.

### `src/config.mjs` — `loadConfig()`
Merges bundled `config/models.json` ← user `<dataDir>/models.json` ← env
(`CC_COPILOT_SHIM_PORT`, `CC_COPILOT_API_PORT`). Derives `canonicalById` and
`discoveryAllow`. Cached; `resetConfigCache()` for tests.

### `src/claude-config.mjs`
`installClaudeConfig()` merges the Foundry `env` block + default `model` into
`~/.claude/settings.json`, **preserving all other keys**. `uninstallClaudeConfig()`
removes exactly the managed keys (`managedEnvKeys()`), so it's reversible and
won't clobber the user's permissions/plugins/statusline.

### `src/service.mjs` — `getService()`
Dispatches to `macos` (launchd plist), `linux` (systemd user unit), or `windows`
(Scheduled Task). Each exposes `install/uninstall/start/stop/status`. The service
always runs `node bin/cli.mjs serve`.

---

## Failure modes & resilience

| Failure | Behaviour |
| ------- | --------- |
| Not authenticated | `waitForPort` times out; daemon logs "run cc-copilot auth" and exits → service retries. |
| copilot-api crashes / token refresh fails | daemon exits → service restarts whole stack (throttled). |
| Copilot upstream error | shim returns the upstream status + body unmodified (so Claude Code's own retry/error wording still matches). |
| Bad/oversized model prompt | passes through; Copilot enforces its own context limit. |
| Port already in use | shim/daemon error in logs; change ports in `models.json`. |
| Unknown model id | not claude-*, not in responses set → forwarded to copilot-api `/chat/completions` (may 400 if Copilot doesn't serve it there). |

See [troubleshooting.md](troubleshooting.md) for fixes and
[gotchas.md](gotchas.md) for the underlying quirks.
