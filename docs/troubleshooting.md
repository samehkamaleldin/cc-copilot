# Troubleshooting

Run `cc-copilot doctor` first — it reports platform, node/npx/claude versions,
service status, port health, and whether the Foundry config is present.

For the *why* behind any of these, see [gotchas.md](gotchas.md) (each item below
links to the relevant gotcha).

## Fast diagnostic flow

```bash
cc-copilot doctor          # everything at a glance
cc-copilot status          # service + ports up?
cc-copilot logs            # live logs (shim + copilot-api + daemon)

# Bypass Claude Code and hit the proxy directly:
curl -s http://localhost:4142/healthz
curl -s http://localhost:4142/v1/messages \
  -H 'content-type: application/json' -H 'x-api-key: x' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"opus","max_tokens":32,"messages":[{"role":"user","content":"say OK"}]}'
```

If the curl works but Claude Code doesn't, the problem is in Claude Code's config
(model/env), not the proxy. If the curl fails, read `cc-copilot logs`.

## "Not logged in · Please run /login"

cc-copilot uses **Foundry provider mode**, which has no login gate, so this
should not happen once `cc-copilot install` has run. If you see it:

- Confirm the config is present: `cc-copilot doctor` → `foundry config: present`.
  If missing, run `cc-copilot install`.
- You may be running a Claude Code session that started **before** install.
  Restart Claude Code.

## Proxy not responding / `down` ports

```bash
cc-copilot status     # are 4141 / 4142 up?
cc-copilot logs       # what failed?
```

Common causes:
- **Not authenticated.** `copilot-api` needs a one-time login:
  `cc-copilot auth`, then `cc-copilot restart`.
- **Port in use.** Change ports in `models.json` (`ports.shim`,
  `ports.copilotApi`), then `cc-copilot install && cc-copilot restart`.
- **Service not running.** `cc-copilot start` (or `restart`).

## `400 Extra inputs are not permitted` / `context_management`

The shim already strips beta fields on the native Claude path. If a new Claude
Code release adds another rejected field, add its key to
`ALLOWED_MESSAGES_FIELDS`'s complement — i.e. it will be dropped automatically
since the whitelist only forwards known-good fields. If you see this on the
**Responses** path, the field is in the translated body; open an issue.

## `model_not_supported` / `not accessible via the /chat/completions endpoint`

The model is only served on a different endpoint:
- If it needs the **Responses API**, add its id to `responsesApiModels`.
- Some hidden/virtual model names (e.g. provider-internal "fast" variants) are
  not exposed by Copilot's API at all and cannot be used here.

## "Claude Opus 4 was retired" warning

Cosmetic. It's a client-side string match in Claude Code on the model name.
Copilot still serves the model. Using dashed canonical ids
(`claude-opus-4-8`) avoids it; cc-copilot already does this.

## Rate limits / Copilot abuse warnings

Claude Code makes many background calls. To reduce load:
- Lower effort: `/effort low` or `medium`.
- `copilot-api` supports `--rate-limit <seconds>` and `--manual`. To pass these,
  edit the spawn args in `src/daemon.mjs` (search for `copilot-api@latest`).

## 1M context shows as 200K

Behind a gateway, Claude Code can't auto-detect 1M support, so it budgets 200K
unless the model id carries `[1m]`. cc-copilot sets
`ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-8[1m]` (and Sonnet) for you. Confirm
the status line shows `… / 1M`. The shim strips `[1m]` before calling Copilot.
([gotchas §2.2](gotchas.md#22-the-1m-suffix-and-the-1m-context-trap))

> If you *ask the model* "what's your context window?" it may say 200K — the
> model doesn't know its deployment config. Trust the status line, not the model.

## A model alias returns an error / empty / `undefined`

- If you added a custom alias whose **value** ends in `[1m]`, make sure you're on
  a current build — the shim strips `[1m]` both before and after alias resolution.
  ([gotchas §2.3](gotchas.md#23-alias-values-carry-1m--strip-after-aliasing-too))
- For `gpt-5.5` (or any Responses model), an **empty** reply with a small
  `max_tokens` and high effort is expected: reasoning consumed the output budget.
  Raise `max_tokens` / lower effort.
  ([gotchas §6.3](gotchas.md#63-low-max_tokens--high-effort--empty-output))

## `/effort` seems to have no effect on Claude models

Known limitation. Claude Code sends effort in `output_config`, which the shim
drops on the native Claude path (Copilot's `/v1/messages` rejects it). Claude
models use Copilot's default reasoning; only adaptive `thinking` is forwarded.
Effort *does* work for `gpt-5.5` (Responses path).
([gotchas §6.2](gotchas.md#62-claude-models-dont-get-the-effort-level-forwarded))

## Streaming hangs, truncates, or drops `message_start`

If you've modified the shim's SSE translation: make sure `eventType` persists
**across** `data` callbacks (outer-closure variable), not reset per chunk — the
`event:`/`data:` pair can split across TCP reads, and `response.created` can
exceed one chunk. ([gotchas §4.1](gotchas.md#41-persist-eventtype-across-tcp-chunks))

## Service won't stay up

```bash
cc-copilot logs            # what's crashing?
cc-copilot doctor          # ports / auth / config
```

- **macOS:** if `npx`/`node` "not found", the LaunchAgent PATH is wrong — reinstall
  (`cc-copilot install`) so the plist gets the right `PATH`.
  ([gotchas §8.1](gotchas.md#81-launchd-has-a-minimal-path))
- **Linux:** the service dies at logout → enable lingering:
  `loginctl enable-linger $USER`. ([gotchas §8.2](gotchas.md#82-systemd-user-services-stop-at-logout-without-lingering))
- **Windows:** ensure the per-user logon task exists
  (`Get-ScheduledTask -TaskName cc-copilot` shows its state) and that `node` is on
  PATH for the logon task. If `cc-copilot install` reported a registration error,
  it now fails loudly instead of silently — re-run it and read the message.
- The daemon **intentionally** exits when copilot-api dies so the service
  restarts the whole stack — brief blips during token refresh are normal.
  ([gotchas §8.4](gotchas.md#84-the-daemon-exits-when-copilot-api-dies))

## `Extra inputs are not permitted` (still)

The shim whitelists fields on the native Claude path, so this should be gone. If a
new Claude Code release adds a field the **Responses** translation forwards, it can
resurface on `gpt-5.5`. Capture the request from `cc-copilot logs` and drop the
offending key in `anthropicToResponses`.
([gotchas §1.3](gotchas.md#13-betaextension-fields-are-rejected-by-v1messages))

## Two model rows / "From gateway" duplicates in `/model`

Only relevant in gateway mode (not the default Foundry setup). Discovered rows are
**additive** to built-in alias rows. A stale `~/.claude/cache/gateway-models.json`
or a session started before discovery was enabled also shows old/duplicate rows —
clear the cache and restart Claude Code.
([gotchas §7.4](gotchas.md#74-discovered-rows-are-additive-not-replacements))

## It worked, then suddenly 401 / auth errors

The Copilot token is short-lived; copilot-api refreshes it. A burst of 401s
usually means a refresh blip (the daemon restarts) or your GitHub session was
revoked. Re-auth if it persists:

```bash
cc-copilot auth && cc-copilot restart
```

## Rate limits / Copilot abuse warnings

Claude Code makes many background calls. To reduce load:
- Lower effort: `/effort low` or `medium`.
- `copilot-api` supports `--rate-limit <seconds>` and `--manual`. To pass these,
  edit the spawn args in `src/daemon.mjs` (search for `copilot-api@latest`).
- Heavy sustained use can trigger Copilot's abuse detection and, worst case,
  suspend access. ([gotchas §9.1](gotchas.md#91-abuse-detection-is-real))

## Collecting a bug report

```bash
cc-copilot doctor                       # environment + health
cc-copilot logs                         # reproduce, then copy the relevant lines
# the exact request the shim sent is in shim.log; redact any tokens before sharing
```

## Updating

```bash
# macOS / Linux
git -C ~/.cc-copilot/app pull && cc-copilot restart
```

```powershell
# Windows (PowerShell)
git -C $HOME\.cc-copilot\app pull; cc-copilot restart
```

## Fully removing cc-copilot

```bash
# macOS / Linux
cc-copilot uninstall          # removes service + Claude config keys
rm -rf ~/.cc-copilot ~/.local/share/cc-copilot ~/.local/bin/cc-copilot
# copilot-api credentials (separate) live in copilot-api's own data dir
```

```powershell
# Windows (PowerShell)
cc-copilot uninstall          # removes the logon task + Claude config keys
Remove-Item -Recurse -Force $HOME\.cc-copilot, $env:LOCALAPPDATA\cc-copilot, $HOME\bin\cc-copilot.cmd
# copilot-api credentials (separate) live in copilot-api's own data dir
```
