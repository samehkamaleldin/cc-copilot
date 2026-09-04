# cc-copilot — Experiments & Findings

A detailed lab notebook of the investigations run against cc-copilot on this
machine, the raw measurements collected, the conclusions drawn, and the code
changes made as a result. Written so the reasoning and evidence can be audited
and reproduced.

- **Environment:** Windows, GitHub Copilot **enterprise** plan, staff/Microsoft
  account. Live cc-copilot install driven from `C:\Users\<user>\workspace\gh\cc-copilot`
  (the `bin\cc-copilot.cmd` shim points here). Data dir: `%LOCALAPPDATA%\cc-copilot`.
- **Components:** shim on `:4142`, vendored `copilot-api` on `:4141`, Claude Code
  wired via Microsoft Foundry provider mode (`CLAUDE_CODE_USE_FOUNDRY=1`).
- **Copilot API host:** `api.githubcopilot.com` (`/v1/messages`, `/v1/responses`).

> Note on identifiers below (`copilot-developer-cli`, `Ov23ctr1Udn5GokVCVJf`,
> `Iv1.b507a08c87ecfe98`): these are **public client identifiers / header
> values**, not secrets. No bearer tokens or credentials are recorded here.

---

## Table of contents

1. [How cc-copilot works (baseline understanding)](#1-how-cc-copilot-works)
2. [Experiment A — Does the integration id change billing?](#2-experiment-a--integration-id--billing)
3. [Experiment B — Is prompt/KV caching working?](#3-experiment-b--promptkv-caching)
4. [Feature — Structured telemetry & cache observability](#4-feature--structured-telemetry)
5. [Experiment C — Real cache rates from live `claude -p`](#5-experiment-c--real-cache-rates)
6. [Experiment D — Long-session rolling-cache failure](#6-experiment-d--long-session-rolling-cache-failure)
7. [Summary of code changes](#7-summary-of-code-changes)
8. [How to reproduce / monitor](#8-how-to-reproduce--monitor)

---

## 1. How cc-copilot works

Traced from source (`src/shim.mjs`, `src/daemon.mjs`, `bin/cli.mjs`, `config/models.json`).

- **Three processes:** the **daemon** spawns `copilot-api` (GitHub device auth +
  short-lived Copilot token provider, exposes `GET /token` and `GET /usage`),
  waits for `:4141`, then starts the **shim** on `:4142`.
- **The shim** speaks the Anthropic Messages API and routes each request:
  - `claude-*`  → Copilot `POST /v1/messages` (native Anthropic, no translation).
  - responses-set models (`gpt-5.5`, `gpt-5.6-sol/luna/terra`) → `POST /v1/responses`
    (translates Anthropic ⇄ OpenAI Responses, incl. SSE + tool calls).
  - anything else → `copilot-api /chat/completions` (fallback).
- **Request fix-ups:** fold synthetic `role:"system"` reminders into neighboring
  user turns without changing prompt-prefix order; strip the `[1m]` suffix;
  remove only fields Copilot is known to reject (`context_management`,
  `output_config`); add a rolling cache breakpoint for Claude models; map
  reasoning effort and a stable cache-routing key for Responses models.
- **Auth:** two credentials — a long-lived GitHub OAuth token (held by
  copilot-api) and a short-lived Copilot token the shim fetches from
  `GET /token` and sends to `api.githubcopilot.com` with editor headers.

Persistence before this work: `logs/shim.log` (one line per call), `usage.json`
(aggregate token totals), and a live `GET /stats`. **No SQLite, no per-call
store, no cache metrics.**

---

## 2. Experiment A — Integration id ↔ billing

**Question.** Requests were suspected to be billed at a higher "GitHub code chat"
rate than the Copilot CLI. Can we make cc-copilot authenticate/present as the
**Copilot CLI** to lower cost?

### A.1 Where the "vscode-chat" identity comes from

Every request was tagged as **VS Code Chat**. Found in three hardcoded spots:

| What | Location | Value |
| --- | --- | --- |
| Integration id + editor headers (token exchange & `/chat/completions`) | `node_modules/copilot-api/dist/main.js` (~L58–88) | `copilot-integration-id: vscode-chat`, `editor-version: vscode/${vsCodeVersion}`, `user-agent: GitHubCopilotChat/0.26.7`, `editor-plugin-version: copilot-chat/0.26.7`, `openai-intent: conversation-panel` |
| OAuth client id (device flow) | `copilot-api/dist/main.js:88` | `GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"` (VS Code) |
| Integration id + editor headers (direct `/v1/messages`, `/v1/responses`) | `src/shim.mjs` `COPILOT_HEADERS` | `Copilot-Integration-Id: vscode-chat`, `Editor-Version: vscode/1.126.0`, `User-Agent: GitHubCopilotChat/0.26.0` |

### A.2 Recovering the real Copilot CLI identity

The CLI's `copilot.exe` is a compressed Node SEA blob (strings not greppable).
The **model-API calls are made by a separate Rust broker**, `github.exe`
(~282 MB, at `%LOCALAPPDATA%\Programs\GitHub Copilot\github.exe`), whose string
literals **are** in plaintext. Extracted:

```
https://api.githubcopilot.com/v1/responses
Copilot-Integration-Id: copilot-developer-cli      (desktop app uses copilot-developer-app)
Editor-Version:         CopilotCLI/1.0
OAuth client-id (PKCE): Ov23ctr1Udn5GokVCVJf
  device flow scopes:   repo read:org user gist project workflow
```

### A.3 Change applied

`src/shim.mjs` `COPILOT_HEADERS` was switched to the CLI's exact minimal set:

```js
const COPILOT_HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json",
  "Editor-Version": "CopilotCLI/1.0",
  "Copilot-Integration-Id": "copilot-developer-cli",
};
```

After restart, both routes returned **HTTP 200** — Copilot accepts the CLI
integration id even though the token is minted under VS Code's OAuth app.

### A.4 Does it change billing? (A/B measurements)

**(i) Per-request price (`copilot_usage.cost_per_batch`)** — same token, same
model (`claude-haiku-4.5`), `vscode-chat` vs `copilot-developer-cli`:

| token type | cost_per_batch (per 1e6 tokens) — vscode-chat | — copilot-developer-cli |
| --- | --- | --- |
| input | 100000000000 | **100000000000** |
| output | 500000000000 | **500000000000** |
| cache_read | 10000000000 | **10000000000** |
| cache_write | 125000000000 | **125000000000** |

Byte-identical.

**(ii) Premium-credit quota** (`copilot-api GET /usage`):

```
copilot_plan: enterprise    quota_reset_date: 2026-10-01
chat                 unlimited=True  remaining=0       entitlement=0
completions          unlimited=True  remaining=0       entitlement=0
premium_interactions unlimited=False remaining=837094  entitlement=1000000  used=163411  pct=83.7
```

The model API always draws from the metered `premium_interactions` bucket.

**(iii) Credit-delta A/B** (settle-polling, 25 identical requests per arm). The
counter updates in **batches** (every few minutes), which initially produced a
misleading `vscode-chat=0 / cli=+3014` split. Interpreted correctly: the `+3014`
was a single delayed flush covering **both** arms (~50 identical requests) ≈
**60 credits/request each**, identical across integration ids.

### A.5 Conclusion (Experiment A)

**The integration id does NOT change billing.** GitHub prices by **model ×
tokens**; the integration id is only an attribution tag. The real cost drivers
are **model choice** (Claude Code defaults to Opus — high multiplier) and
**request volume**. Stored as a durable memory to avoid re-running
credit-burning tests.

> The CLI-identity header change is harmless and was kept; it does not save money.

---

## 3. Experiment B — Prompt/KV caching

**Question.** "cc-copilot may have an issue with KV cache."

### B.1 First observation — caching invisible & apparently absent

Through the shim with a `cache_control` marker on a ~2,415-token system prompt
(`claude-haiku-4.5`), two identical calls both reported:

```
input 2415 · cache_read 0 · cache_write 0
usage.cache_creation_input_tokens=0  cache_read_input_tokens=0
```

The shim's `extractUsage` only parsed `input_tokens`/`output_tokens`, so cache
activity was **never surfaced** in logs regardless of whether it happened.

### B.2 Does Copilot support caching at all? (direct tests)

Bypassing the shim, calling `api.githubcopilot.com` directly:

- **`/v1/messages` (Anthropic), ~6,000-token cached system + message breakpoint:**
  ```
  call #1: input=3  cache_write=7007  cache_read=0
  call #2: input=3  cache_write=0     cache_read=7007
  ```
  → Caching **works**. (The earlier 2,415-token miss was near/below the effective
  threshold; the `anthropic-beta: prompt-caching-...` header made no difference.)

- **`/v1/responses` (OpenAI), ~8,000-token prompt, repeated:**
  ```
  nokey#1: input=8011 cached=0
  nokey#2: input=8011 cached=7424     ← auto-caches by prefix
  key#1:   input=8011 cached=7424     ← prompt_cache_key makes the first hit immediately
  ```
  → Auto-caches; a `prompt_cache_key` improves routing/immediacy.

### B.3 Does the shim preserve caching?

Short synthetic requests initially appeared healthy:

- Native path, same ~6,000-token prompt through the shim: `cache_read=7007`.
- Responses path, repeated ~8,000-token prompt: `cached=7424`.

Long real sessions later exposed two issues that these short tests missed:

1. The native-path allow-list deleted top-level `cache_control`, disabling the
   automatic breakpoint that should advance with a growing conversation.
2. Synthetic `role:"system"` reminders were moved into the top-level system
   prompt. Because system content precedes all messages in the cache key, a
   changing reminder invalidated the conversation prefix on both native and
   Responses routes.

### B.4 Fixes applied (`src/shim.mjs`)

1. `extractUsage` now also captures `cache_read_input_tokens` /
   `cache_creation_input_tokens` (Anthropic) and `cached_tokens` (Responses).
2. `formatCallLine` shows a `⚡<read> +<write>` marker per call.
3. Non-streaming Responses branch forwards `cached_tokens` into the log usage.
4. `anthropicToResponses` adds a stable `prompt_cache_key` derived from the
   stable prefix (instructions + tool schema + first input item):
   ```js
   const seed = (out.instructions||"") + "|" + (tools?JSON.stringify(tools):"") + "|" + JSON.stringify(input[0]??"");
   out.prompt_cache_key = "ccph-" + crypto.createHash("sha256").update(seed).digest("hex").slice(0,32);
   ```
5. Native requests preserve fields by default and remove only
   `context_management` and `output_config`, instead of silently deleting
   newly supported fields.
6. Claude routes add top-level automatic caching when fewer than four explicit
   breakpoints are present.
7. Synthetic system reminders remain at their conversational position rather
   than being moved ahead of the entire message history.

### B.5 Verification (live, through the shim)

```
gpt-5.6-sol · responses · ↑8.0k            (cold)
gpt-5.6-sol · responses · ↑8.0k · ⚡7.4k    (repeat — cache read)
gpt-5.6-sol · responses · stream · ⚡7.4k   (streaming path too)
claude-haiku-4.5 · native · ↑8 · ⚡7.0k     (native path)
```

All 43 unit tests pass after the change.

---

## 4. Feature — Structured telemetry

**Question.** "Does the shim log all LLM calls to a SQLite DB? Where can I trace
all sent/received metadata and cache rates, and add telemetry?"

**Finding.** No SQLite. Only `logs/shim.log` (human line per call), `usage.json`
(aggregate totals), and live `GET /stats`. Full request/response bodies were
never persisted.

### 4.1 Added

- **Per-call JSONL telemetry** → `logs/telemetry.jsonl` (one JSON object per
  call). Fields: `ts, model, route, stream, status, ms, input, output,
  cacheRead, cacheWrite, totalNanoAiu, aiCredits, promptTokens, cacheHitPct,
  reqDollars, error, traceId`
  and a `req` shape object `{requested, messages, tools, systemChars, maxTokens,
  cacheBreakpoints, effort}`. On by default; `CC_COPILOT_TELEMETRY=0` disables;
  `CC_COPILOT_TELEMETRY_FILE` relocates.
  - `cacheHitPct` is route-aware: Anthropic reports `input` as the *non-cached*
    remainder (total = input + cacheRead); Responses reports `cacheRead` as a
    subset already inside `input`.
  - `cacheBreakpoints` counts `cache_control` markers the client sent — i.e.
    whether caching was even requested.
- **Cache rates in `/stats` and `cc-copilot cost`** (session + all-time
  `cacheRead`/`cacheWrite` and a `~N% served from cache` line).
- **Exact request cost** from Copilot's response-level
  `copilot_usage.total_nano_aiu`, rather than trying to assign delayed quota
  counter updates to individual calls:
  - `1,000,000,000 nano-AIU = 1 AI credit`
  - `100 AI credits = $1.00`
  - therefore `dollars = total_nano_aiu / 100,000,000,000`
  Human logs show both values, for example:
  `4.09 cr ($0.04) req`.
  Streaming usage is captured incrementally with bounded overlap for split
  fields. Sampling only the first/last 8 KB loses Responses billing metadata
  when it precedes a large terminal response object, producing `$— req` and
  undercounting session spend. Missing metadata remains unknown, not zero;
  monthly spend still comes from the independent quota counter.
- **Opt-in full body trace** → `logs/bodies/<ts>-<seq>-<kind>-<model>.json` when
  `CC_COPILOT_TRACE_BODIES=1` (captures the exact outgoing prompt incl.
  `prompt_cache_key`; off by default — prompts may be sensitive).

New path helpers in `src/paths.mjs`: `telemetryPath()`, `traceDir()`.

### 4.2 Verification

Example real telemetry rows:
```json
{"ts":"…","model":"claude-haiku-4.5","route":"native","stream":false,"status":200,"ms":3018,
 "input":1209,"output":15,"cacheRead":0,"cacheWrite":0,"promptTokens":1209,"cacheHitPct":0,
 "req":{"requested":"claude-haiku-4.5","messages":1,"tools":0,"systemChars":5100,"maxTokens":16,
        "cacheBreakpoints":1,"effort":null},"traceId":null}
{"ts":"…","model":"gpt-5.6-sol","route":"responses","stream":false,"status":200,"ms":1018,
 "input":8009,"output":5,"cacheRead":7424,"cacheWrite":null,"promptTokens":8009,"cacheHitPct":93,
 "req":{"requested":"gpt-56-sol","messages":1,"tools":0,"systemChars":0,"maxTokens":16,
        "cacheBreakpoints":0,"effort":null},"traceId":null}
```

`cc-copilot cost` now prints:
```
Session cache : 14,848 read · 0 write   (~46% of prompt served from cache)
All-time cache: …        read · … write (~N% cached)
```

Body-trace file confirmed (example captured request):
```json
{ "id":"…","kind":"responses","model":"gpt-5.6-sol",
  "request":{ "model":"gpt-5.6-sol","input":[{"role":"user","content":"Trace me: reply ok"}],
              "stream":false,"max_output_tokens":16,"prompt_cache_key":"ccph-0dabcffe3cfa2dba71f359ccb16fd317" } }
```

---

## 5. Experiment C — Real cache rates

**Question.** Verify real cache rates (expected ~90%).

**Method.** Instead of synthetic requests, drive **actual Claude Code** with
`claude -p` (print mode) so real traffic — with Claude Code's own
`cache_control` markers and growing context — flows through the shim, then read
`logs/telemetry.jsonl`.

### C.1 Native path — `claude -p "…list files, count them…" --model haiku`

Task triggered a tool call → 2 LLM calls:

| # | model | route | input | cacheRead | cacheWrite | hit% | breakpoints |
| - | --- | --- | --- | --- | --- | --- | --- |
| 1 | claude-haiku-4-5 | native | 10 | 0 | 21864 | 0 | 3 |
| 2 | claude-haiku-4-5 | native | 5 | 21864 | 869 | **100** | 3 |

Turn 1 **wrote** the ~21.9k-token system+tools prefix to cache; turn 2 **read**
it back → **100%**. Weighted over both: **99.9%**.

### C.2 Responses/GPT path — `claude -p "read package.json & README, summarize" --model fable`

Task triggered multiple tool calls → 4 LLM calls (`fable` → `gpt-5.6-sol`):

| # | model | route | input | cacheRead | hit% | breakpoints |
| - | --- | --- | --- | --- | --- | --- |
| 1 | gpt-5.6-sol | responses | 17798 | 0 | 0 | 3 |
| 2 | gpt-5.6-sol | responses | 17889 | 17408 | **97** | 3 |
| 3 | gpt-5.6-sol | responses | 18108 | 17408 | **96** | 3 |
| 4 | gpt-5.6-sol | responses | 20805 | 17408 | 84 | 3 |

- Cold call #1 writes the prefix (0%). Calls #2–#4 read it back.
- **Warm (steady-state) = 91.9%**; `all incl. cold = 70%` over just 4 calls
  (the single cold miss dominates a short session; amortizes to ~90%+ in real
  long sessions).
- #4 dips to 84% because the conversation grew (cached prefix stayed 17,408
  while total prompt rose to 20,805).

### C.3 Correction of an earlier synthetic result

A hand-built multi-turn **simulation** of the Responses path had shown **0%**
cache. That was a **simulation artifact** (the synthetic request shape differed
from Claude Code's real payload). The **real** `claude -p` traffic caches at
96–97% on immediate follow-ups, confirming the `prompt_cache_key` fix works in
practice. Lesson: measure with real client traffic, not reconstructions.

### C.4 Initial conclusion

Short sessions matched the ~90% expectation:

| path | model | warm (steady-state) |
| --- | --- | --- |
| native | claude-haiku | **100%** |
| responses | gpt-5.6-sol | **91.9%** |

Long sessions subsequently disproved the assumption that this behavior would
remain stable as the conversation grew. See Experiment D.

---

## 6. Experiment D — Long-session rolling-cache failure

The month-to-date dashboard showed 206.27M uncached Opus 4.8 input tokens and
only 28.87M cached tokens. Live telemetry reproduced the problem on both Opus
4.8 and Opus 5 through the shim:

```
prompt: 107K -> 250K+
cache read: fixed at ~17.7K
cache hit rate: 16% -> 7%
```

Switching the same running conversation from Opus 4.8 to Opus 5 did not help,
proving this was a shim-path problem rather than an Opus 4.8 model issue.

### D.1 Root causes

1. The native request allow-list removed top-level `cache_control`.
2. The shim moved changing system reminders to top-level `system`, invalidating
   every cache prefix after the small static system/tool section.
3. The Responses translation also appended those reminders to `instructions`,
   changing both its prompt prefix and derived `prompt_cache_key`.

### D.2 Fix and live verification

- Replaced the native allow-list with a narrow deny-list.
- Added top-level automatic caching when a breakpoint slot is available.
- Normalized system reminders before routing, retaining their conversation
  position for both native Claude and Responses/Sol paths.

Live long-session result after deployment:

| Route | Before | After |
| --- | --- | --- |
| Opus 5 native | ~240K uncached, ~17.7K cached | 2 uncached, 277,861 cached, 1,281 incremental write |
| GPT-5.6 Sol Responses | short-session cache misses varied | 26,060 input, 25,856 cached on the next growing turn |

The first request writes the rolling prefix; subsequent requests read the prior
conversation and write only the newly appended content.

---

## 7. Summary of code changes

All in the live `gh` clone (`workspace\gh\cc-copilot`); service restarted after
each; unit tests **47/47** after the final change.

| File | Change |
| --- | --- |
| `src/shim.mjs` | Identity: `COPILOT_HEADERS` → Copilot CLI (`copilot-developer-cli` / `CopilotCLI/1.0`). Caching: preserve supported/future request fields; add automatic Claude caching; retain system-reminder ordering; capture cache tokens; show `⚡` markers; add a stable Responses `prompt_cache_key`; forward non-streaming `cached_tokens`. Telemetry: JSONL sink + optional body trace; request-shape helpers; session + all-time cache totals; cache fields in `/stats`. |
| `src/paths.mjs` | New `telemetryPath()` and `traceDir()` helpers. |
| `bin/cli.mjs` | `cc-copilot cost` prints session & all-time cache read/write and a `~N% cached` line. |
| `docs/experiments-and-findings.md` | This document. |

**Environment flags introduced:**
- `CC_COPILOT_TELEMETRY=0` — disable JSONL telemetry.
- `CC_COPILOT_TELEMETRY_FILE=<path>` — relocate telemetry file.
- `CC_COPILOT_TRACE_BODIES=1` — enable full request-body traces (sensitive).

---

## 8. How to reproduce / monitor

**Watch cache rates live:**
```powershell
Get-Content "$env:LOCALAPPDATA\cc-copilot\logs\telemetry.jsonl" -Tail 50 |
  ConvertFrom-Json | Format-Table model,route,input,cacheRead,cacheHitPct
```

**Weighted cache hit rate for a set of rows:**
```powershell
$rows = Get-Content "$env:LOCALAPPDATA\cc-copilot\logs\telemetry.jsonl" |
  ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.status -eq 200 }
$tp = ($rows | Measure-Object promptTokens -Sum).Sum
$tc = ($rows | Measure-Object cacheRead   -Sum).Sum
[math]::Round(100 * $tc / $tp, 1)   # % of prompt tokens served from cache
```

**Generate real traffic:**
```powershell
cd C:\Users\<user>\workspace\gh\cc-copilot
claude -p "List the files here and count them." --model haiku     # native path
claude -p "Read package.json & README, summarize in one line." --model fable  # responses/GPT path
```

**Cost + cache summary:** `cc-copilot cost`
**Human log tail:** `cc-copilot logs`  (look for the `⚡` column)
**Aggregates JSON:** `GET http://127.0.0.1:4142/stats`

**Per-integration billing A/B (advanced, consumes credits):** capture
`copilot-api GET /usage` `premium_interactions.credits_used` before/after N
identical requests per integration id, waiting for the counter to *settle*
between arms (it flushes in multi-minute batches — do not compare short windows).

---

*Key takeaways:* (1) integration id does **not** change billing — model & token
volume do; (2) preserving prompt order and the rolling breakpoint is essential
for long sessions; (3) both native Claude and Responses/Sol now reuse growing
conversation prefixes; (4) the shim has structured, queryable per-call
telemetry with cache metrics.
