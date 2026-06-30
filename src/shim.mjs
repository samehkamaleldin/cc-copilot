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

// Reasoning efforts the Responses API accepts (max -> xhigh).
const RESPONSES_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh"]);

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((c) => (typeof c === "string" ? c : c?.text ?? "")).filter(Boolean).join("\n");
  return "";
}

function mapEffort(effort) {
  if (!effort) return null;
  if (effort === "max") return "xhigh";
  return RESPONSES_EFFORTS.has(effort) ? effort : null;
}

/**
 * Build the shim HTTP server.
 * @param {object} cfg  output of loadConfig()
 * @param {(msg:string)=>void} [log]  optional logger
 * @returns {http.Server}
 */
export function createShimServer(cfg, log = () => {}) {
  const { shimPort, apiPort, aliases, responsesApiModels, canonicalById, discoveryAllow } = cfg;

  // Resolve a model name: strip discovery prefix + [1m] suffix, apply alias,
  // then strip [1m] again (alias values like "claude-opus-4-8[1m]" carry it).
  function resolveModel(name) {
    let n = name ?? "";
    if (n.startsWith(DISCOVERY_PREFIX)) n = n.slice(DISCOVERY_PREFIX.length);
    n = n.replace(/\[1m\]$/i, "");
    n = aliases[n] ?? n;
    n = n.replace(/\[1m\]$/i, "");
    return n;
  }

  function getCopilotToken() {
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

  function hoistSystemMessages(body) {
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

  // ---- Route 1: Claude models -> Copilot /v1/messages (native) ----
  async function handleClaudeNative(body, res) {
    let token;
    try { token = await getCopilotToken(); }
    catch (e) {
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
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upReq.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "error", message: "upstream error: " + e.message } }));
    });
    upReq.end(bodyBuf);
  }

  // ---- Route 2: Responses-API models -> Copilot /v1/responses ----
  function anthropicToResponses(body, model) {
    const input = (body.messages ?? [])
      .filter((m) => m?.role !== "system")
      .map((m) => ({ role: m.role, content: extractText(m.content) }));

    const systemParts = [];
    if (body.system) systemParts.push(typeof body.system === "string" ? body.system : extractText(body.system));
    for (const m of body.messages ?? [])
      if (m?.role === "system") { const t = extractText(m.content); if (t) systemParts.push(t); }

    const out = { model, input, stream: body.stream ?? false };
    if (systemParts.length) out.instructions = systemParts.join("\n\n");
    if (body.max_tokens != null) out.max_output_tokens = body.max_tokens;
    if (body.temperature != null) out.temperature = body.temperature;
    const effort = mapEffort(body.output_config?.effort);
    if (effort) out.reasoning = { effort };
    return out;
  }

  function responsesToAnthropic(r, model) {
    const msgItem = (r.output ?? []).find((o) => o.type === "message");
    const text = msgItem?.content?.find((c) => c.type === "output_text")?.text ?? "";
    return {
      id: "msg_" + (r.id ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24),
      type: "message", role: "assistant",
      content: [{ type: "text", text }],
      model,
      stop_reason: r.status === "completed" ? "end_turn" : "stop_sequence",
      stop_sequence: null,
      usage: { input_tokens: r.usage?.input_tokens ?? 0, output_tokens: r.usage?.output_tokens ?? 0 },
    };
  }

  function streamResponsesToAnthropic(upRes, res, model) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let buf = "", eventType = null, blockOpen = false;

    upRes.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (line.startsWith("event: ")) { eventType = line.slice(7).trim(); continue; }
        if (!line.startsWith("data: ") || !eventType) continue;
        let p; try { p = JSON.parse(line.slice(6)); } catch { continue; }
        switch (eventType) {
          case "response.created": {
            const r = p.response ?? {};
            const id = "msg_" + (r.id ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
            sse("message_start", { type: "message_start", message: {
              id, type: "message", role: "assistant", content: [], model,
              stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
            sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
            sse("ping", { type: "ping" });
            blockOpen = true;
            break;
          }
          case "response.output_text.delta":
            sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p.delta ?? "" } });
            break;
          case "response.output_text.done":
            if (blockOpen) { sse("content_block_stop", { type: "content_block_stop", index: 0 }); blockOpen = false; }
            break;
          case "response.completed": {
            const r = p.response ?? {};
            if (blockOpen) { sse("content_block_stop", { type: "content_block_stop", index: 0 }); blockOpen = false; }
            sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: r.usage?.output_tokens ?? 0 } });
            sse("message_stop", { type: "message_stop" });
            break;
          }
        }
      }
    });
    upRes.on("end", () => {
      if (blockOpen) res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
      res.end();
    });
    upRes.on("error", () => res.end());
  }

  async function handleResponsesApiModel(body, res, model) {
    let token;
    try { token = await getCopilotToken(); }
    catch (e) {
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
        if (body.stream) return streamResponsesToAnthropic(upRes, res, model);
        let d = "";
        upRes.on("data", (c) => (d += c)).on("end", () => {
          try {
            const r = JSON.parse(d);
            if (upRes.statusCode !== 200) {
              res.writeHead(upRes.statusCode, { "content-type": "application/json" });
              return res.end(JSON.stringify({ error: { type: "error", message: JSON.stringify(r) } }));
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(responsesToAnthropic(r, model)));
          } catch (e) {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { type: "error", message: "parse error: " + e.message } }));
          }
        });
      },
    );
    upReq.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "error", message: "upstream error: " + e.message } }));
    });
    upReq.end(bodyBuf);
  }

  // ---- Route 3: fallback -> copilot-api /chat/completions ----
  function forwardToCopilotApi(req, outBuf, res) {
    const headers = { ...req.headers, "content-length": Buffer.byteLength(outBuf) };
    delete headers.host;
    const up = http.request(
      { host: "127.0.0.1", port: apiPort, method: req.method, path: req.url, headers },
      (upRes) => { res.writeHead(upRes.statusCode || 502, upRes.headers); upRes.pipe(res); },
    );
    up.on("error", (e) => {
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

  // ---- HTTP server ----
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let outBuf = Buffer.concat(chunks);

      if (req.method === "GET" && req.url.startsWith("/v1/models")) return handleModelsDiscovery(res);
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, shimPort, apiPort }));
      }

      if (req.method === "POST" && req.url.startsWith("/v1/messages")) {
        let body; try { body = JSON.parse(outBuf.toString("utf8")); } catch { body = null; }
        if (body) {
          body.model = resolveModel(body.model ?? "");
          const model = body.model;
          if (responsesApiModels.has(model)) { log(`${model} -> /v1/responses`); return handleResponsesApiModel(body, res, model); }
          if (/^claude-/i.test(model)) { log(`${model} -> /v1/messages (native)`); return handleClaudeNative(body, res); }
          outBuf = Buffer.from(JSON.stringify(body), "utf8");
        }
      }
      forwardToCopilotApi(req, outBuf, res);
    });
  });

  return server;
}
