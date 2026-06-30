# Troubleshooting

Run `cc-copilot doctor` first — it reports platform, node/npx/claude versions,
service status, port health, and whether the Foundry config is present.

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

## Updating

```bash
# macOS / Linux
git -C ~/.cc-copilot/app pull && cc-copilot restart
```

## Fully removing cc-copilot

```bash
cc-copilot uninstall          # removes service + Claude config keys
rm -rf ~/.cc-copilot ~/.local/share/cc-copilot
# copilot-api credentials (separate) live in copilot-api's own data dir
```
