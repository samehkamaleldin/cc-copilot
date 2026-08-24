// cc-copilot daemon — runs the full proxy stack in one process.
//
//   - spawns `copilot-api` (the GitHub Copilot auth + token provider) on apiPort
//   - waits for it to answer
//   - starts the shim HTTP server on shimPort
//   - if copilot-api dies, the daemon exits so the service manager can restart it
//
// This is what the launchd / systemd / Scheduled-Task service runs.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { createShimServer } from "./shim.mjs";
import { logDir, copilotApiEntry } from "./paths.mjs";

function ts() { return new Date().toISOString(); }

function openLog() {
  const dir = logDir();
  fs.mkdirSync(dir, { recursive: true });
  return {
    daemon: fs.createWriteStream(path.join(dir, "daemon.log"), { flags: "a" }),
    api: fs.createWriteStream(path.join(dir, "copilot-api.log"), { flags: "a" }),
    shim: fs.createWriteStream(path.join(dir, "shim.log"), { flags: "a" }),
  };
}

function waitForPort(port, timeoutMs = 40000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/v1/models", timeout: 2000 }, (res) => {
        res.destroy();
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`copilot-api not ready on :${port}`));
        else setTimeout(tick, 1000);
      });
      req.on("timeout", () => req.destroy());
    };
    tick();
  });
}

export async function runDaemon() {
  const cfg = loadConfig();
  const logs = openLog();
  const dlog = (m) => logs.daemon.write(`[${ts()}] ${m}\n`);

  dlog(`starting cc-copilot daemon (shim :${cfg.shimPort}, copilot-api :${cfg.apiPort})`);

  // 1. Spawn copilot-api by running its vendored entry point with `node`
  //    directly. This avoids launching `npx.cmd` through a shell (which, when
  //    given an args array, emits Node's DEP0190 security deprecation warning)
  //    and pins the installed version instead of re-resolving @latest.
  let apiEntry;
  try {
    apiEntry = copilotApiEntry();
  } catch (e) {
    dlog(`cannot locate copilot-api: ${e.message}`);
    process.exit(1);
  }
  const api = spawn(process.execPath, [apiEntry, "start", "--port", String(cfg.apiPort)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  api.stdout.pipe(logs.api);
  api.stderr.pipe(logs.api);

  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    dlog(`shutting down (code ${code})`);
    try { api.kill(); } catch {}
    setTimeout(() => process.exit(code), 500);
  };

  api.on("exit", (code) => {
    dlog(`copilot-api exited (code ${code}); daemon will exit for restart`);
    shutdown(1);
  });
  api.on("error", (e) => {
    dlog(`failed to spawn copilot-api: ${e.message}`);
    shutdown(1);
  });

  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));

  // 2. Wait for copilot-api, then start the shim.
  try {
    await waitForPort(cfg.apiPort);
    dlog("copilot-api is ready");
  } catch (e) {
    dlog(e.message + " — is it authenticated? run `cc-copilot auth`");
    return shutdown(1);
  }

  // The shim emits one pre-formatted (ANSI-colored) line per LLM call. Tee it
  // to both the live console and shim.log so `cc-copilot logs` stays colorful.
  const shimLog = (m) => {
    const line = m.endsWith("\n") ? m : m + "\n";
    logs.shim.write(line);
    process.stdout.write(line);
  };
  const shim = createShimServer(cfg, shimLog);
  shim.on("error", (e) => { dlog(`shim error: ${e.message}`); shutdown(1); });
  shim.listen(cfg.shimPort, "127.0.0.1", () => {
    dlog(`shim listening on http://127.0.0.1:${cfg.shimPort}`);
  });
}
