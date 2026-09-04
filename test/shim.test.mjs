// Unit tests for the shim's translation layer.
//
// These cover the pure Anthropic <-> Responses mapping plus the streaming
// translator and the upstream-error relay. No network: streams are simulated
// with EventEmitters and a fake ServerResponse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  resolveModel,
  normalizeSystemMessages,
  sanitizeNativeMessagesBody,
  ensureAutomaticCache,
  anthropicToResponses,
  responsesToAnthropic,
  streamResponsesToAnthropic,
  relayUpstreamError,
} from "../src/shim.mjs";

/** Minimal ServerResponse stand-in that records what was written. */
function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    headersSent: false,
    chunks: [],
    ended: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; this.headersSent = true; },
    write(c) { this.chunks.push(c); return true; },
    end(c) { if (c) this.chunks.push(c); this.ended = true; },
    get body() { return this.chunks.join(""); },
  };
}

/** Parse the SSE stream a fake res collected into [{event, data}]. */
function parseSse(body) {
  return body
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}

/* ------------------------------- resolveModel ------------------------------ */

test("resolveModel strips the [1m] suffix and discovery prefix", () => {
  assert.equal(resolveModel("claude-opus-5[1m]"), "claude-opus-5");
  assert.equal(resolveModel("anthropic-copilot-gpt-5.6-sol"), "gpt-5.6-sol");
});

test("resolveModel applies aliases, including alias values carrying [1m]", () => {
  const aliases = { opus: "claude-opus-5[1m]", "gpt-56-sol-ultra": "gpt-5.6-sol" };
  assert.equal(resolveModel("opus", aliases), "claude-opus-5");
  assert.equal(resolveModel("opus[1m]", aliases), "claude-opus-5");
  assert.equal(resolveModel("gpt-56-sol-ultra[1m]", aliases), "gpt-5.6-sol");
});

test("resolveModel passes through unknown ids and tolerates empty input", () => {
  assert.equal(resolveModel("some-model"), "some-model");
  assert.equal(resolveModel(""), "");
  assert.equal(resolveModel(null), "");
});

test("resolveModel follows a chained alias to the real model id", () => {
  // The shipped config chains: fable -> gpt-56-sol-ultra[1m] -> gpt-5.6-sol.
  const aliases = { fable: "gpt-56-sol-ultra[1m]", "gpt-56-sol-ultra": "gpt-5.6-sol" };
  assert.equal(resolveModel("fable", aliases), "gpt-5.6-sol");
  assert.equal(resolveModel("gpt-56-sol-ultra[1m]", aliases), "gpt-5.6-sol");
});

test("resolveModel does not hang on a cyclic alias config", () => {
  assert.equal(resolveModel("a", { a: "b", b: "a" }), "a");
  assert.equal(resolveModel("x", { x: "x" }), "x");
});

/* ------------------------- normalizeSystemMessages ------------------------- */

test("normalizeSystemMessages keeps trailing system content at the conversation tail", () => {
  const body = {
    system: "base",
    messages: [{ role: "user", content: "hi" }, { role: "system", content: "extra" }],
  };
  normalizeSystemMessages(body);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages.at(-1).role, "user", "must end on a user turn");
  assert.equal(body.messages.at(-1).content, "hi\n\nextra");
  assert.equal(body.system, "base");
});

test("normalizeSystemMessages preserves array content and conversation order", () => {
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: "question" }] },
      { role: "system", content: "reminder" },
      { role: "assistant", content: "answer" },
      { role: "system", content: "next reminder" },
    ],
  };
  normalizeSystemMessages(body);
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "text", text: "question" }, { type: "text", text: "reminder" }] },
    { role: "assistant", content: "answer" },
    { role: "user", content: "next reminder" },
  ]);
});

test("sanitizeNativeMessagesBody preserves supported and future fields", () => {
  const body = {
    model: "claude-opus-5",
    cache_control: { type: "ephemeral" },
    future_feature: { enabled: true },
    context_management: { edits: [] },
    output_config: { effort: "high" },
  };

  assert.deepEqual(sanitizeNativeMessagesBody(body), {
    model: "claude-opus-5",
    cache_control: { type: "ephemeral" },
    future_feature: { enabled: true },
  });
});

test("ensureAutomaticCache adds a rolling breakpoint when a slot is available", () => {
  const body = {
    system: [
      { type: "text", text: "a", cache_control: { type: "ephemeral" } },
      { type: "text", text: "b", cache_control: { type: "ephemeral" } },
      { type: "text", text: "c", cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: "hi" }],
  };

  ensureAutomaticCache(body);
  assert.deepEqual(body.cache_control, { type: "ephemeral" });
});

test("ensureAutomaticCache preserves client policy and respects the four-breakpoint limit", () => {
  const configured = { cache_control: { type: "ephemeral", ttl: "1h" } };
  ensureAutomaticCache(configured);
  assert.deepEqual(configured.cache_control, { type: "ephemeral", ttl: "1h" });

  const full = {
    system: Array.from({ length: 4 }, (_, i) => ({
      type: "text",
      text: String(i),
      cache_control: { type: "ephemeral" },
    })),
  };
  ensureAutomaticCache(full);
  assert.equal(full.cache_control, undefined);
});

/* -------------------------- anthropicToResponses --------------------------- */

test("anthropicToResponses maps system, max_tokens and temperature", () => {
  const out = anthropicToResponses(
    { system: "be brief", max_tokens: 128, temperature: 0.5, messages: [{ role: "user", content: "hi" }] },
    "gpt-5.6-sol",
  );
  assert.equal(out.instructions, "be brief");
  assert.equal(out.max_output_tokens, 128);
  assert.equal(out.temperature, 0.5);
  assert.deepEqual(out.input, [{ role: "user", content: "hi" }]);
});

test("normalized system reminders do not change Responses instructions or cache routing", () => {
  const makeBody = (reminder) => ({
    system: "stable instructions",
    messages: [
      { role: "user", content: "first turn" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "next turn" },
      { role: "system", content: reminder },
    ],
  });
  const first = makeBody("reminder one");
  const second = makeBody("reminder two");
  normalizeSystemMessages(first);
  normalizeSystemMessages(second);

  const out1 = anthropicToResponses(first, "gpt-5.6-sol");
  const out2 = anthropicToResponses(second, "gpt-5.6-sol");
  assert.equal(out1.instructions, "stable instructions");
  assert.equal(out2.instructions, "stable instructions");
  assert.equal(out1.prompt_cache_key, out2.prompt_cache_key);
  assert.equal(out1.input.at(-1).content, "next turn\n\nreminder one");
});

test("anthropicToResponses translates a full tool round-trip", () => {
  const out = anthropicToResponses({
    messages: [
      { role: "user", content: "read a file" },
      { role: "assistant", content: [
        { type: "text", text: "sure" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.txt" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "contents" }] },
    ],
  }, "gpt-5.6-sol");

  assert.deepEqual(out.input, [
    { role: "user", content: "read a file" },
    { role: "assistant", content: "sure" },
    { type: "function_call", call_id: "toolu_1", name: "Read", arguments: JSON.stringify({ path: "a.txt" }) },
    { type: "function_call_output", call_id: "toolu_1", output: "contents" },
  ]);
});

test("anthropicToResponses preserves text/tool ordering within a message", () => {
  const out = anthropicToResponses({
    messages: [{ role: "assistant", content: [
      { type: "text", text: "before" },
      { type: "tool_use", id: "t1", name: "A", input: {} },
      { type: "text", text: "after" },
    ] }],
  }, "gpt-5.6-sol");

  assert.deepEqual(out.input.map((i) => i.type ?? i.content), ["before", "function_call", "after"]);
});

test("anthropicToResponses maps tools and tool_choice", () => {
  const body = {
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "Read", description: "read", input_schema: { type: "object", properties: { p: { type: "string" } } } }],
    tool_choice: { type: "any" },
  };
  const out = anthropicToResponses(body, "gpt-5.6-sol");
  assert.deepEqual(out.tools, [{
    type: "function", name: "Read", description: "read",
    parameters: { type: "object", properties: { p: { type: "string" } } },
  }]);
  assert.equal(out.tool_choice, "required");
});

test("anthropicToResponses omits tool_choice when no tools are present", () => {
  const out = anthropicToResponses({ messages: [{ role: "user", content: "hi" }], tool_choice: { type: "any" } }, "gpt-5.6-sol");
  assert.equal(out.tools, undefined);
  assert.equal(out.tool_choice, undefined);
});

test("anthropicToResponses downgrades effort 'max' only for non-5.6 models", () => {
  const body = { messages: [{ role: "user", content: "hi" }], output_config: { effort: "max" } };
  assert.deepEqual(anthropicToResponses(body, "gpt-5.6-sol").reasoning, { effort: "max" });
  assert.deepEqual(anthropicToResponses(body, "gpt-5.5").reasoning, { effort: "xhigh" });
});

test("anthropicToResponses drops an unrecognised effort", () => {
  const body = { messages: [{ role: "user", content: "hi" }], output_config: { effort: "bogus" } };
  assert.equal(anthropicToResponses(body, "gpt-5.6-sol").reasoning, undefined);
});

/* -------------------------- responsesToAnthropic --------------------------- */

test("responsesToAnthropic maps text output", () => {
  const msg = responsesToAnthropic(
    { id: "resp_1", output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }], usage: { input_tokens: 3, output_tokens: 4 } },
    "gpt-5.6-sol",
  );
  assert.deepEqual(msg.content, [{ type: "text", text: "hello" }]);
  assert.equal(msg.stop_reason, "end_turn");
  assert.deepEqual(msg.usage, { input_tokens: 3, output_tokens: 4 });
});

test("responsesToAnthropic maps function calls to tool_use with stop_reason tool_use", () => {
  const msg = responsesToAnthropic(
    { id: "r", output: [{ type: "function_call", call_id: "c1", name: "Read", arguments: '{"path":"a"}' }] },
    "gpt-5.6-sol",
  );
  assert.deepEqual(msg.content, [{ type: "tool_use", id: "c1", name: "Read", input: { path: "a" } }]);
  assert.equal(msg.stop_reason, "tool_use");
});

test("responsesToAnthropic tolerates malformed tool arguments", () => {
  const msg = responsesToAnthropic({ id: "r", output: [{ type: "function_call", call_id: "c1", name: "Read", arguments: "{not json" }] }, "m");
  assert.deepEqual(msg.content[0].input, {});
});

test("responsesToAnthropic reports max_tokens when truncated", () => {
  const msg = responsesToAnthropic({ id: "r", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }, "m");
  assert.equal(msg.stop_reason, "max_tokens");
});

/* ----------------------- streamResponsesToAnthropic ------------------------ */

/** Drive the streaming translator over a list of [event, payload] pairs. */
function runStream(events, model = "gpt-5.6-sol") {
  const up = new EventEmitter();
  const res = fakeRes();
  streamResponsesToAnthropic(up, res, model);
  for (const [event, payload] of events) up.emit("data", `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  up.emit("end");
  return { res, events: parseSse(res.body) };
}

test("streaming emits a well-formed Anthropic event sequence for text", () => {
  const { res, events } = runStream([
    ["response.created", { response: { id: "resp_1" } }],
    ["response.output_item.added", { output_index: 0, item: { type: "message" } }],
    ["response.output_text.delta", { output_index: 0, delta: "hel" }],
    ["response.output_text.delta", { output_index: 0, delta: "lo" }],
    ["response.output_item.done", { output_index: 0 }],
    ["response.completed", { response: { usage: { input_tokens: 11, output_tokens: 2 } } }],
  ]);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(events.map((e) => e.event), [
    "message_start", "ping", "content_block_start",
    "content_block_delta", "content_block_delta", "content_block_stop",
    "message_delta", "message_stop",
  ]);
  const text = events.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text).join("");
  assert.equal(text, "hello");
});

test("streaming carries input_tokens through the final message_delta", () => {
  const { events } = runStream([
    ["response.created", { response: { id: "r" } }],
    ["response.output_item.added", { output_index: 0, item: { type: "message" } }],
    ["response.output_text.delta", { output_index: 0, delta: "x" }],
    ["response.completed", { response: { usage: { input_tokens: 42, output_tokens: 7 } } }],
  ]);
  const delta = events.find((e) => e.event === "message_delta");
  assert.deepEqual(delta.data.usage, { input_tokens: 42, output_tokens: 7 });
});

test("streaming assigns contiguous block indices, skipping reasoning items", () => {
  // Responses puts reasoning at output_index 0; the first *content* item is at 1.
  // Anthropic block indices must still start at 0 and stay contiguous.
  const { events } = runStream([
    ["response.created", { response: { id: "r" } }],
    ["response.output_item.added", { output_index: 0, item: { type: "reasoning" } }],
    ["response.output_item.added", { output_index: 1, item: { type: "message" } }],
    ["response.output_text.delta", { output_index: 1, delta: "hi" }],
    ["response.output_item.added", { output_index: 2, item: { type: "function_call", call_id: "c1", name: "Read" } }],
    ["response.function_call_arguments.delta", { output_index: 2, delta: '{"p":1}' }],
    ["response.completed", { response: {} }],
  ]);

  const starts = events.filter((e) => e.event === "content_block_start");
  assert.deepEqual(starts.map((e) => e.data.index), [0, 1]);
  assert.equal(starts[0].data.content_block.type, "text");
  assert.equal(starts[1].data.content_block.type, "tool_use");
  assert.equal(events.find((e) => e.event === "message_delta").data.delta.stop_reason, "tool_use");
});

test("streaming emits tool arguments as input_json_delta", () => {
  const { events } = runStream([
    ["response.created", { response: { id: "r" } }],
    ["response.output_item.added", { output_index: 0, item: { type: "function_call", call_id: "c1", name: "Read" } }],
    ["response.function_call_arguments.delta", { output_index: 0, delta: '{"path":' }],
    ["response.function_call_arguments.delta", { output_index: 0, delta: '"a.txt"}' }],
    ["response.completed", { response: {} }],
  ]);
  const json = events.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.partial_json).join("");
  assert.equal(json, '{"path":"a.txt"}');
});

test("streaming handles SSE frames split across chunk boundaries", () => {
  const up = new EventEmitter();
  const res = fakeRes();
  streamResponsesToAnthropic(up, res, "gpt-5.6-sol");
  up.emit("data", 'event: response.created\ndata: {"response":{"id":"r"}}\n\nevent: response.output_te');
  up.emit("data", 'xt.delta\ndata: {"output_index":0,"delta":"split"}\n\n');
  up.emit("end");
  const text = parseSse(res.body).filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text).join("");
  assert.equal(text, "split");
});

test("streaming closes any open blocks if upstream ends abruptly", () => {
  const { events } = runStream([
    ["response.created", { response: { id: "r" } }],
    ["response.output_item.added", { output_index: 0, item: { type: "message" } }],
    ["response.output_text.delta", { output_index: 0, delta: "partial" }],
  ]);
  assert.ok(events.some((e) => e.event === "content_block_stop"), "open block must be closed on end");
});

/* ---------------------------- relayUpstreamError --------------------------- */
// Regression: a non-200 upstream on a *streaming* request used to be forwarded
// into the SSE translator, which immediately wrote a 200 — turning auth and
// rate-limit failures into silently empty successful responses.

test("relayUpstreamError forwards the upstream status instead of a 200 SSE stream", () => {
  const up = new EventEmitter();
  up.statusCode = 401;
  const res = fakeRes();
  relayUpstreamError(up, res);
  up.emit("data", JSON.stringify({ error: { message: "token expired" } }));
  up.emit("end");

  assert.equal(res.statusCode, 401);
  assert.equal(res.headers["content-type"], "application/json");
  const body = JSON.parse(res.body);
  assert.equal(body.type, "error");
  assert.equal(body.error.message, "token expired");
  assert.ok(!res.body.includes("event:"), "must not emit SSE");
});

test("relayUpstreamError labels 429 as a rate_limit_error", () => {
  const up = new EventEmitter();
  up.statusCode = 429;
  const res = fakeRes();
  relayUpstreamError(up, res);
  up.emit("data", JSON.stringify({ error: { message: "slow down" } }));
  up.emit("end");
  assert.equal(JSON.parse(res.body).error.type, "rate_limit_error");
});

test("relayUpstreamError handles a non-JSON upstream body", () => {
  const up = new EventEmitter();
  up.statusCode = 502;
  const res = fakeRes();
  relayUpstreamError(up, res);
  up.emit("data", "<html>bad gateway</html>");
  up.emit("end");
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error.message, "<html>bad gateway</html>");
});

test("relayUpstreamError falls back to a status message on an empty body", () => {
  const up = new EventEmitter();
  up.statusCode = 500;
  const res = fakeRes();
  relayUpstreamError(up, res);
  up.emit("end");
  assert.equal(JSON.parse(res.body).error.message, "upstream returned 500");
});

test("streaming locks the status to 200 immediately — so the error check must run first", () => {
  // This is the invariant that made the original bug possible: the translator
  // commits a 200 before it has seen a single upstream byte. Any status check
  // therefore has to happen before streamResponsesToAnthropic is called.
  const up = new EventEmitter();
  const res = fakeRes();
  streamResponsesToAnthropic(up, res, "gpt-5.6-sol");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headersSent, true);
});
