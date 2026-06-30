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

/* --------------------------- Windows (schtasks) --------------------------- */
const windows = {
  taskName: "cc-copilot",

  install() {
    // Run at logon, restart-on-failure is approximated by KeepAlive in the daemon
    // plus the task's own retry. The command launches the serve loop detached.
    const cmd = `"${nodePath()}" "${SERVE_SCRIPT}" serve`;
    sh("schtasks", [
      "/Create", "/F",
      "/SC", "ONLOGON",
      "/RL", "LIMITED",
      "/TN", windows.taskName,
      "/TR", cmd,
    ]);
    windows.start();
    return windows.taskName;
  },
  uninstall() {
    sh("schtasks", ["/End", "/TN", windows.taskName]);
    sh("schtasks", ["/Delete", "/F", "/TN", windows.taskName]);
  },
  start() { sh("schtasks", ["/Run", "/TN", windows.taskName]); },
  stop() { sh("schtasks", ["/End", "/TN", windows.taskName]); },
  status() {
    const r = sh("schtasks", ["/Query", "/TN", windows.taskName]);
    return (r.stdout || r.stderr || "unknown").trim().split("\n").pop();
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
