# Platforms & the background service

cc-copilot installs its daemon under each OS's native service manager so the
proxy is always running and `claude` works after a reboot.

| OS      | Backend            | Where it lives                                            |
| ------- | ------------------ | -------------------------------------------------------- |
| macOS   | launchd LaunchAgent| `~/Library/LaunchAgents/ai.cc-copilot.plist`             |
| Linux   | systemd user unit  | `~/.config/systemd/user/cc-copilot.service`              |
| Windows | Scheduled Task     | Task `cc-copilot`, runs `node bin/cli.mjs serve` at logon|

All three run the same command: `node bin/cli.mjs serve` (the daemon).

`cc-copilot install` creates and starts the service; `cc-copilot uninstall`
removes it. `start` / `stop` / `restart` / `status` manage it.

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

- A logon-triggered task runs the daemon. Node's child-process supervision plus
  the task restart cover crashes.
- Manual control:
  ```powershell
  schtasks /Query  /TN cc-copilot
  schtasks /Run    /TN cc-copilot
  schtasks /End    /TN cc-copilot
  ```
- For a more robust always-on service, install
  [NSSM](https://nssm.cc/) and point it at `node <repo>\bin\cli.mjs serve`
  (optional; the Scheduled Task is enough for interactive use).

## Data & log locations

| Item            | macOS / Linux                          | Windows                              |
| --------------- | -------------------------------------- | ------------------------------------ |
| Logs            | `~/.local/share/cc-copilot/logs/`      | `%LOCALAPPDATA%\cc-copilot\logs\`    |
| User config     | `~/.local/share/cc-copilot/models.json`| `%LOCALAPPDATA%\cc-copilot\models.json` |
| Copilot creds   | managed by `copilot-api`               | managed by `copilot-api`             |
| Claude settings | `~/.claude/settings.json`              | `%USERPROFILE%\.claude\settings.json`|

Run `cc-copilot doctor` to print the resolved paths and health on your machine.
