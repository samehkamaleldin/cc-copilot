#!/usr/bin/env node
// cc-copilot — CLI entry point.
//
//   cc-copilot auth        Authenticate to GitHub Copilot (one-time device flow)
//   cc-copilot install     Build Claude config + install & start the background service
//   cc-copilot uninstall   Remove the service and Claude config keys
//   cc-copilot serve       Run the proxy daemon in the foreground (used by the service)
//   cc-copilot start|stop|restart|status   Manage the background service
//   cc-copilot logs        Tail the proxy logs
//   cc-copilot doctor      Diagnose the setup
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { loadConfig } from "../src/config.mjs";
import { runDaemon } from "../src/daemon.mjs";
import { installClaudeConfig, uninstallClaudeConfig } from "../src/claude-config.mjs";
import { getService } from "../src/service.mjs";
import { logDir, npxCommand, claudeSettingsPath } from "../src/paths.mjs";

const cmd = process.argv[2];
const args = process.argv.slice(3);

function out(s = "") { process.stdout.write(s + "\n"); }
function err(s = "") { process.stderr.write(s + "\n"); }

function httpCode(port, p = "/v1/models") {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: p, timeout: 2000 }, (res) => {
      resolve(res.statusCode); res.destroy();
    });
    req.on("error", () => resolve(0));
    req.on("timeout", () => { req.destroy(); resolve(0); });
  });
}

async function doAuth() {
  out("Starting GitHub Copilot device authentication...");
  out("A code and URL will appear below — open the URL and enter the code.\n");
  const r = spawnSync(npxCommand(), ["-y", "copilot-api@latest", "auth"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  process.exit(r.status ?? 0);
}

async function doInstall() {
  const cfg = loadConfig();
  out("1/3  Writing Claude Code config (Microsoft Foundry provider mode, no login gate)...");
  const res = installClaudeConfig();
  out(`     -> ${res.path}`);
  out(`     default model: ${res.defaultModel}  (base URL http://localhost:${cfg.shimPort})`);

  out("2/3  Installing background service...");
  const svc = getService();
  const where = svc.install();
  out(`     -> ${where}`);

  out("3/3  Waiting for the proxy to come up...");
  let ok = false;
  for (let i = 0; i < 40; i++) {
    if (await httpCode(cfg.shimPort) === 200) { ok = true; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (ok) {
    out("\n✅ cc-copilot is running. Launch Claude Code with `claude` — no login needed.");
    out("   Models: /model opus | sonnet | haiku | fable");
  } else {
    err("\n⚠ Proxy did not respond yet. If you have not authenticated, run: cc-copilot auth");
    err(`   Then: cc-copilot restart   (logs: cc-copilot logs)`);
  }
}

function doUninstall() {
  out("Removing background service...");
  try { getService().uninstall(); } catch (e) { err("  service: " + e.message); }
  out("Removing Claude config keys...");
  const r = uninstallClaudeConfig();
  out(`  removed ${r.removed.length} keys from ${r.path}`);
  out("Done. (copilot-api credentials are left intact; remove them manually if desired.)");
}

async function doStatus() {
  const cfg = loadConfig();
  out("Service:");
  try { out("  " + getService().status()); } catch (e) { out("  " + e.message); }
  out("Ports:");
  out(`  copilot-api :${cfg.apiPort} -> ${await httpCode(cfg.apiPort) || "down"}`);
  out(`  shim        :${cfg.shimPort} -> ${await httpCode(cfg.shimPort) || "down"}`);
}

function doLogs() {
  const dir = logDir();
  const files = ["shim.log", "copilot-api.log", "daemon.log"].map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f));
  if (!files.length) { err(`No logs yet in ${dir}`); process.exit(1); }
  if (process.platform === "win32") {
    spawnSync("powershell", ["-Command", `Get-Content -Path ${files.map((f) => `'${f}'`).join(",")} -Tail 40 -Wait`], { stdio: "inherit" });
  } else {
    spawnSync("tail", ["-n", "40", "-f", ...files], { stdio: "inherit" });
  }
}

async function doDoctor() {
  const cfg = loadConfig();
  out("cc-copilot doctor\n");
  out(`platform        : ${process.platform} (${process.arch})`);
  out(`node            : ${process.version}`);
  const npx = spawnSync(npxCommand(), ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
  out(`npx             : ${(npx.stdout || "missing").trim()}`);
  const claude = spawnSync(process.platform === "win32" ? "claude.cmd" : "claude", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
  out(`claude code     : ${(claude.stdout || "not found on PATH").trim()}`);
  out(`claude settings : ${claudeSettingsPath()}`);
  out(`service status  : ${(() => { try { return getService().status(); } catch (e) { return e.message; } })()}`);
  out(`copilot-api :${cfg.apiPort} : ${await httpCode(cfg.apiPort) || "down"}`);
  out(`shim        :${cfg.shimPort} : ${await httpCode(cfg.shimPort) || "down"}`);
  const settingsOk = (() => { try { return JSON.parse(fs.readFileSync(claudeSettingsPath(), "utf8")).env?.CLAUDE_CODE_USE_FOUNDRY === "1"; } catch { return false; } })();
  out(`foundry config  : ${settingsOk ? "present" : "MISSING (run `cc-copilot install`)"}`);
}

function usage() {
  out(`cc-copilot — drive Claude Code with your GitHub Copilot subscription

Usage:
  cc-copilot auth        Authenticate to GitHub Copilot (one-time)
  cc-copilot install     Configure Claude Code + install & start the service
  cc-copilot uninstall   Remove the service and Claude config
  cc-copilot start       Start the background service
  cc-copilot stop        Stop the background service
  cc-copilot restart     Restart the background service
  cc-copilot status      Show service + port health
  cc-copilot logs        Tail proxy logs
  cc-copilot doctor      Diagnose the setup
  cc-copilot serve       Run the proxy in the foreground (used by the service)

Typical first run:
  cc-copilot auth && cc-copilot install`);
}

(async () => {
  try {
    switch (cmd) {
      case "auth": return void (await doAuth());
      case "install": return void (await doInstall());
      case "uninstall": return void doUninstall();
      case "serve": return void (await runDaemon());
      case "start": return void getService().start();
      case "stop": return void getService().stop();
      case "restart": getService().stop(); return void getService().start();
      case "status": return void (await doStatus());
      case "logs": return void doLogs();
      case "doctor": return void (await doDoctor());
      case "-h": case "--help": case "help": case undefined: return void usage();
      default: err(`Unknown command: ${cmd}\n`); usage(); process.exit(1);
    }
  } catch (e) {
    err("Error: " + (e?.stack || e?.message || String(e)));
    process.exit(1);
  }
})();
