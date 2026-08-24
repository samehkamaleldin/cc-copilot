// cc-copilot shim — the translating proxy.
//
// Accepts Anthropic Messages API requests from Claude Code and routes each to
// the right GitHub Copilot endpoint, translating formats where needed:
//
//   Claude models  -> Copilot /v1/messages   (native Anthropic API; no translation)
//   Responses-API  -> Copilot /v1/responses   (gpt-5.5; Anthropic <-> Responses translation)
//   other models   -> copilot-api /chat/completions  (fallback via the local copilot-api)
//
// Fixes applied on the way through:
//   * trailing role:"system" messages are hoisted into the top-level system field
//     (Copilot requires the messages array to end with a user turn)
//   * the [1m] context suffix is stripped (Copilot wants the bare model id)
//   * beta/extension fields Copilot rejects (e.g. context_management, output_config)
//     are dropped on the native path
//   * reasoning effort (output_config.effort) is mapped to the Responses API
//
// Auth: the short-lived Copilot token is fetched from the local copilot-api's
// GET /token endpoint, then used directly against api.githubcopilot.com.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { usageStatePath } from "./paths.mjs";

const COPILOT_HOST = "api.githubcopilot.com";
const DISCOVERY_PREFIX = "anthropic-copilot-";

const COPILOT_HEADERS = {
  "Content-Type": "application/json",
  "Editor-Version": "vscode/1.126.0",
  "Editor-Plugin-Version": "copilot/1.256.0",
  "Copilot-Integration-Id": "vscode-chat",
  "User-Agent": "GitHubCopilotChat/0.26.0",
};

// Standard Anthropic Messages fields Copilot's /v1/messages accepts. Anything
// else (beta extensions like context_management / output_config) is dropped.
const ALLOWED_MESSAGES_FIELDS = new Set([
  "model", "messages", "system", "max_tokens", "metadata", "stop_sequences",
  "stream", "temperature", "thinking", "tool_choice", "tools", "top_k", "top_p",
]);

// Reasoning efforts accepted by current Responses API models.
const RESPONSES_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

/* --------------------------- per-call logging ---------------------------- */
// One colorful line per LLM call, metrics separated by " · ":
//   time · status · model · route · [stream] · latency · req tokens ·
//   session tokens · $/req · $/session · $/month.
// Colors are plain ANSI SGR codes (disabled when NO_COLOR is set) so they
// render both in a live terminal and via `cc-copilot logs`.
const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m",
};
const USE_COLOR = !process.env.NO_COLOR;
function paint(s, ...codes) { return USE_COLOR ? codes.join("") + s + C.reset : String(s); }

function latColor(ms) { return ms < 2000 ? C.green : ms < 10000 ? C.yellow : C.red; }

// Copilot premium-interaction credits per US dollar (100 credits = $1.00).
// Override with CC_COPILOT_CREDITS_PER_DOLLAR if your plan's rate differs.
export const CREDITS_PER_DOLLAR = Number(process.env.CC_COPILOT_CREDITS_PER_DOLLAR) || 100;
function fmtMoney(d) { return d == null ? "$—" : "$" + Number(d).toFixed(2); }

/** Compact token counts: 812 -> "812", 12_300 -> "12.3k", 3_400_000 -> "3.40M". */
function fmtCompact(n) {
  n = Number(n || 0);
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + "k";
  return (n / 1e6).toFixed(2) + "M";
}

/**
 * Pull token usage out of a response body fragment. Handles both Anthropic
 * (input_tokens / output_tokens) and OpenAI (prompt_tokens / completion_tokens)
 * shapes, and streamed bodies where the final output count appears last.
 */
export function extractUsage(text) {
  const first = /"(?:input_tokens|prompt_tokens)"\s*:\s*(\d+)/.exec(text);
  const re = /"(?:output_tokens|completion_tokens)"\s*:\s*(\d+)/g;
  let last = null, m;
  while ((m = re.exec(text))) last = m;
  return { input: first ? Number(first[1]) : null, output: last ? Number(last[1]) : null };
}

/**
 * Reduce a copilot-api /usage snapshot to the premium-interaction credit figures
 * that represent real spend. Returns null if the snapshot lacks that quota.
 */
export function summarizeQuota(snapshot) {
  const p = snapshot?.quota_snapshots?.premium_interactions;
  if (!p) return null;
  const used = p.credits_used != null
    ? p.credits_used
    : (p.entitlement != null && p.remaining != null ? p.entitlement - p.remaining : null);
  return {
    used,
    remaining: p.remaining ?? null,
    entitlement: p.entitlement ?? null,
    percentRemaining: p.percent_remaining ?? null,
    unlimited: !!p.unlimited,
    plan: snapshot?.copilot_plan ?? null,
    resetDate: snapshot?.quota_reset_date ?? null,
  };
}

/** Format a single LLM-call log line (colored unless NO_COLOR). Metrics are
 *  separated by " · " (no column padding). */
export function formatCallLine({ time, status, model, route, stream, ms, usage, error, money, sessionTokens }) {
  const SEP = paint(" · ", C.gray);
  const ok = !error && status >= 200 && status < 300;
  const statusColor = error || !status || status >= 500 ? C.red : status >= 400 ? C.yellow : C.green;
  const parts = [
    paint(time, C.gray),
    paint(`${ok ? "✓" : "✗"} ${status || "ERR"}`, statusColor, C.bold),
    paint(model || "?", C.cyan, C.bold),
    paint(route || "", C.magenta),
  ];
  if (stream) parts.push(paint("stream", C.dim));
  if (ms != null) parts.push(paint(ms + "ms", latColor(ms)));
  if (error) { parts.push(paint(error, C.red)); return parts.join(SEP); }
  // Request tokens (↑ in / ↓ out).
  if (usage && (usage.input != null || usage.output != null)) {
    parts.push(paint("↑" + fmtCompact(usage.input ?? 0), C.blue) + " " + paint("↓" + fmtCompact(usage.output ?? 0), C.green));
  }
  // Session tokens (Σ ↑ in / ↓ out).
  if (sessionTokens && (sessionTokens.input || sessionTokens.output)) {
    parts.push(paint("Σ ↑" + fmtCompact(sessionTokens.input), C.blue) + " " + paint("↓" + fmtCompact(sessionTokens.output), C.green));
  }
  // Money: this request · this session · this month (US$).
  if (money) {
    parts.push(paint(fmtMoney(money.req) + " req", C.green, C.bold));
    parts.push(paint(fmtMoney(money.session) + " ses", C.cyan));
    parts.push(paint(fmtMoney(money.monthly) + " mo", C.yellow));
  }
  return parts.join(SEP);
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((c) => (typeof c === "string" ? c : c?.text ?? "")).filter(Boolean).join("\n");
  return "";
}

function mapEffort(effort, model) {
  if (!effort) return null;
  if (effort === "max" && !model.startsWith("gpt-5.6-")) return "xhigh";
  return RESPONSES_EFFORTS.has(effort) ? effort : null;
}

// Map an Anthropic tool_choice to the Responses API equivalent.
//   {type:"auto"} -> "auto"   {type:"any"}  -> "required"
//   {type:"none"} -> "none"   {type:"tool",name} -> {type:"function",name}
function mapToolChoice(tc) {
  if (!tc) return null;
  if (typeof tc === "string") return tc;
  switch (tc.type) {
    case "auto": return "auto";
    case "any": return "required";
    case "none": return "none";
    case "tool": return tc.name ? { type: "function", name: tc.name } : "required";
    default: return null;
  }
}

// Map Anthropic tools[] -> Responses API function tools. Only custom (function)
// tools are supported: each has a name and a JSON-schema input_schema that
// becomes the function `parameters`.
function mapTools(tools) {
  if (!Array.isArray(tools)) return null;
  const fns = tools
    .filter((t) => t && typeof t.name === "string")
    .map((t) => ({
      type: "function",
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema ?? { type: "object", properties: {} },
    }));
  return fns.length ? fns : null;
}

// Derive an Anthropic stop_reason from a Responses API result.
function responsesStopReason(r, hasToolUse) {
  if (hasToolUse) return "tool_use";
  if (r?.status === "incomplete")
    return r.incomplete_details?.reason === "max_output_tokens" ? "max_tokens" : "end_turn";
  return "end_turn";
}

// Resolve a model name: strip discovery prefix + [1m] suffix, then follow the
// alias chain, stripping [1m] after each hop (alias values like
// "claude-opus-4-8[1m]" carry it). Aliases may chain — e.g.
// fable -> gpt-56-sol-ultra[1m] -> gpt-5.6-sol — so resolution repeats until it
// reaches a real model id, with a visited set guarding against a config cycle.
export function resolveModel(name, aliases = {}) {
  let n = name ?? "";
  if (n.startsWith(DISCOVERY_PREFIX)) n = n.slice(DISCOVERY_PREFIX.length);
  n = n.replace(/\[1m\]$/i, "");
  const seen = new Set();
  while (aliases[n] != null && !seen.has(n)) {
    seen.add(n);
    n = String(aliases[n]).replace(/\[1m\]$/i, "");
  }
  return n;
}

// Trailing role:"system" messages are hoisted into the top-level system field
// (Copilot requires the messages array to end with a user turn). Mutates `body`.
export function hoistSystemMessages(body) {
  if (!Array.isArray(body.messages)) return;
  const systemTexts = [];
  body.messages = body.messages.filter((m) => {
    if (m?.role !== "system") return true;
    const t = extractText(m.content);
    if (t) systemTexts.push(t);
    return false;
  });
  if (!systemTexts.length) return;
  const extra = systemTexts.join("\n\n");
  if (body.system == null) body.system = extra;
  else if (typeof body.system === "string") body.system += "\n\n" + extra;
  else if (Array.isArray(body.system)) body.system.push({ type: "text", text: extra });
  else body.system = extra;
}

// ---- Anthropic Messages -> OpenAI Responses ----
// Text turns become message items; tool_use / tool_result blocks become
// function_call / function_call_output items so multi-turn tool loops survive.
export function anthropicToResponses(body, model) {
  const input = [];
  for (const m of body.messages ?? []) {
    if (!m || m.role === "system") continue; // system handled as instructions
    const role = m.role;
    const content = m.content;

    if (typeof content === "string") {
      if (content) input.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    // Preserve intra-message ordering: flush buffered text before each
    // function_call / function_call_output item.
    let pending = "";
    const flush = () => { if (pending) { input.push({ role, content: pending }); pending = ""; } };
    const addText = (t) => { if (t) pending += (pending ? "\n" : "") + t; };

    for (const block of content) {
      if (typeof block === "string") { addText(block); continue; }
      if (!block || typeof block !== "object") continue;
      switch (block.type) {
        case "text":
          addText(block.text ?? "");
          break;
        case "tool_use":
          flush();
          input.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
          break;
        case "tool_result":
          flush();
          input.push({ type: "function_call_output", call_id: block.tool_use_id, output: extractText(block.content) });
          break;
        default:
          addText(typeof block.text === "string" ? block.text : "");
      }
    }
    flush();
  }

  const systemParts = [];
  if (body.system) systemParts.push(typeof body.system === "string" ? body.system : extractText(body.system));
  for (const m of body.messages ?? [])
    if (m?.role === "system") { const t = extractText(m.content); if (t) systemParts.push(t); }

  const out = { model, input, stream: body.stream ?? false };
  if (systemParts.length) out.instructions = systemParts.join("\n\n");
  if (body.max_tokens != null) out.max_output_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  const effort = mapEffort(body.output_config?.effort, model);
  if (effort) out.reasoning = { effort };

  // Tools: translate function tools + tool_choice (only when tools present).
  const tools = mapTools(body.tools);
  if (tools) {
    out.tools = tools;
    const tc = mapToolChoice(body.tool_choice);
    if (tc != null) out.tool_choice = tc;
  }
  return out;
}

// ---- OpenAI Responses -> Anthropic Messages ----
// message items -> text blocks; function_call items -> tool_use blocks.
export function responsesToAnthropic(r, model) {
  const content = [];
  let hasToolUse = false;
  for (const item of r.output ?? []) {
    if (item?.type === "message") {
      for (const c of item.content ?? [])
        if (c?.type === "output_text") content.push({ type: "text", text: c.text ?? "" });
    } else if (item?.type === "function_call") {
      hasToolUse = true;
      let input = {};
      try { input = item.arguments ? JSON.parse(item.arguments) : {}; } catch { input = {}; }
      content.push({ type: "tool_use", id: item.call_id || item.id, name: item.name, input });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return {
    id: "msg_" + (r.id ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24),
    type: "message", role: "assistant",
    content,
    model,
    stop_reason: responsesStopReason(r, hasToolUse),
    stop_sequence: null,
    usage: { input_tokens: r.usage?.input_tokens ?? 0, output_tokens: r.usage?.output_tokens ?? 0 },
  };
}

// Each Responses output item becomes an Anthropic content block: message ->
// text (text_delta), function_call -> tool_use (input_json_delta). Blocks open
// on output_item.added and close on output_item.done; we assign our own
// contiguous block index (reasoning items are skipped, so Responses
// output_index is not directly reusable).
export function streamResponsesToAnthropic(upRes, res, model) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let buf = "", eventType = null;
  let started = false, sawToolUse = false, outTokens = 0, inTokens = 0;
  const blocks = new Map(); // Responses output_index -> { index, closed }
  let nextIndex = 0;

  const start = (r) => {
    if (started) return;
    const id = "msg_" + ((r && r.id) || "stream").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
    sse("message_start", { type: "message_start", message: {
      id, type: "message", role: "assistant", content: [], model,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: r?.usage?.input_tokens ?? 0, output_tokens: 0 } } });
    sse("ping", { type: "ping" });
    started = true;
  };

  const open = (oi, block) => {
    if (blocks.has(oi)) return blocks.get(oi);
    const entry = { index: nextIndex++, closed: false };
    blocks.set(oi, entry);
    sse("content_block_start", { type: "content_block_start", index: entry.index, content_block: block });
    return entry;
  };

  const close = (oi) => {
    const b = blocks.get(oi);
    if (!b || b.closed) return;
    b.closed = true;
    sse("content_block_stop", { type: "content_block_stop", index: b.index });
  };

  const finish = (r) => {
    outTokens = r?.usage?.output_tokens ?? outTokens;
    // Responses reports usage only on the terminal event (message_start had
    // input_tokens:0). Carry input_tokens through the final message_delta so
    // Claude Code's context meter can track the conversation size.
    inTokens = r?.usage?.input_tokens ?? inTokens;
    for (const oi of blocks.keys()) close(oi);
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: responsesStopReason(r ?? {}, sawToolUse), stop_sequence: null },
      usage: { input_tokens: inTokens, output_tokens: outTokens },
    });
    sse("message_stop", { type: "message_stop" });
  };

  upRes.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (line.startsWith("event: ")) { eventType = line.slice(7).trim(); continue; }
      if (!line.startsWith("data: ") || !eventType) continue;
      let p; try { p = JSON.parse(line.slice(6)); } catch { continue; }
      switch (eventType) {
        case "response.created":
        case "response.in_progress":
          start(p.response);
          break;
        case "response.output_item.added": {
          start();
          const item = p.item ?? {};
          const oi = p.output_index ?? 0;
          if (item.type === "function_call") {
            sawToolUse = true;
            open(oi, { type: "tool_use", id: item.call_id || item.id || ("toolu_" + oi), name: item.name || "", input: {} });
          } else if (item.type === "message") {
            open(oi, { type: "text", text: "" });
          }
          break;
        }
        case "response.output_text.delta": {
          start();
          const b = open(p.output_index ?? 0, { type: "text", text: "" });
          sse("content_block_delta", { type: "content_block_delta", index: b.index, delta: { type: "text_delta", text: p.delta ?? "" } });
          break;
        }
        case "response.function_call_arguments.delta": {
          start();
          sawToolUse = true;
          const b = open(p.output_index ?? 0, { type: "tool_use", id: "toolu_" + (p.output_index ?? 0), name: "", input: {} });
          sse("content_block_delta", { type: "content_block_delta", index: b.index, delta: { type: "input_json_delta", partial_json: p.delta ?? "" } });
          break;
        }
        case "response.output_item.done":
          close(p.output_index ?? 0);
          break;
        case "response.completed":
        case "response.incomplete":
        case "response.failed":
          finish(p.response);
          break;
      }
    }
  });
  upRes.on("end", () => {
    if (started) for (const oi of blocks.keys()) close(oi);
    res.end();
  });
  upRes.on("error", () => res.end());
}

// Relay a non-200 upstream response as an Anthropic-shaped error.
//
// This must run BEFORE any streaming translation starts: once SSE headers are
// written the status is locked to 200, so an upstream 401/429/400 on a
// streaming request would otherwise reach the client as an empty *successful*
// response instead of a surfaced error.
export function relayUpstreamError(upRes, res) {
  let d = "";
  upRes.on("data", (c) => (d += c));
  upRes.on("end", () => {
    const status = upRes.statusCode || 502;
    let message = d.trim();
    try {
      const parsed = JSON.parse(d);
      message = parsed?.error?.message ?? parsed?.message ?? JSON.stringify(parsed);
    } catch { /* not JSON — use the raw body */ }
    if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: { type: status === 429 ? "rate_limit_error" : "api_error", message: message || `upstream returned ${status}` },
    }));
  });
  upRes.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream error: " + e.message } }));
  });
}

// Copilot tokens are opaque `key=value;...` strings carrying an `exp` (unix
// seconds). Return the absolute expiry in ms, or null if absent/unparseable.
export function tokenExpiryMs(token) {
  const m = /(?:^|;)exp=(\d+)/.exec(String(token ?? ""));
  if (!m) return null;
  const ms = Number(m[1]) * 1000;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Build the shim HTTP server.
 * @param {object} cfg  output of loadConfig()
 * @param {(msg:string)=>void} [log]  optional logger
 * @returns {http.Server}
 */
export function createShimServer(cfg, log = () => {}) {
  const { shimPort, apiPort, aliases, responsesApiModels, reasoningEffortOverrides, canonicalById, discoveryAllow } = cfg;

  // Copilot tokens live ~25 minutes. Cache until shortly before expiry so the
  // hot path skips a round trip to copilot-api on every request; concurrent
  // misses share one fetch, and any 401 drops the cache so a revoked or
  // early-expired token can't wedge the shim.
  const TOKEN_EXPIRY_MARGIN_MS = 60_000;
  const TOKEN_FALLBACK_TTL_MS = 5 * 60_000;
  let tokenCache = { value: null, expiresAt: 0 };
  let tokenInflight = null;

  function invalidateToken() { tokenCache = { value: null, expiresAt: 0 }; }

  /* ---- usage accumulation (tokens) + live credit quota ---- */

  // Persistent token totals, so cumulative figures survive daemon restarts.
  const statePath = usageStatePath();
  function loadStats() {
    try {
      const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (s && s.totals) return s;
    } catch { /* fresh start */ }
    return { since: new Date().toISOString(), totals: { requests: 0, input: 0, output: 0 }, byModel: {} };
  }
  const stats = loadStats();
  let saveTimer = null;
  function saveStatsSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { fs.writeFileSync(statePath, JSON.stringify(stats, null, 2)); } catch { /* best effort */ }
    }, 1000);
    if (saveTimer.unref) saveTimer.unref();
  }
  function recordUsage(model, usage) {
    const inp = Number(usage?.input ?? 0), out = Number(usage?.output ?? 0);
    stats.totals.requests += 1;
    stats.totals.input += inp;
    stats.totals.output += out;
    const bm = (stats.byModel[model] ||= { requests: 0, input: 0, output: 0 });
    bm.requests += 1; bm.input += inp; bm.output += out;
    saveStatsSoon();
  }

  // Live Copilot credit quota, sampled from copilot-api /usage. credits_used is
  // GitHub's authoritative running spend for this billing period (resets
  // monthly); at 100 credits = $1 it converts directly to dollars. We sample
  // just after each request finishes (throttled) so per-request deltas stay
  // reasonably live without blocking the response or hammering the API.
  const QUOTA_TTL_MS = 2_000;
  let quotaCache = { snapshot: null, fetchedAt: 0 };
  let quotaInflight = null;
  let sessionStartCredits = null; // credits_used when this proxy process started
  let lastReqCredits = null;      // credits_used at the previous logged request
  let sessionRequests = 0;        // successful calls since this proxy started
  let sessionInput = 0, sessionOutput = 0; // tokens since this proxy started
  const sessionStartAt = new Date().toISOString();
  function fetchUsage() {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: apiPort, path: "/usage", timeout: 5000 }, (r) => {
        let d = ""; r.on("data", (c) => (d += c)).on("end", () => {
          try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("usage timeout")); });
    });
  }
  // Ensure a reasonably fresh quota snapshot, coalescing concurrent callers and
  // throttling to QUOTA_TTL_MS. Never rejects — keeps the last known value.
  function ensureQuota() {
    if (Date.now() - quotaCache.fetchedAt < QUOTA_TTL_MS) return Promise.resolve();
    if (quotaInflight) return quotaInflight;
    quotaInflight = fetchUsage()
      .then((u) => {
        quotaCache = { snapshot: u, fetchedAt: Date.now() };
        const q = summarizeQuota(u);
        if (q && q.used != null && sessionStartCredits == null) {
          sessionStartCredits = q.used;
          lastReqCredits = q.used;
        }
      })
      .catch(() => { /* keep last known */ })
      .finally(() => { quotaInflight = null; });
    return quotaInflight;
  }
  // Capture the session baseline up front so per-session spend starts at $0.00.
  ensureQuota();

  // Convert the current quota snapshot into per-request / per-session / monthly
  // dollar figures. Per-request is the credit delta since the last logged call
  // (credits update server-side with slight lag, so a call's cost may land on a
  // subsequent line; the session and monthly totals stay authoritative).
  function currentMoney() {
    const q = summarizeQuota(quotaCache.snapshot);
    if (!q || q.used == null) return null;
    if (sessionStartCredits == null) { sessionStartCredits = q.used; lastReqCredits = q.used; }
    const reqDelta = Math.max(0, q.used - (lastReqCredits ?? q.used));
    lastReqCredits = q.used;
    return {
      req: reqDelta / CREDITS_PER_DOLLAR,
      session: (q.used - sessionStartCredits) / CREDITS_PER_DOLLAR,
      monthly: q.used / CREDITS_PER_DOLLAR,
    };
  }

  // Emit one formatted call line via the injected logger, folding in the
  // request's token usage (recorded for /stats) and the live dollar spend.
  async function logCall(meta) {
    if (meta.usage && !meta.error) {
      recordUsage(meta.model, meta.usage);
      sessionRequests += 1;
      sessionInput += Number(meta.usage.input ?? 0);
      sessionOutput += Number(meta.usage.output ?? 0);
    } else if (!meta.error) {
      sessionRequests += 1;
    }
    await ensureQuota();
    log(formatCallLine({
      time: new Date().toTimeString().slice(0, 8),
      ...meta,
      money: meta.error ? null : currentMoney(),
      sessionTokens: { input: sessionInput, output: sessionOutput },
    }));
  }

  // Passively sample a response stream (without consuming it) to recover token
  // usage for logging. Keeps a bounded head+tail so large bodies stay cheap.
  function tapUsage(stream) {
    const CAP = 8192;
    let head = "", tail = "";
    stream.on("data", (c) => {
      const s = c.toString("utf8");
      if (head.length < CAP) head += s.slice(0, CAP - head.length);
      tail = (tail + s).slice(-CAP);
    });
    return () => extractUsage(head + "\n" + tail);
  }

  function fetchCopilotToken() {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: apiPort, path: "/token", method: "GET" },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c)).on("end", () => {
            try { resolve(JSON.parse(d).token); }
            catch { reject(new Error("bad /token response: " + d)); }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  function getCopilotToken() {
    if (tokenCache.value && Date.now() < tokenCache.expiresAt) return Promise.resolve(tokenCache.value);
    if (tokenInflight) return tokenInflight;
    tokenInflight = fetchCopilotToken()
      .then((token) => {
        if (!token) throw new Error("copilot-api returned no token");
        const exp = tokenExpiryMs(token);
        tokenCache = {
          value: token,
          expiresAt: exp ? exp - TOKEN_EXPIRY_MARGIN_MS : Date.now() + TOKEN_FALLBACK_TTL_MS,
        };
        return token;
      })
      .finally(() => { tokenInflight = null; });
    return tokenInflight;
  }

  // ---- Route 1: Claude models -> Copilot /v1/messages (native) ----
  async function handleClaudeNative(body, res) {
    const startedAt = Date.now();
    const model = body.model, stream = !!body.stream;
    let token;
    try { token = await getCopilotToken(); }
    catch (e) {
      logCall({ status: 502, model, route: "native", stream, ms: Date.now() - startedAt, error: "token: " + e.message });
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { type: "error", message: "Copilot token error: " + e.message } }));
    }

    hoistSystemMessages(body);
    for (const k of Object.keys(body)) if (!ALLOWED_MESSAGES_FIELDS.has(k)) delete body[k];

    const bodyBuf = Buffer.from(JSON.stringify(body), "utf8");
    const upReq = https.request(
      {
        host: COPILOT_HOST, path: "/v1/messages", method: "POST",
        headers: { ...COPILOT_HEADERS, Authorization: "Bearer " + token, "Content-Length": bodyBuf.length },
      },
      (upRes) => {
        // Drop the cached token so the next request re-fetches a fresh one.
        if (upRes.statusCode === 401) invalidateToken();
        const getUsage = tapUsage(upRes);
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
        upRes.on("end", () => logCall({
          status: upRes.statusCode, model, route: "native", stream,
          ms: Date.now() - startedAt, usage: getUsage(),
        }));
      },
    );
    upReq.on("error", (e) => {
      logCall({ status: 502, model, route: "native", stream, ms: Date.now() - startedAt, error: e.message });
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "error", message: "upstream error: " + e.message } }));
    });
    upReq.end(bodyBuf);
  }

  // ---- Route 2: Responses-API models -> Copilot /v1/responses ----
  async function handleResponsesApiModel(body, res, model) {
    const startedAt = Date.now();
    const stream = !!body.stream;
    let token;
    try { token = await getCopilotToken(); }
    catch (e) {
      logCall({ status: 502, model, route: "responses", stream, ms: Date.now() - startedAt, error: "token: " + e.message });
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { type: "error", message: "Copilot token error: " + e.message } }));
    }
    const bodyBuf = Buffer.from(JSON.stringify(anthropicToResponses(body, model)), "utf8");
    const upReq = https.request(
      {
        host: COPILOT_HOST, path: "/v1/responses", method: "POST",
        headers: { ...COPILOT_HEADERS, Authorization: "Bearer " + token, "Content-Length": bodyBuf.length },
      },
      (upRes) => {
        // Surface upstream failures (401 expired token, 429 rate limit, 400 bad
        // request) before any streaming translation writes SSE headers.
        if (upRes.statusCode !== 200) {
          if (upRes.statusCode === 401) invalidateToken();
          logCall({ status: upRes.statusCode, model, route: "responses", stream, ms: Date.now() - startedAt, error: "HTTP " + upRes.statusCode });
          return relayUpstreamError(upRes, res);
        }
        if (body.stream) {
          const getUsage = tapUsage(upRes);
          upRes.on("end", () => logCall({
            status: 200, model, route: "responses", stream: true,
            ms: Date.now() - startedAt, usage: getUsage(),
          }));
          return streamResponsesToAnthropic(upRes, res, model);
        }
        let d = "";
        upRes.on("data", (c) => (d += c)).on("end", () => {
          try {
            const r = JSON.parse(d);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(responsesToAnthropic(r, model)));
            logCall({
              status: 200, model, route: "responses", stream: false, ms: Date.now() - startedAt,
              usage: { input: r.usage?.input_tokens ?? null, output: r.usage?.output_tokens ?? null },
            });
          } catch (e) {
            logCall({ status: 502, model, route: "responses", stream: false, ms: Date.now() - startedAt, error: "parse: " + e.message });
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { type: "error", message: "parse error: " + e.message } }));
          }
        });
      },
    );
    upReq.on("error", (e) => {
      logCall({ status: 502, model, route: "responses", stream, ms: Date.now() - startedAt, error: e.message });
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "error", message: "upstream error: " + e.message } }));
    });
    upReq.end(bodyBuf);
  }

  // ---- Route 3: fallback -> copilot-api /chat/completions ----
  function forwardToCopilotApi(req, outBuf, res, meta) {
    const startedAt = Date.now();
    const headers = { ...req.headers, "content-length": Buffer.byteLength(outBuf) };
    delete headers.host;
    const up = http.request(
      { host: "127.0.0.1", port: apiPort, method: req.method, path: req.url, headers },
      (upRes) => {
        const getUsage = meta ? tapUsage(upRes) : null;
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
        if (meta) upRes.on("end", () => logCall({
          status: upRes.statusCode, model: meta.model, route: "proxy", stream: meta.stream,
          ms: Date.now() - startedAt, usage: getUsage(),
        }));
      },
    );
    up.on("error", (e) => {
      if (meta) logCall({ status: 502, model: meta.model, route: "proxy", stream: meta.stream, ms: Date.now() - startedAt, error: e.message });
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("shim upstream error: " + e.message);
    });
    up.end(outBuf);
  }

  // ---- Discovery: GET /v1/models ----
  function fetchCopilotApiModels() {
    return new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: apiPort, path: "/v1/models" }, (r) => {
        let d = ""; r.on("data", (c) => (d += c)).on("end", () => {
          try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
        });
      }).on("error", reject);
    });
  }

  async function handleModelsDiscovery(res) {
    let upstream;
    try { upstream = await fetchCopilotApiModels(); }
    catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "models fetch failed: " + e.message } }));
    }
    const data = [];
    for (const m of upstream.data ?? []) {
      if (!m.id || !discoveryAllow.has(m.id)) continue;
      const canonical = canonicalById[m.id] ?? m.id;
      const name = m.display_name || canonical;
      if (/^(claude|anthropic)/i.test(canonical)) data.push({ ...m, id: canonical, display_name: name });
      else data.push({ ...m, id: DISCOVERY_PREFIX + canonical, display_name: name + " · Copilot" });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data }));
  }

  // ---- Usage/cost: GET /stats ----
  // Accumulated token totals (local, exact) plus the live Copilot credit quota
  // (real spend this billing period). Refreshes the quota inline, best-effort.
  async function handleStats(res) {
    await ensureQuota();
    const q = summarizeQuota(quotaCache.snapshot);
    const money = q && q.used != null ? {
      creditsPerDollar: CREDITS_PER_DOLLAR,
      monthly: q.used / CREDITS_PER_DOLLAR,
      session: sessionStartCredits != null ? (q.used - sessionStartCredits) / CREDITS_PER_DOLLAR : null,
      remaining: q.remaining != null ? q.remaining / CREDITS_PER_DOLLAR : null,
      entitlement: q.entitlement != null ? q.entitlement / CREDITS_PER_DOLLAR : null,
    } : null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      quota: q,
      money,
      session: {
        since: sessionStartAt,
        requests: sessionRequests,
        dollars: money ? money.session : null,
        inputTokens: sessionInput,
        outputTokens: sessionOutput,
      },
      allTime: { since: stats.since, totals: stats.totals, byModel: stats.byModel },
      quotaFetchedAt: quotaCache.fetchedAt ? new Date(quotaCache.fetchedAt).toISOString() : null,
    }));
  }

  // ---- HTTP server ----
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let outBuf = Buffer.concat(chunks);

      if (req.method === "GET" && req.url.startsWith("/v1/models")) return handleModelsDiscovery(res);
      if (req.method === "GET" && req.url.startsWith("/stats")) return handleStats(res);
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, shimPort, apiPort }));
      }

      if (req.method === "POST" && req.url.startsWith("/v1/messages")) {
        let body; try { body = JSON.parse(outBuf.toString("utf8")); } catch { body = null; }
        if (body) {
          const requestedModel = (body.model ?? "").replace(/\[1m\]$/i, "");
          const effortOverride = reasoningEffortOverrides[requestedModel];
          body.model = resolveModel(body.model ?? "", aliases);
          if (effortOverride) body.output_config = { ...(body.output_config || {}), effort: effortOverride };
          const model = body.model;
          if (responsesApiModels.has(model)) return handleResponsesApiModel(body, res, model);
          if (/^claude-/i.test(model)) return handleClaudeNative(body, res);
          outBuf = Buffer.from(JSON.stringify(body), "utf8");
          return forwardToCopilotApi(req, outBuf, res, { model, stream: !!body.stream });
        }
      }
      forwardToCopilotApi(req, outBuf, res);
    });
  });

  return server;
}
