// Cross-platform service installer for the cc-copilot daemon.
//
//   macOS    -> launchd LaunchAgent  (~/Library/LaunchAgents/ai.cc-copilot.plist)
//   Linux    -> systemd user service (~/.config/systemd/user/cc-copilot.service)
//   Windows  -> Scheduled Task at logon (schtasks)  +  on-demand start
//
// Each backend exposes: install(), uninstall(), start(), stop(), status().
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logDir } from "./paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVE_SCRIPT = path.resolve(__dirname, "..", "bin", "cli.mjs");
const LABEL = "ai.cc-copilot";

function nodePath() { return process.execPath; }

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

/** Quote a value as a single-quoted PowerShell string literal. */
function psLiteral(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * Run a PowerShell script from a temp file (avoids nested-quote escaping) and
 * check the exit code. Throws on failure unless `allowFail` is set.
 */
function ps(script, what, { allowFail = false } = {}) {
  const exe = process.platform === "win32" ? "powershell" : "pwsh";
  const tmp = path.join(os.tmpdir(), `cc-copilot-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(tmp, script);
  try {
    const r = sh(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tmp]);
    if (!allowFail && r.status !== 0) {
      const msg = ((r.stderr || r.stdout) || "").trim() || `exit code ${r.status}`;
      throw new Error(`failed to ${what}: ${msg}`);
    }
    return r;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/* ----------------------------- macOS (launchd) ---------------------------- */
const macos = {
  plistPath: () => path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`),

  install() {
    const logs = logDir();
    fs.mkdirSync(logs, { recursive: true });
    fs.mkdirSync(path.dirname(macos.plistPath()), { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath()}</string>
    <string>${SERVE_SCRIPT}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>${os.homedir()}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${path.join(logs, "service.out.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(logs, "service.err.log")}</string>
</dict>
</plist>
`;
    fs.writeFileSync(macos.plistPath(), plist);
    macos.start();
    return macos.plistPath();
  },
  uninstall() {
    sh("launchctl", ["unload", macos.plistPath()]);
    try { fs.unlinkSync(macos.plistPath()); } catch {}
  },
  start() {
    sh("launchctl", ["unload", macos.plistPath()]);
    sh("launchctl", ["load", "-w", macos.plistPath()]);
  },
  stop() { sh("launchctl", ["unload", macos.plistPath()]); },
  status() {
    const r = sh("launchctl", ["list"]);
    const line = (r.stdout || "").split("\n").find((l) => l.includes(LABEL));
    return line ? `loaded: ${line.trim()}` : "not loaded";
  },
};

/* ----------------------------- Linux (systemd) ---------------------------- */
const linux = {
  unitPath: () => path.join(os.homedir(), ".config", "systemd", "user", "cc-copilot.service"),

  install() {
    fs.mkdirSync(path.dirname(linux.unitPath()), { recursive: true });
    const unit = `[Unit]
Description=cc-copilot — GitHub Copilot to Claude bridge
After=network-online.target

[Service]
Type=simple
ExecStart=${nodePath()} ${SERVE_SCRIPT} serve
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
    fs.writeFileSync(linux.unitPath(), unit);
    sh("systemctl", ["--user", "daemon-reload"]);
    sh("systemctl", ["--user", "enable", "--now", "cc-copilot.service"]);
    // Best effort: keep the user service alive after logout.
    sh("loginctl", ["enable-linger", os.userInfo().username]);
    return linux.unitPath();
  },
  uninstall() {
    sh("systemctl", ["--user", "disable", "--now", "cc-copilot.service"]);
    try { fs.unlinkSync(linux.unitPath()); } catch {}
    sh("systemctl", ["--user", "daemon-reload"]);
  },
  start() { sh("systemctl", ["--user", "restart", "cc-copilot.service"]); },
  stop() { sh("systemctl", ["--user", "stop", "cc-copilot.service"]); },
  status() {
    const r = sh("systemctl", ["--user", "is-active", "cc-copilot.service"]);
    return (r.stdout || r.stderr || "unknown").trim();
  },
};

/* --------------------------- Windows (Scheduled Task) --------------------- */
// Registered as a per-user logon task via the ScheduledTasks PowerShell module.
// This works for a standard (non-elevated) user, unlike
// `schtasks /Create /SC ONLOGON /RL LIMITED`, which fails with
// "Access is denied" without administrator rights.
const windows = {
  taskName: "cc-copilot",

  install() {
    fs.mkdirSync(logDir(), { recursive: true });
    const script = [
      `$ErrorActionPreference = 'Stop'`,
      `$node = ${psLiteral(nodePath())}`,
      `$serve = ${psLiteral(SERVE_SCRIPT)}`,
      `$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $serve + '" serve')`,
      `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
      `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3 -ExecutionTimeLimit ([TimeSpan]::Zero)`,
      `Register-ScheduledTask -TaskName ${psLiteral(windows.taskName)} -Action $action -Trigger $trigger -Settings $settings -Description 'cc-copilot proxy (GitHub Copilot to Claude Code bridge)' -Force | Out-Null`,
    ].join("\n");
    ps(script, "register scheduled task");
    windows.start();
    return windows.taskName;
  },
  uninstall() {
    ps(
      `Stop-ScheduledTask  -TaskName ${psLiteral(windows.taskName)} -ErrorAction SilentlyContinue; ` +
      `Unregister-ScheduledTask -TaskName ${psLiteral(windows.taskName)} -Confirm:$false -ErrorAction SilentlyContinue`,
      "remove scheduled task",
      { allowFail: true },
    );
  },
  start() {
    ps(`Start-ScheduledTask -TaskName ${psLiteral(windows.taskName)}`, "start scheduled task");
  },
  stop() {
    ps(`Stop-ScheduledTask -TaskName ${psLiteral(windows.taskName)}`, "stop scheduled task", { allowFail: true });
  },
  status() {
    const r = ps(
      `(Get-ScheduledTask -TaskName ${psLiteral(windows.taskName)} -ErrorAction SilentlyContinue).State`,
      "query scheduled task",
      { allowFail: true },
    );
    const state = (r.stdout || "").trim();
    return state || "not installed";
  },
};

export function getService() {
  switch (process.platform) {
    case "darwin": return macos;
    case "linux": return linux;
    case "win32": return windows;
    default: throw new Error(`unsupported platform: ${process.platform}`);
  }
}
