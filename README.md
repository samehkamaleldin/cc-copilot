# cc-copilot

**Drive [Claude Code](https://code.claude.com) — and any Anthropic-Messages client — with your GitHub Copilot subscription.**

cc-copilot runs a small local proxy that translates between Claude Code and
GitHub Copilot's model API, and wires Claude Code up to use it with **no
claude.ai login required**. You get Claude (Opus 4.8, Sonnet 5, Haiku 4.5) and
GPT‑5.5, all billed through your existing Copilot subscription.

```
┌────────────┐   Anthropic Messages    ┌────────── cc-copilot ──────────┐   GitHub Copilot
│ Claude Code│ ───────────────────────▶│  shim :4142  ─▶  copilot-api   │ ─▶ api.githubcopilot.com
│  (claude)  │   (Foundry provider)    │              ╲  :4141 (auth)   │
└────────────┘                         │               ╲▶ /v1/responses │ ─▶ (gpt-5.5)
                                       └────────────────────────────────┘
```

> ⚠️ **Use responsibly.** This relies on a reverse‑engineered view of GitHub
> Copilot's API (via [`copilot-api`](https://github.com/ericc-ch/copilot-api)).
> It is not endorsed by GitHub or Anthropic, may break at any time, and heavy
> automated use can trip Copilot's abuse detection. See [Caveats](#caveats).

---

## Quick start

**Prerequisites:** Node.js ≥ 20, git, and [Claude Code](https://code.claude.com) installed.

### Install (private repo — clone over SSH)

The repo is private, so clone it with your GitHub SSH access and run the local
installer:

```bash
git clone git@github.com:samehkamaleldin/cc-copilot.git
cd cc-copilot
npm install            # or: ./install.sh  (also links the `cc-copilot` CLI onto PATH)
node bin/cli.mjs auth      # one-time GitHub Copilot device login
node bin/cli.mjs install   # configure Claude Code + start the background service
```

`./install.sh` (macOS/Linux) or `install.ps1` (Windows) additionally links a
`cc-copilot` command onto your PATH so you can drop the `node bin/cli.mjs` prefix.

> **Once this repo is public**, the one-liners below will work; until then use the
> clone method above (`raw.githubusercontent.com` requires auth for private repos).
>
> ```bash
> # macOS / Linux
> curl -fsSL https://raw.githubusercontent.com/samehkamaleldin/cc-copilot/main/install.sh | bash
> # Windows (PowerShell)
> irm https://raw.githubusercontent.com/samehkamaleldin/cc-copilot/main/install.ps1 | iex
> ```

Then just run **`claude`** — no login screen, and the `/model` picker offers:

| Alias    | Model           | Notes                              |
| -------- | --------------- | ---------------------------------- |
| `opus`   | Claude Opus 4.8 | 1M context, default                |
| `sonnet` | Claude Sonnet 5 | 1M context                         |
| `haiku`  | Claude Haiku 4.5| fast / background                  |
| `fable`  | GPT‑5.5         | 1.05M context, reasoning effort    |

Switch in-session with `/model sonnet`, `/model fable`, etc.

---

## How it works

cc-copilot uses three ideas, each documented in [`docs/`](docs/):

1. **A translating shim.** Claude Code speaks the Anthropic Messages API.
   Copilot serves Claude models natively on `/v1/messages`, GPT‑5.5 only on the
   OpenAI Responses API (`/v1/responses`), and older models on
   `/chat/completions`. The shim routes each request to the right endpoint and
   translates formats (including streaming) where they differ. See
   [docs/architecture.md](docs/architecture.md).

2. **Microsoft Foundry provider mode.** Setting `CLAUDE_CODE_USE_FOUNDRY=1`
   makes Claude Code authenticate as a *provider deployment*, which removes the
   claude.ai login gate entirely. The proxy is pointed at via
   `ANTHROPIC_FOUNDRY_BASE_URL`. See [docs/platforms.md](docs/platforms.md).

3. **An always-on service.** The proxy runs under your OS service manager
   (launchd / systemd / Scheduled Task) so `claude` just works after a reboot.

The GitHub auth + Copilot token refresh is handled by
[`copilot-api`](https://github.com/ericc-ch/copilot-api), which cc-copilot runs
as a child process.

### Documentation

| Doc | What's in it |
| --- | ------------ |
| [docs/architecture.md](docs/architecture.md) | How every piece works: components, the auth/token flow, the full request lifecycle, and failure modes. |
| [docs/gotchas.md](docs/gotchas.md) | **The hard-won quirks** — protocol, model ids, endpoint routing, auth/login, discovery, streaming, effort, service. Read this before extending or debugging. |
| [docs/models.md](docs/models.md) | Model/alias/port config format and how to add models. |
| [docs/platforms.md](docs/platforms.md) | The background service on macOS / Linux / Windows; data & log locations. |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Symptom → fix, with links into the gotchas. |

---

## CLI

```
cc-copilot auth        Authenticate to GitHub Copilot (one-time device flow)
cc-copilot install     Configure Claude Code + install & start the service
cc-copilot uninstall   Remove the service and Claude config keys
cc-copilot start       Start the background service
cc-copilot stop        Stop the background service
cc-copilot restart     Restart the background service
cc-copilot status      Service + port health
cc-copilot logs        Tail proxy logs
cc-copilot doctor      Diagnose the setup
cc-copilot serve       Run the proxy in the foreground (used by the service)
```

---

## Configuration

Models and ports live in [`config/models.json`](config/models.json). To
override without editing the repo, copy it to the per-user data dir
(`cc-copilot doctor` prints the path) and edit there. See
[docs/models.md](docs/models.md) for the format and how to add models.

---

## Caveats

- **Terms of service.** Copilot's API is accessed outside its official editor
  integrations. This is a grey area and not sanctioned by GitHub or Anthropic.
- **Reverse-engineered.** Built on `copilot-api`; GitHub can change the backend
  and break this at any time.
- **Abuse detection.** Claude Code is chatty. Avoid hammering it; see
  [docs/troubleshooting.md](docs/troubleshooting.md) for rate-limit options.
- **Model labels.** Claude Code may print a "model retired" notice for some
  ids — it's a client-side string check; Copilot still serves the model.

See [docs/troubleshooting.md](docs/troubleshooting.md) for common issues.

## License

MIT — see [LICENSE](LICENSE).
