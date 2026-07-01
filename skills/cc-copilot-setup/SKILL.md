---
name: cc-copilot-setup
description: >-
  Set up, configure, verify, and troubleshoot cc-copilot — the bridge that lets
  Claude Code (and any Anthropic-Messages client) run on a GitHub Copilot
  subscription with no claude.ai login. Use this when the user wants to "use
  Copilot models in Claude Code", "drive Claude Code with Copilot", install or
  repair the bridge, or when they hit related symptoms: "Not logged in / please
  run /login", a model showing as "Opus 4"/"retired", 1M context showing as
  200K, /effort seeming to do nothing, gpt-5.5 / fable not working, the proxy
  being down, or the /model picker missing models.
---

# cc-copilot setup & troubleshooting

You are helping a user run **Claude Code on their GitHub Copilot subscription**
via **cc-copilot** (repo: `samehkamaleldin/cc-copilot`). cc-copilot is a local
proxy + background service that translates between Claude Code's Anthropic
Messages API and GitHub Copilot's model endpoints, and wires Claude Code up in
**Microsoft Foundry provider mode** so there is no claude.ai login gate.

Work through this skill top-to-bottom for a fresh setup, or jump to
[§7 Gotchas playbook](#7-gotchas-playbook) for a specific symptom.

> **Ground rule:** prefer the `cc-copilot` CLI over hand-editing files. It writes
> Claude config and installs the OS service correctly and reversibly. Only edit
> `config/models.json` or `~/.claude/settings.json` when the CLI can't express
> what's needed, and explain the change to the user.

> **Honesty / ToS:** this relies on a reverse-engineered view of Copilot's API
> (`copilot-api`). Tell the user once: it's unofficial, can break when GitHub
> changes the backend, and heavy automated use may trip Copilot's abuse
> detection. Don't hammer it.

---

## 1. Decide what the user needs

- **"Set it up from scratch"** → do §2 → §6.
- **"It stopped working" / a specific error** → §7 (find the symptom), then
  re-verify with §6.
- **"Change models / default / add a model"** → §8.
- **"Remove it"** → §9.

Always confirm the platform (`macOS`, `Linux`, `Windows`) — the service backend
differs (launchd / systemd / Scheduled Task). Run `cc-copilot doctor` early; it
prints platform, versions, ports, and config state in one shot.

---

## 2. Preconditions

Check and, if missing, tell the user how to fix:

| Requirement            | Check                         | If missing |
| ---------------------- | ----------------------------- | ---------- |
| Node.js ≥ 20           | `node -v`                     | Install from nodejs.org |
| git                    | `git --version`               | Install git |
| Claude Code            | `claude --version`            | `npm i -g @anthropic-ai/claude-code` (or the official installer) |
| A GitHub Copilot plan  | ask the user                  | Required — individual/business/enterprise all work |

Do **not** assume a claude.ai account is needed — cc-copilot uses provider mode,
so it isn't.

---

## 3. Install

Repo is at `git@github.com:samehkamaleldin/cc-copilot.git`. If it's public, the
one-liners work; while private, clone over SSH.

```bash
# Public (later):
curl -fsSL https://raw.githubusercontent.com/samehkamaleldin/cc-copilot/main/install.sh | bash   # macOS/Linux
# Windows (PowerShell): irm https://raw.githubusercontent.com/samehkamaleldin/cc-copilot/main/install.ps1 | iex

# Private (now): clone + local installer
git clone git@github.com:samehkamaleldin/cc-copilot.git
cd cc-copilot && ./install.sh        # links `cc-copilot` onto PATH (~/.local/bin)
```

If PATH linking didn't happen (or on Windows without the shim), you can always
call the CLI directly: `node bin/cli.mjs <command>` from the repo dir.

Confirm the CLI resolves: `cc-copilot --help`.

---

## 4. Authenticate to GitHub Copilot (one-time, interactive)

```bash
cc-copilot auth
```

This runs `copilot-api auth`, which prints a **device code** and a URL
(`https://github.com/login/device`). **You must surface these to the user and
wait for them to approve** — you can't approve on their behalf.

Interactive-terminal gotchas (see gotchas §5.2):
- `copilot-api` writes a **0-byte** token file *before* login completes. "File
  exists" ≠ authenticated. Success looks like `Logged in as <user>` in the
  output / a **non-empty** token file.
- If you're scripting the wait, do **not** grep for `logged in` — the string
  `Not logged in` matches it. Match `Logged in as` or check the token file is
  non-empty.

After the user approves, continue.

---

## 5. Configure Claude Code + start the service

```bash
cc-copilot install
```

This:
1. Merges the Foundry provider config + model aliases into
   `~/.claude/settings.json` (preserving all existing keys), and sets the
   default `model`.
2. Installs and starts the OS background service (launchd / systemd / Scheduled
   Task) so the proxy is always up, including after reboot.
3. Waits for the proxy to answer.

If it reports the proxy didn't come up, the usual cause is **auth** — go back to
§4, then `cc-copilot restart`.

---

## 6. Verify (always do this)

```bash
cc-copilot doctor      # platform, versions, service, ports, "foundry config: present"
cc-copilot status      # copilot-api :4141 and shim :4142 should be 200/up
```

Then a real end-to-end check — **prefer proving the proxy directly first**, so
you can tell whether a failure is the proxy or Claude Code's config:

```bash
# proxy directly (bypasses Claude Code):
curl -s http://localhost:4142/v1/messages \
  -H 'content-type: application/json' -H 'x-api-key: x' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"opus","max_tokens":32,"messages":[{"role":"user","content":"Reply with exactly: OK"}]}'

# then Claude Code itself:
claude -p "Reply with exactly: CLAUDE_OK"
```

Success criteria:
- proxy curl returns `{"...","content":[{"type":"text","text":"OK"...}]}`
- `claude -p` prints `CLAUDE_OK` with **no** login prompt
- In interactive `claude`, the status line shows `… / 1M` for opus/sonnet.

Tell the user how to drive it:
- Just run `claude`. Default model is **opus** (Claude Opus 4.8, 1M context).
- Switch models with `/model opus|sonnet|haiku|fable`
  (fable = GPT‑5.5, 1.05M context, supports reasoning `/effort`).

---

## 7. Gotchas playbook

Match the symptom, apply the fix, then re-verify (§6). Deep explanations live in
the repo's `docs/gotchas.md` (section numbers below).

### "Not logged in · Please run /login" (interactive)
- **Cause:** provider config not applied, or the Claude Code session started
  before install. (gotchas §5.5–5.6)
- **Fix:** `cc-copilot doctor` → ensure `foundry config: present`; if not,
  `cc-copilot install`. Then **restart Claude Code**. Print mode (`-p`) can work
  while the TUI still shows this, which is misleading — trust `doctor`.

### Proxy down / ports show "down" / API errors
- **Cause:** not authenticated, service not running, or a port conflict.
  (gotchas §8.5)
- **Fix:** `cc-copilot logs` to see the failure. If auth: `cc-copilot auth` →
  `cc-copilot restart`. If a port is taken: change `ports` in `config/models.json`,
  then `cc-copilot install && cc-copilot restart`.

### Model labelled "Opus 4" and/or a "retired" warning
- **Cause:** a dotted id (`claude-opus-4.8`) was used; Claude Code's registry
  wants dashed canonical ids. (gotchas §2.1)
- **Fix:** use dashed ids everywhere (cc-copilot's defaults already do:
  `claude-opus-4-8`). The warning is cosmetic; the model still works.

### 1M context shows as 200K
- **Cause:** behind a gateway Claude Code can't detect 1M, so it budgets 200K
  unless the id carries `[1m]`. (gotchas §2.2)
- **Fix:** cc-copilot sets `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-8[1m]`
  (and sonnet). Confirm the status line shows `… / 1M`. If the *model* says
  "200K" when asked, ignore it — the model doesn't know its deployment; the
  gateway enforces 1M.

### An alias errors / returns empty / `undefined`
- **Alias value carries `[1m]`:** the shim must strip `[1m]` both before *and*
  after alias resolution. Ensure the repo is up to date. (gotchas §2.3)
- **gpt-5.5 empty with small max_tokens + high effort:** reasoning consumed the
  output budget — raise `max_tokens` or lower `/effort`. (gotchas §6.3)

### `/effort` seems to do nothing on Claude models
- **Cause / known limitation:** effort rides in `output_config`, which the shim
  drops on the native Claude path (Copilot rejects it). Claude models use
  adaptive thinking, not the explicit level. Effort **does** apply to `gpt-5.5`
  (fable). (gotchas §6.2)

### `400 Extra inputs are not permitted` / `context_management`
- **Cause:** a Claude Code beta field Copilot rejects. The shim whitelists
  known-good fields on the native path, so this should be gone. (gotchas §1.3)
- **Fix:** update the repo. If it recurs on `gpt-5.5`, capture the request from
  `cc-copilot logs` and drop the offending key in `anthropicToResponses`
  (`src/shim.mjs`).

### `model_not_supported` / "not accessible via /chat/completions"
- **Cause:** the model only lives on a different endpoint, or is a virtual model
  that Copilot's API doesn't serve (e.g. `claude-opus-4.8-fast`). (gotchas §2.4, §3)
- **Fix:** if it needs the Responses API, add its id to `responsesApiModels`.
  "Fast" variants aren't real Copilot models — emulate with `/effort low` or
  Haiku.

### `/model` picker missing models
- Only relevant in gateway mode (not the default Foundry mode). Provider mode
  populates the picker from aliases (`ANTHROPIC_DEFAULT_*_MODEL`), not discovery.
  All four models are selectable by alias. (gotchas §7)

### Service won't stay up
- **macOS:** LaunchAgent PATH — reinstall so the plist gets the right `PATH`.
- **Linux:** dies at logout → `loginctl enable-linger $USER`.
- **Windows:** ensure `schtasks /Query /TN cc-copilot` exists and `node` is on
  PATH. (gotchas §8)
- The daemon **intentionally** exits when `copilot-api` dies so the service
  restarts the whole stack; brief blips on token refresh are normal.

### Sudden 401s after working
- Token refresh blip (self-heals) or revoked GitHub session. If persistent:
  `cc-copilot auth && cc-copilot restart`.

---

## 8. Common changes

- **Change default / per-tier model:** edit `aliases` / `defaultModel` in
  `config/models.json` (use **dashed** ids; add `[1m]` for 1M on opus/sonnet),
  then `cc-copilot install && cc-copilot restart`. Or a one-off in-session:
  `/model <alias|id>`.
- **Add a model:** add the alias; if it's Responses-only, add its id to
  `responsesApiModels`; then `install && restart`. Probe availability first:
  `curl -s http://localhost:4141/v1/models` lists what Copilot exposes (dotted
  ids) — but appearing there doesn't guarantee `/chat/completions` works.
- **Restart / logs:** `cc-copilot restart`, `cc-copilot logs`.
- **Reduce load / rate-limit warnings:** lower `/effort`; to rate-limit
  `copilot-api`, add `--rate-limit <s>` / `--manual` to its spawn args in
  `src/daemon.mjs`.

---

## 9. Uninstall

```bash
cc-copilot uninstall     # removes the OS service + the managed Claude config keys
```

This is reversible and leaves the user's other Claude settings intact. To also
remove app + data: `rm -rf ~/.cc-copilot ~/.local/share/cc-copilot`. `copilot-api`
credentials live in its own data dir and are left alone.

---

## Reference

- Architecture, auth/token flow, request lifecycle → `docs/architecture.md`
- Full quirks list (numbered, linked above) → `docs/gotchas.md`
- Model/alias/port config format → `docs/models.md`
- Per-OS service details → `docs/platforms.md`
- Symptom → fix → `docs/troubleshooting.md`

When unsure whether a failure is the proxy or Claude Code, **curl the shim
directly** (§6) — that one test bisects the whole system.
