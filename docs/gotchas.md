# Gotchas & quirks

Everything in this file was learned the hard way. Each entry is a real behaviour
of Claude Code or GitHub Copilot that the proxy has to account for. If you fork,
extend, or debug cc-copilot, read this first — most "it doesn't work" moments are
already documented here.

---

## 1. Protocol & request shape

### 1.1 A reachable base URL is *not* a working bridge
Claude Code speaks the **Anthropic Messages API** (`POST /v1/messages`, Anthropic
SSE). GitHub Copilot's primary surface is **OpenAI Chat Completions**
(`POST /chat/completions`). Pointing `ANTHROPIC_BASE_URL` at Copilot directly
fails — the wire formats differ, and Copilot needs its own auth/token exchange.
A translating proxy is mandatory. (Copilot *does* additionally serve a native
`/v1/messages` for Claude models — see §3 — which is why the shim prefers it.)

### 1.2 Claude Code appends a trailing `role:"system"` message
Modern Claude Code puts its subagent registry ("Available agent types…") as the
**last** element of the `messages` array, with `role:"system"`. Copilot rejects
this with:

```
400 "This model does not support assistant message prefill.
     The conversation must end with a user message."
```

The error wording mentions *assistant* prefill, but the real trigger is the
array not ending in a `user` turn. **Fix:** the shim hoists any in-array
`role:"system"` messages into the top-level `system` field (`hoistSystemMessages`).
A naive single-message curl test won't reproduce this because it has no trailing
system message — only real Claude Code traffic does.

### 1.3 Beta/extension fields are rejected by `/v1/messages`
Claude Code sends Anthropic **beta** fields that Copilot's `/v1/messages` does
not accept, failing with `Extra inputs are not permitted`. Observed offenders:

- `context_management` (context-editing beta)
- `output_config` (effort / structured-output / task-budget beta)

**Fix:** on the native Claude path the shim uses a **whitelist**
(`ALLOWED_MESSAGES_FIELDS`) and drops anything else. This is forward-safe: a new
beta field added by a future Claude Code release is dropped automatically rather
than 400-ing. The downside is §6.2 (effort isn't forwarded for Claude models).

### 1.4 The body must be re-serialised, not just proxied
Because the shim mutates the body (hoisting, stripping, alias resolution), it must
recompute `Content-Length`. Forwarding the original buffer with a changed body
corrupts the request. The shim always re-`JSON.stringify`s and sets the length.

---

## 2. Model IDs

### 2.1 Dotted vs dashed ids — the "Opus 4" mislabel
Copilot serves Claude under **dotted** ids: `claude-opus-4.8`, `claude-haiku-4.5`.
Claude Code's built-in model registry keys on Anthropic's **dashed canonical**
ids: `claude-opus-4-8`. Feed it a dotted id and:

- the `/model` picker shows a generic **"Opus 4"** (it only matches the
  `claude-opus-4` prefix and can't resolve the `.8`), and
- a bogus **"Claude Opus 4 was retired"** warning appears.

Copilot accepts **both** dotted and dashed on input (verified: `claude-opus-4-8`
→ returns `claude-opus-4-8`). **Fix:** expose dashed canonical ids everywhere
(aliases, discovery `canonical`, `ANTHROPIC_DEFAULT_*_MODEL`). Labels read
correctly and the warning disappears.

### 2.2 The `[1m]` suffix and the 1M-context trap
Behind a gateway/provider, Claude Code **cannot auto-detect** 1M-context support,
so it budgets the window at **200K** and auto-compacts early — even though the
model supports 1M. The documented lever is the **`[1m]` suffix** on the model id
(`claude-opus-4-8[1m]`). cc-copilot sets this on the Opus/Sonnet alias env vars.

But Copilot's API wants the **bare** id — `claude-opus-4.8[1m]` is
`model_not_supported`. So the shim **strips `[1m]`** before forwarding. Strip it
in *two* places (see §2.3).

> The model will still *say* "my context is 200K" if you ask it — the model
> doesn't know its deployment config. The gateway enforces 1M regardless; trust
> the status line (`… / 1M`), not the model's self-report.

### 2.3 Alias values carry `[1m]` — strip after aliasing too
`resolveModel` strips `[1m]`, then applies the alias — but the **alias value**
itself is `claude-opus-4-8[1m]`, so the suffix reappears. You must strip `[1m]`
**again after** alias resolution. (This was a real bug: `opus` resolved to
`claude-opus-4-8[1m]` and Copilot 400'd.) Order in `resolveModel`:
strip prefix → strip `[1m]` → apply alias → strip `[1m]` again.

### 2.4 "Fast" models (e.g. `claude-opus-4.8-fast`) are not real Copilot models
Tools like opencode expose `claude-opus-4.8-fast`. That is a **client-side
virtual model** (same model, thinking disabled for low latency), **not** a
Copilot API model. Calling it directly returns `model_not_supported` on every
endpoint, integration-id, and editor-version. You cannot get a "fast" SKU from
Copilot — emulate it instead with `/effort low` or by selecting Haiku.

---

## 3. Endpoint routing — which model lives where

Copilot does **not** serve every model on every endpoint. The mapping is the
whole reason the shim has three routes.

| Model family            | Works on                         | Notes |
| ----------------------- | -------------------------------- | ----- |
| `claude-*`              | `/v1/messages` **and** `/chat/completions` | Native Anthropic format on `/v1/messages` — preferred (no translation). |
| `gpt-5.5`               | `/v1/responses` **only**         | `model is not accessible via the /chat/completions endpoint`. OpenAI Responses API. |
| `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex` | `/v1/responses` only (and 5.4 needs `max_completion_tokens`) | Cut from cc-copilot's default set. |
| `gpt-4.1`, `gpt-4o`, `gpt-5-mini` | `/chat/completions`      | Older; cut from default set. |
| `text-embedding-*`, `trajectory-compaction`, `*-picker` | special / non-chat | excluded from discovery. |

**Gotcha:** a model appearing in `GET /v1/models` does **not** mean it's callable
on `/chat/completions`. Always probe before adding (`docs/models.md` shows how).

### 3.1 Responses API ≠ Chat Completions shape
`/v1/responses` uses `input` (not `messages`), `instructions` (not a system
message), `max_output_tokens` (not `max_tokens`), and returns an `output[]` array
where the **assistant text** lives in the item with `type:"message"` →
`content[].type === "output_text"`. There is *also* a `type:"reasoning"` item you
must skip. The shim translates both directions (`anthropicToResponses` /
`responsesToAnthropic`).

### 3.2 `gpt-5.4` (if you re-add it) needs `max_completion_tokens`
Newer OpenAI models reject `max_tokens` with
`Unsupported parameter: 'max_tokens' … Use 'max_completion_tokens' instead`.

---

## 4. Streaming (SSE)

### 4.1 Persist `eventType` across TCP chunks
Responses-API SSE events look like:

```
event: response.created
data: {…big JSON…}

event: response.output_text.delta
data: {"delta":"…"}
```

The `event:` line and its `data:` line can arrive in **different** `data`
callbacks, and a single `data:` JSON (especially `response.created`) can exceed
one chunk. If you reset `eventType` per chunk (or per line), you lose events and
the Anthropic stream is missing `message_start` / `content_block_start`. **Fix:**
keep `buf` for the incomplete trailing line **and** keep `eventType` in the outer
closure so it survives across chunks. (Real bug we hit.)

### 4.2 Anthropic stream event order is strict
Claude Code expects exactly:

```
message_start → content_block_start → ping → content_block_delta* →
content_block_stop → message_delta → message_stop
```

The shim maps Responses events to this sequence and emits a safety
`content_block_stop` on `end` if the block is still open.

### 4.3 Only the request is mutated; the response stream is piped
For the **native Claude path** the shim does not parse the response at all — it
pipes Copilot's SSE straight back. Only the **request** body is rewritten. This
keeps thinking blocks, tool-use, and cache signals intact. (The Responses path is
the exception — it must translate the stream.)

---

## 5. Authentication & login

### 5.1 Two different tokens
- **GitHub OAuth token** — obtained once via device flow (`cc-copilot auth`),
  stored by `copilot-api`. Long-lived.
- **Copilot token** (`tid=…`) — short-lived, exchanged from the GitHub token and
  refreshed automatically by `copilot-api`. The shim fetches the current one from
  `copilot-api`'s `GET /token` and uses it as `Authorization: Bearer …` against
  `api.githubcopilot.com`.

### 5.2 The auth token file is created empty first
`copilot-api` writes a **0-byte** `github_token` file *before* the device flow
completes, then fills it. Don't treat "file exists" as "authenticated" — check it
is **non-empty** (or watch the log for `Logged in as …`).

### 5.3 Editor headers are required
Token exchange and API calls need editor-identifying headers
(`Editor-Version`, `Editor-Plugin-Version`, `Copilot-Integration-Id`,
`User-Agent`). Missing them changes behaviour or fails. The shim sends a fixed
VS Code-like set (`COPILOT_HEADERS`).

### 5.4 `ANTHROPIC_AUTH_TOKEN` vs `ANTHROPIC_API_KEY`
- `ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer`. Takes effect immediately.
- `ANTHROPIC_API_KEY` → `x-api-key`. Needs a **one-time interactive approval**
  in Claude Code; a previously *declined* key is silently ignored.

cc-copilot avoids both ambiguities by using **Foundry provider mode** (§5.6).

### 5.5 The "Not logged in" interactive gate
After a `/logout`, `~/.claude.json` has `hasCompletedOnboarding:false`. In
**interactive** mode Claude Code then shows the login screen, while **print mode
(`-p`)** skips onboarding — so `-p` can work while the TUI says "Not logged in".
That asymmetry is misleading during debugging. A gateway credential set *before*
first-run setup (shell export, `~/.claude/settings.json` `env`, or managed
settings) fixes the gate; a credential in a *project's* `.claude/settings.json`
is read too late.

### 5.6 Foundry provider mode removes the login gate entirely
`CLAUDE_CODE_USE_FOUNDRY=1` makes Claude Code authenticate as a **provider
deployment**: no login wizard, no `/logout`, pure provider credential
(`ANTHROPIC_FOUNDRY_API_KEY`, whose value the proxy ignores). This is the most
robust fix and what cc-copilot uses. Foundry speaks the **Anthropic Messages
format**, so the shim needs no changes.

- You **cannot** set both `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_USE_FOUNDRY`.
- Provider mode **disables gateway model discovery** (§4 of architecture; the
  picker is then driven by `ANTHROPIC_DEFAULT_*_MODEL`).
- `ANTHROPIC_FOUNDRY_BASE_URL` may end in a vendor path in real Azure
  (`…/anthropic`); pointed at the local shim it's just `http://localhost:4142`
  and Claude Code appends `/v1/messages`.

---

## 6. Effort & thinking

### 6.1 Effort travels in `output_config.effort`
Claude Code sends the effort level (`/effort low|medium|high|xhigh|max`) as
`output_config.effort`. For **Responses** models the shim maps it to
`reasoning.effort`, clamping `max → xhigh` (the Responses API ceiling for
gpt-5.5: `none|low|medium|high|xhigh`).

### 6.2 Claude models don't get the effort level forwarded
`output_config` is in the §1.3 whitelist-drop, so on the native Claude path the
effort level is **not** passed to Copilot — only `thinking:{type:"adaptive"}`
(which *is* whitelisted) is. Claude models therefore use Copilot's default
reasoning rather than your `/effort` selection. Whether Copilot's `/v1/messages`
would even accept `output_config` is untested; passing it risks an
`Extra inputs are not permitted` 400. This is a known limitation, not a bug.

### 6.3 Low `max_tokens` + high effort = empty output
On `gpt-5.5`, reasoning tokens are spent **before** output text. With a tiny
`max_output_tokens` and high effort, the budget is consumed by reasoning and you
get an empty `output_text`. Not an error — give it room.

---

## 7. Model discovery (gateway mode only)

> Discovery is **off** in the default Foundry setup. These apply only if you
> switch to `ANTHROPIC_BASE_URL` gateway mode.

### 7.1 Discovery only keeps `claude*` / `anthropic*` ids
Claude Code's gateway discovery **drops** any `/v1/models` entry whose `id`
doesn't start with `claude` or `anthropic`. To surface GPT/Gemini, the shim
re-exposes them under a synthetic `anthropic-copilot-` prefix and strips it back
in `resolveModel`.

### 7.2 Discovery needs nonessential traffic *enabled*
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` **disables** discovery. So does any
`CLAUDE_CODE_USE_*` provider variable (including Foundry). Discovery also won't
run if `ANTHROPIC_BASE_URL` is unset or points at `api.anthropic.com`.

### 7.3 Discovery is strict and quiet
`GET /v1/models?limit=1000`, **3-second** timeout, **no redirects** (an
`http→https` redirect counts as failure), single credential header. On failure it
silently falls back to the cached `~/.claude/cache/gateway-models.json` or the
built-in list. Use `claude --debug` and look for `[gatewayDiscovery]` lines.

### 7.4 Discovered rows are additive, not replacements
The picker shows built-in alias rows (Opus/Sonnet/Haiku/…) **plus** discovered
rows labelled "From gateway". A discovered `claude-opus-4-8` doesn't replace the
`opus` alias row — both appear. Expect duplicates.

### 7.5 A stale cache misleads
The cache is refreshed at startup, but an already-running session keeps its list.
If you change discovery and don't restart Claude Code (or clear the cache file),
you'll see the old models. Also: a session that started **before** discovery was
enabled shows only built-ins.

---

## 8. Service, platform & process

### 8.1 launchd has a minimal PATH
A LaunchAgent doesn't inherit your shell PATH, so `npx`/`node` aren't found unless
you set `PATH` in the plist `EnvironmentVariables` (cc-copilot includes
`/opt/homebrew/bin` and `/usr/local/bin`).

### 8.2 systemd user services stop at logout without lingering
`systemctl --user` services die when you log out unless
`loginctl enable-linger <user>` is set. cc-copilot attempts this; some managed
distros disallow it.

### 8.3 Windows needs `npx.cmd` and a shell
`spawn("npx", …)` fails on Windows; use `npx.cmd` and `shell:true`. cc-copilot's
`npxCommand()` and the daemon handle this.

### 8.4 The daemon exits when copilot-api dies
By design: if `copilot-api` exits, the daemon exits so the service manager
restarts the **whole** stack (cleaner than half-up). Expect a brief blip on token
refresh failures; the service throttles restarts (`ThrottleInterval`/`RestartSec`).

### 8.5 Port conflicts
copilot-api `:4141`, shim `:4142`. If either is taken, change `ports` in
`models.json` and re-`install`. A "down" port in `cc-copilot status` usually
means not-authenticated or a conflict.

### 8.6 macOS bash is 3.2 — no `wait -n`
If you write shell supervisors for macOS, `wait -n` isn't available. cc-copilot
sidesteps this by supervising in Node (`src/daemon.mjs`).

---

## 9. Operational & policy

### 9.1 Abuse detection is real
Claude Code is chatty (many background calls). Heavy automated use can trip
Copilot's abuse systems and, worst case, suspend Copilot access. Lower effort,
and consider `copilot-api`'s `--rate-limit` / `--manual` (wire into
`src/daemon.mjs`).

### 9.2 This is reverse-engineered and unsanctioned
The Copilot side relies on `copilot-api`. GitHub can change the backend and break
this at any time; this is outside Copilot's official integrations and not endorsed
by GitHub or Anthropic. Treat model availability, ids, and behaviours here as
**observed**, not guaranteed.

### 9.3 Model labels and warnings are cosmetic
The "retired" notice and self-reported context size are client-side and don't
reflect what Copilot actually serves. Verify with the status line and real usage.
