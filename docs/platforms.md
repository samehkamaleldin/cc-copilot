# Platforms & the background service

cc-copilot installs its daemon under each OS's native service manager so the
proxy is always running and `claude` works after a reboot.

| OS      | Backend            | Where it lives                                            |
| ------- | ------------------ | -------------------------------------------------------- |
| macOS   | launchd LaunchAgent| `~/Library/LaunchAgents/ai.cc-copilot.plist`             |
| Linux   | systemd user unit  | `~/.config/systemd/user/cc-copilot.service`              |
| Windows | Scheduled Task     | Per-user logon task `cc-copilot`, runs `node bin\cli.mjs serve` |

All three run the same command: `node bin/cli.mjs serve` (the daemon).

`cc-copilot install` creates and starts the service; `cc-copilot uninstall`
removes it. `start` / `stop` / `restart` / `status` manage it. None of these
require administrator / `sudo` rights — everything is installed in your own user
account.

## Install layout

cc-copilot keeps a clear separation between the **app** (cloned repo + its
`node_modules`), the **CLI command** on your `PATH`, and **runtime data** (logs,
optional config). The bootstrap installer (`install.sh` / `install.ps1`) sets all
of this up; you can override the app location with the `CC_COPILOT_HOME`
environment variable.

| Item        | macOS / Linux                     | Windows                                  |
| ----------- | --------------------------------- | ---------------------------------------- |
| App code    | `~/.cc-copilot/app`               | `%USERPROFILE%\.cc-copilot\app`          |
| CLI command | symlink `~/.local/bin/cc-copilot` | shim `%USERPROFILE%\bin\cc-copilot.cmd`  |
| On `PATH`   | `~/.local/bin`                    | `%USERPROFILE%\bin` (added to user PATH) |

- **macOS / Linux:** the installer symlinks `bin/cli.mjs` to
  `~/.local/bin/cc-copilot` and, if that dir isn't already on your `PATH`, prints
  the `export PATH=...` line to add to your shell profile.
- **Windows:** the installer writes a `cc-copilot.cmd` shim to `%USERPROFILE%\bin`
  (which calls `node <app>\bin\cli.mjs %*`) and adds `%USERPROFILE%\bin` to your
  **user** `PATH`. Open a new terminal after installing so the `PATH` change takes
  effect.

Run `cc-copilot doctor` to print the resolved install dir, data dir, and Claude
settings path on your machine.

## macOS (launchd)

- `RunAtLoad` + `KeepAlive` keep it running and restart on crash.
- Logs: `~/.local/share/cc-copilot/logs/` and the `service.*.log` files.
- Manual control:
  ```bash
  launchctl load -w  ~/Library/LaunchAgents/ai.cc-copilot.plist
  launchctl unload   ~/Library/LaunchAgents/ai.cc-copilot.plist
  ```

## Linux (systemd --user)

- Installed with `systemctl --user enable --now cc-copilot.service`.
- `loginctl enable-linger <user>` is attempted so it runs without an active
  login session. If your distro disallows lingering, the service runs while you
  are logged in.
- Manual control:
  ```bash
  systemctl --user status  cc-copilot.service
  systemctl --user restart cc-copilot.service
  journalctl --user -u cc-copilot.service -f
  ```

## Windows (Scheduled Task)

- Installed as a **per-user logon task** via PowerShell's `Register-ScheduledTask`
  (the ScheduledTasks module). This runs in your own account and needs **no
  administrator rights** — unlike `schtasks /Create /SC ONLOGON /RL LIMITED`,
  which fails with `Access is denied` for a standard user.
- The task settings restart the daemon on failure; Node's child-process
  supervision covers copilot-api crashes.
- Manual control (PowerShell):
  ```powershell
  Get-ScheduledTask   -TaskName cc-copilot    # state (Ready / Running)
  Start-ScheduledTask -TaskName cc-copilot
  Stop-ScheduledTask  -TaskName cc-copilot
  ```
- Logs: `%LOCALAPPDATA%\cc-copilot\logs\`.
- For a heavier always-on service, install [NSSM](https://nssm.cc/) and point it
  at `node <app>\bin\cli.mjs serve` (optional; the logon task is enough for
  interactive use).

## Data & log locations

| Item            | macOS / Linux                          | Windows                              |
| --------------- | -------------------------------------- | ------------------------------------ |
| App code        | `~/.cc-copilot/app`                    | `%USERPROFILE%\.cc-copilot\app`      |
| CLI command     | `~/.local/bin/cc-copilot`              | `%USERPROFILE%\bin\cc-copilot.cmd`   |
| Logs            | `~/.local/share/cc-copilot/logs/`      | `%LOCALAPPDATA%\cc-copilot\logs\`    |
| User config     | `~/.local/share/cc-copilot/models.json`| `%LOCALAPPDATA%\cc-copilot\models.json` |
| Copilot creds   | managed by `copilot-api`               | managed by `copilot-api`             |
| Claude settings | `~/.claude/settings.json`              | `%USERPROFILE%\.claude\settings.json`|

Run `cc-copilot doctor` to print the resolved paths and health on your machine.
