<div align="center">

# 🪸 pi-coralbricks-provider

**DeepSeek V4.1 Flash through [Coral Bricks](https://www.coralbricks.ai)**

_A [pi](https://github.com/earendil-works/pi-coding-agent) provider extension for Coral's OpenAI-compatible inference gateway — up to **1M context** on open models._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![npm](https://img.shields.io/npm/v/pi-coralbricks-provider)](https://www.npmjs.com/package/pi-coralbricks-provider)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![synbad](https://img.shields.io/badge/synbad-evals_passing-brightgreen)](https://github.com/synthetic-lab/synbad)

</div>

## Pi 1.0 compatibility

Tested with Pi **1.0.0**. Host-provided packages remain wildcard peers; development uses exact SDK pins.
Run `bun run test:pi` for offline manifest, catalog, lifecycle and streaming checks. To test an installed host, set `PI1_HOST_PACKAGE` to its package directory; add `PI1_HOST_ENTRY=bundle` for its bundled CLI runtime. The probe stubs all network requests and never uses a live provider endpoint.

---

## Features

- **DeepSeek V4.1 Flash** from Coral's live catalog, with reasoning
- **1M token context** with vision (image input)
- **OpenAI-compatible API** — standard `/v1/chat/completions`, streaming, and tool calling
- **Per-family thinking levels** — zai-style `thinking` control for GLM (including a *real* off switch), `reasoning_effort` for DeepSeek V4.1 Flash
- **Accurate cost tracking** — input, cache-read, cache-write and output rates come from `/v1/models` for your key and refresh at session start, so cost follows Coral's [pricing](https://www.coralbricks.ai/pricing) without stale hard-coded numbers
- **Cache-optimized pricing on demand** — toggle the `X-Coral-Pricing: cache-optimized` header with `ctrl+alt+c` or `/coralbricks-settings` (see [Cache-optimized pricing](#cache-optimized-pricing-cacheoptimized-true))
- **Self-healing model sync** — stale-while-revalidate from the authenticated `/v1/models`, hot-swapped at session start and after `/login`. Without a key it makes no network request and serves the cached or embedded catalog
- **Quiet startup sync** — startup never waits on the network, and the catalog is refreshed at most hourly, by one pi process at a time, so `/new`, `pi -p` and fan-out child agents share one cache (see [Model Sync](#model-sync))
- **Safe to install twice** — when a standalone install and a copy bundled in another Pi package (such as [pi-fabric](https://github.com/fabric-runtime/pi-fabric)) load together, only the newest copy registers the provider (see [Installed more than once](#installed-more-than-once))
- **synbad-validated** — [synbad](https://github.com/synthetic-lab/synbad) tool-calling and reasoning-parsing evals pass 13/13 in every run on GLM 5.3 in both unary and streaming modes

## Installation

### Option 1: Using `pi install` (Recommended)

Install directly from GitHub:

```bash
pi install https://github.com/Coral-Bricks-AI/pi-coralbricks-provider
```

or from npm:

```bash
pi install npm:pi-coralbricks-provider
```

Then set your API key and run pi:

```bash
# Recommended: run /login coralbricks inside pi (saves it to auth.json)
# See Authentication section below

# Or set as environment variable
export CORALBRICKS_API_KEY=cb_your-key-here

pi
```

### Option 2: Manual Clone

1. Clone this repository:
   ```bash
   git clone https://github.com/Coral-Bricks-AI/pi-coralbricks-provider.git
   cd pi-coralbricks-provider
   bun install
   ```

2. Set your Coral API key:
   ```bash
   # Recommended: run /login coralbricks inside pi (saves it to auth.json)
   # See Authentication section below

   # Or set as environment variable
   export CORALBRICKS_API_KEY=cb_your-key-here
   ```

3. Run pi with the extension:
   ```bash
   pi -e /path/to/pi-coralbricks-provider
   ```

### Installed more than once

Another Pi package can bundle this extension; [pi-fabric](https://github.com/fabric-runtime/pi-fabric) does. You can still install it yourself, for example to get a newer version first. When two or more copies load into one Pi session, the newest version registers `coralbricks`, syncs models and serves `/coralbricks-settings`. The other copies register nothing and make no requests, so `/model` lists each model once and `/v1/models` is fetched once. Copies of the same version keep the one that loaded first.

The copies find each other through a process-global registry (`Symbol.for("pi-coralbricks-provider.registry.v1")`), scoped to the Pi extension runtime through the event bus Pi shares among that runtime's extensions. The newest copy wins whichever order Pi loads them in. If it loads second, it takes over before the session starts, and Pi serves its registration because a provider registered later under the same id replaces the earlier one. Ownership never moves back, and it ends with the session, so `/reload`, `/new`, `/resume` and `/fork` start from a clean slate. Versions before 1.0.32 do not take part and always register.

## Available Models

| Model | Context | Vision | Reasoning | Input $/M | Cache Read $/M | Cache Write $/M | Output $/M |
|-------|---------|--------|-----------|-----------|-----------------|------------------|------------|
| DeepSeek V4.1 Flash Fast | 1.0M | ✅ | ✅ | $0.45 | $0.009 | $0.45 | $1.80 |
| DeepSeek V4.1 Flash Standard | 1.0M | ✅ | ✅ | $0.19 | $0.008 | $0.19 | $0.60 |

*Costs are per million tokens, from Coral's [public catalog](https://www.coralbricks.ai/api/public/models). Cache Read is the price of a cached input token; Cache Write is the full price of a prompt token Coral has not cached yet (input plus the cache-write rate), billed in place of the Input rate. Your key's `/v1/models` rates can differ under organization pricing — the extension syncs those at session start, so pi's cost tracking follows your key, not this table. Prices subject to change.*

## Usage

After loading the extension, use the `/model` command in pi to select your preferred model:

```
/model coralbricks deepseek-v4.1-flash-fast
```

Or start pi directly with a Coral model:

```bash
pi -e /path/to/pi-coralbricks-provider --model coralbricks/deepseek-v4.1-flash-fast:high
```

Thinking levels attach to the model id with `:<level>` — e.g. `:low`, `:high`, `:max`, or `:off` (GLM and DeepSeek).

## Provider Settings

Run `/coralbricks-settings` to choose the **API surface**, whether to **park
turns** (Responses only), and whether to request **cache-optimized pricing**. The searchable,
bordered settings list matches pi's settings UI; GUI/RPC clients get a selection
dialog. Changes are saved immediately and apply to the next request without a
restart, including when a CoralBricks model is already selected.

Settings live at `~/.pi/agent/extensions/coralbricks.json` (or under
`PI_CODING_AGENT_DIR` when set):

```json
{ "api": "responses", "park": false, "cacheOptimized": false, "cacheOptimizedShortcut": "ctrl+alt+c" }
```

- **`chat-completions`** (default): uses `/v1/chat/completions`; existing behavior
  is unchanged. Select this to opt back out.
- **`responses`** (opt-in): uses `/v1/responses` with pi's native text, reasoning,
  tool-call, image, usage, and cancellation handling. The same model IDs and API
  key work on both surfaces. Thinking levels map to `reasoning.effort` here.

By default, Responses requests replay the full local conversation and send
`store: false`. This integration does not use background jobs or resumable
streams. Coral's broader Responses API is documented at
[coralbricks.ai/docs](https://www.coralbricks.ai/docs).

### Parking (`"park": true`)

With parking on, every Responses request is sent with `store: true` and the
next request continues it with `previous_response_id`. pi still builds the full
transcript, but only the items after the parked response (tool results, the
next user message) go over the wire. Tools are re-sent every time because Coral
does not carry them across a chain.

A turn is chained only when the full input starts with exactly what was sent
for the parked response, followed by that response's own output. Compaction, a
model switch, an edited or branched history, or a pi restart falls back to a
full replay, and that request is parked again. If Coral no longer has the parent
(`previous_response_not_found`), the same request is re-sent once in full.
Parked ids live in memory only.

Things to know before turning it on:

- Coral keeps every parked response on its side. Deleting a parent breaks the
  chain, so the extension does not delete them.
- Coral bills a chained request as the tool definitions plus the new items. The
  first chained request in a session writes the tool block to cache once, and
  later ones read it back. With a warm cache, a 7-request tool loop cost about
  the same as a full replay on DeepSeek V4.1 Flash and about a third more on
  GLM 5.3 Flash. The parked history itself is not billed again, which matters
  when Coral evicts a long session's cache.

Live probes verified text, automatic tool calls, tool-result replay, and switching
back to Chat Completions on all current models. The gateway currently rejects
Responses requests that force a named tool (`tool_choice: {"type":"function",
"name":"..."}`); leave tool selection automatic (pi's default). Errors are surfaced
without silently falling back to a different API.

Missing, invalid, or unreadable settings default to Chat Completions. Unknown
JSON fields are preserved when toggling; malformed files must be fixed before
saving. If editing the file manually, run `/reload` to apply it.

### Cache-optimized pricing (`"cacheOptimized": true`)

With it on, every request carries `X-Coral-Pricing: cache-optimized`, on Chat
Completions and Responses, parked or not. Coral then bills the request on its
[Cache-optimized plan](https://www.coralbricks.ai/pricing): each new token pays
input plus a one-time cache write, and cached reads are $0. That suits a session
whose cache has to outlive long gaps, such as slow tool calls or many
sub-agents branching off one context.

The header only counts once CoralBricks has enabled Cache-optimized for your
organization. Until then it is ignored and the request is served and billed
Standard, never refused. Organizations that kept the earlier pricing ignore it
too. Run your workload on Standard first; the
[pricing page](https://www.coralbricks.ai/pricing) explains how to ask for
Cache-optimized.

Turn it on or off whenever you need to:

- **`ctrl+alt+c`** toggles it from the editor. Pi's `keybindings.json` does not
  cover extension shortcuts, so set `"cacheOptimizedShortcut"` in
  `coralbricks.json` to use another key, or `null` for none, then `/reload`.
- **`/coralbricks-settings`** has a *Cache-optimized pricing* row; GUI/RPC
  clients are asked after the API surface.
- **`/coralbricks-settings cache-optimized [on|off|toggle]`** sets it without a
  dialog, including from RPC and scripts.

The change is saved and applies from the next request. While it is on and a
CoralBricks model is selected, the footer shows `coral: cache-optimized`. When
`/v1/models` lists Cache-optimized prices for your key (`pricing_plans`, shown
only to enabled organizations), pi's cost tracking uses them while the header
is on, and Standard prices while it is off.

## Authentication

The Coral API key can be configured in multiple ways (resolved in this order):

1. **Runtime override** — Use the `--api-key` CLI flag
2. **`auth.json`** (recommended) — Run `/login coralbricks` inside pi and paste your key; pi saves it to `~/.pi/agent/auth.json` and refreshes the model list from the authenticated `/v1/models`. Or add it by hand:
   ```json
   { "coralbricks": { "type": "api_key", "key": "cb_your-key" } }
   ```
   The `key` field supports literal values, env var names, and shell commands (prefix with `!`). `/logout` (pick CoralBricks) removes the stored key; `CORALBRICKS_API_KEY` is left alone.
3. **Environment variable** — Set `CORALBRICKS_API_KEY`

With [localterm](https://www.npmjs.com/package/localterm), store it once and it's exposed everywhere:

```bash
localterm secret set coralbricks_api_key
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CORALBRICKS_API_KEY` | No | Your Coral API key (fallback if not in `auth.json` or `--api-key`) |
| `PI_PROVIDER_SYNC_TTL_MS` | No | Model sync freshness window in ms (default `3600000`; `0` = revalidate every session start) |

> Coral Inference is currently in a design-partner program — mint keys at [coralbricks.ai/api-keys](https://www.coralbricks.ai/api-keys). Newly-minted keys may take ~30 seconds to be honored, and `403 access_denied` means the account isn't on the allowlist yet.

## Thinking Levels

Verified against the live gateway:

| Model | Format | off | low | medium | high | max |
|-------|--------|-----|-----|--------|------|-----|
| GLM 5.3 FP4 (delisted) | `thinking: {type}` + `reasoning_effort` | ✅ | ✅ | — | ✅ | ✅ |
| GLM 5.3 Flash (retired) | `thinking: {type}` + `reasoning_effort` | ✅ | ✅ | — | ✅ | ✅ |
| DeepSeek V4.1 Flash | `reasoning_effort` | ✅ | ✅ | — | ✅ | ✅ |

- **GLM** accepts zai-style `thinking: {type: "disabled"}` on Coral — pi's *off* level turns thinking off, though a short preamble of a few dozen tokens can still appear (the upstream Z.ai API has no off at all, so this differs from the canonical Z.ai map).
- **DeepSeek V4.1 Flash** reasons only when asked: a request without `reasoning_effort`, or with `"none"`, gets no reasoning, which is what pi's *off* sends. `thinking: {type}` has no effect on this model.
- Coral streams a duplicate `reasoning` field alongside `reasoning_content`; pi dedupes these automatically.

## Compat Settings

Coral's gateway follows the OpenAI Chat Completions API:

- **`supportsStore: false`** / **`supportsDeveloperRole: false`** — all models; Coral serves open models on the classic roles.
- **`maxTokensField: "max_tokens"`** — all models.
- **`thinkingFormat: "zai"`** — GLM 5.3: `thinking: {type: "enabled"|"disabled"}` toggles reasoning, `reasoning_effort` picks the depth.
- **`thinkingFormat: "openai"`** — DeepSeek V4.1 Flash: `reasoning_effort` drives thinking depth.

### Patch Overrides & Custom Models

- **`patch.json`** — per-model overrides applied on top of `models.json` (reasoning flags, pricing corrections, compat settings, thinking level maps, `"hidden"`). One entry per model Coral serves: GLM 5.3 and DeepSeek V4.1 Flash carry the reasoning and compat settings.
- **`custom-models.json`** — full model definitions for models Coral doesn't list. Merged after patch.

Merge order: `[live|cache|embedded] → patch.json → custom-models.json`

## Inference-Quality Testing

Validated with [synbad](https://github.com/synthetic-lab/synbad) — Synthetic's tool-calling and reasoning-parsing eval suite for LLM inference providers (current 13-eval suite, `--reasoning-effort high`, five `--count 1` runs per mode on 2026-09-15, DeepSeek on 2026-09-22; a cell shows the evals that passed in every run):

| Model | Unary | Stream | Notes |
|-------|-------|--------|-------|
| GLM 5.3 FP4 (delisted) | 13/13 ✅ | 13/13 ✅ | 5/5 runs |
| GLM 5.3 Flash (retired) | 12/13 ⚠️ | 12/13 ⚠️ | `reasoning/reasoning-parsing` passes 4 of 5 runs; see below |
| GPT-OSS 120B (retired) | 12/13 ⚠️ | 12/13 ⚠️ | `tools/parallel-tool` 0 of 5 runs, before Coral retired the model |
| DeepSeek V4.1 Flash | 12/13 ⚠️ | 12/13 ⚠️ | `tools/octo-list-no-optional-args` passes 1 of 5 runs; see below |
| Kimi K3 (retired) | 13/13 ✅ | 13/13 ✅ | 5/5 runs, before Coral retired the model |
| GLM 5.2 FP4 (retired) | 15/15 ✅ | 15/15 ✅ | 15-eval suite, single run, before Coral retired the model |

The misses are model-side, not transport: gpt-oss answered "Paris and London" with one call after another instead of two parallel calls even when `parallel_tool_calls: true`, in every run; on the trivial prompt `reasoning-parsing` uses, GLM 5.3 Flash answers without a think block about one run in five, in both modes, with the answer itself unaffected; and asked to "call the list tool with no args", DeepSeek V4.1 Flash usually fills in the optional `dirPath` as `"."`.

Reproduce:

```bash
CORALBRICKS_API_KEY=cb_... node ../synbad/dist/source/index.js eval \
  --env-var CORALBRICKS_API_KEY \
  --base-url https://inference.coralbricks.ai/v1 \
  --model deepseek-v4.1-flash-fast --count 1 --reasoning-effort high
```

## Model Sync

At startup the extension serves the last catalog it cached (`~/.pi/agent/cache/coralbricks-models.json`), or the catalog embedded in the package. Once Pi resolves a key (`/login coralbricks`, `auth.json`, `--api-key` or `CORALBRICKS_API_KEY`), it refreshes from the authenticated `/v1/models` at session start and after `/login`, caches the result and swaps it in. With no key it makes no network request at all.

Startup never waits on the network: the session-start refresh runs in the background, and only when:

- a Coral API key is configured (no key, no request),
- the cache is older than 1 hour, missing or unreadable, was fetched with a different API key, or was written by a version before this sync policy, and
- no other pi process is already refreshing it (a `coralbricks-models.lock` file next to the cache).

So `/new`, `/reload`, `pi -p` and fan-out child agents share one cache instead of each calling the API; a session that skips the fetch still picks up a cache another process refreshed, and every cache write is atomic. `/login coralbricks` and a changed key always refresh, whatever the cache's age. A failed refresh is retried after 5 minutes at the earliest. `PI_PROVIDER_SYNC_TTL_MS` changes the window (`0` revalidates on every session start). Only a hash fingerprint of the key is stored (`coralbricks-models.sync.json`), never the key itself. When several copies of the extension load (see [Installed more than once](#installed-more-than-once)), only the owning copy touches the lock or the network.

## Updating Models

Run the update script to fetch the latest models from Coral's API:

```bash
export CORALBRICKS_API_KEY=cb_your-key
node scripts/update-models.js
```

This will:
1. Fetch models from `https://inference.coralbricks.ai/v1/models` (falls back to the unauthenticated [public catalog](https://www.coralbricks.ai/api/public/models) without a key)
2. Preserve existing model data (pricing, compat, thinking maps) for known models
3. Apply overrides from `patch.json`
4. Update `models.json` with your key’s rates and save public list prices separately in `public-pricing.json` for the README. If the public catalog is unavailable, keep the last public-price snapshot; without prices for every public model, leave the table unchanged.

Legacy Fast organizations retain their grandfathered rates. Coral’s [pricing page](https://www.coralbricks.ai/pricing) states that organizations created before October 16, 2026, 20:53:32 UTC keep their previous Fast pricing; Standard uses the published rates for every account. The extension follows your key’s `/v1/models` response, not the README’s public list prices.

To regenerate just the README model table from local data and the saved public-price snapshot — no API key or network access needed:

```bash
node scripts/update-models.js --readme-only
```

## Troubleshooting

| Symptom | Meaning |
|---------|---------|
| `403 access_denied` | Account not on the Coral Inference allowlist yet |
| `404 model_not_accepted` | Model id not enabled for your key |
| `401 invalid_api_key` | Re-mint at [coralbricks.ai/api-keys](https://www.coralbricks.ai/api-keys); fresh keys take ~30s to activate |
| `429 rate_limit_exceeded` | Per-key rate limit — retry with backoff |
| `502 upstream_error` / `503 backend_unconfigured` | Transient — retry |
| `504 timeout` | Sync request waited too long; re-issue smaller or use Coral's background Responses API |

## License

MIT
