// Compact startup banner for the cc-copilot daemon.
//
// A small two-line framed banner with name, version, ports, runtime and start
// time. Colors are plain ANSI SGR codes, disabled when NO_COLOR is set.

const A = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  cyan: "\x1b[36m", magenta: "\x1b[35m", green: "\x1b[32m", gray: "\x1b[90m",
};
function color(s, ...codes) { return process.env.NO_COLOR ? String(s) : codes.join("") + s + A.reset; }
function visLen(s) { return s.replace(/\x1b\[[0-9;]*m/g, "").length; }

/**
 * Build the compact startup banner.
 * @param {{version?:string, shimPort?:number|string, apiPort?:number|string}} opts
 * @returns {string}
 */
export function renderBanner({ version, shimPort, apiPort } = {}) {
  const time = new Date().toTimeString().slice(0, 8);
  const dot = color(" · ", A.gray);
  const lineA = color("cc-copilot", A.cyan, A.bold)
    + (version ? color(" v" + version, A.green, A.bold) : "")
    + dot + color("GitHub Copilot → Claude Code bridge", A.magenta);
  const lineB = color("shim :" + shimPort, A.cyan) + dot + color("copilot-api :" + apiPort, A.cyan)
    + dot + color("node " + process.version, A.gray) + dot + color(time, A.gray);

  const inner = Math.max(visLen(lineA), visLen(lineB));
  const pad = (l) => l + " ".repeat(inner - visLen(l));
  const bar = "─".repeat(inner + 2);
  const top = color("╭" + bar + "╮", A.gray);
  const bot = color("╰" + bar + "╯", A.gray);
  const mid = (l) => color("│", A.gray) + " " + pad(l) + " " + color("│", A.gray);

  return ["", top, mid(lineA), mid(lineB), bot, ""].join("\n");
}
