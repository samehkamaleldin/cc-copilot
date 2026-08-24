// ASCII startup banner for the cc-copilot daemon.
//
// Renders the "cc-copilot" wordmark (ANSI Shadow style) plus version, runtime
// and port metadata. Colors are plain ANSI SGR codes, disabled when NO_COLOR
// is set. Kept dependency-free so the daemon can print it before anything else.

const GLYPHS = {
  c: [
    " ██████╗",
    "██╔════╝",
    "██║     ",
    "██║     ",
    "╚██████╗",
    " ╚═════╝",
  ],
  "-": [
    "        ",
    "        ",
    " █████╗ ",
    " ╚════╝ ",
    "        ",
    "        ",
  ],
  o: [
    " ██████╗ ",
    "██╔═══██╗",
    "██║   ██║",
    "██║   ██║",
    "╚██████╔╝",
    " ╚═════╝ ",
  ],
  p: [
    "██████╗ ",
    "██╔══██╗",
    "██████╔╝",
    "██╔═══╝ ",
    "██║     ",
    "╚═╝     ",
  ],
  i: [
    "██╗",
    "██║",
    "██║",
    "██║",
    "██║",
    "╚═╝",
  ],
  l: [
    "██╗     ",
    "██║     ",
    "██║     ",
    "██║     ",
    "███████╗",
    "╚══════╝",
  ],
  t: [
    "████████╗",
    "╚══██╔══╝",
    "   ██║   ",
    "   ██║   ",
    "   ██║   ",
    "   ╚═╝   ",
  ],
};

const WORD = "cc-copilot";

const A = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  cyan: "\x1b[36m", magenta: "\x1b[35m", green: "\x1b[32m",
  gray: "\x1b[90m", yellow: "\x1b[33m",
};
function color(s, ...codes) { return process.env.NO_COLOR ? String(s) : codes.join("") + s + A.reset; }

/**
 * Build the multi-line startup banner.
 * @param {{version?:string, shimPort?:number|string, apiPort?:number|string}} opts
 * @returns {string}
 */
export function renderBanner({ version, shimPort, apiPort } = {}) {
  const rows = ["", "", "", "", "", ""];
  for (const ch of WORD) {
    const g = GLYPHS[ch];
    if (!g) continue;
    for (let i = 0; i < 6; i++) rows[i] += g[i] + " ";
  }
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
  const dot = color("  ·  ", A.gray);
  const lines = [""];
  for (const r of rows) lines.push(color(r, A.cyan, A.bold));
  lines.push("");
  lines.push("  " + color("GitHub Copilot → Claude Code bridge", A.magenta, A.bold));
  lines.push("  " + [
    version ? color("v" + version, A.green, A.bold) : null,
    color("node " + process.version, A.gray),
    color(process.platform + "/" + process.arch, A.gray),
  ].filter(Boolean).join(dot));
  lines.push("  " + color("shim :" + shimPort, A.cyan) + dot + color("copilot-api :" + apiPort, A.cyan));
  lines.push("  " + color("started " + stamp, A.gray));
  lines.push("");
  return lines.join("\n");
}
