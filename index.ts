/**
 * CoralBricks Provider Extension
 *
 * Registers CoralBricks with Chat Completions (default) or opt-in Responses,
 * optionally parking Responses turns with previous_response_id (park.ts).
 * Base URL: https://inference.coralbricks.ai/v1
 *
 * Model resolution strategy: Stale-While-Revalidate
 *   1. Serve stale immediately: disk cache → embedded models.json (zero-latency)
 *   2. Revalidate in background once a key resolves: authenticated /v1/models
 *      (authoritative enabled set + per-million USD pricing)
 *      → merge with embedded → cache → hot-swap. Without a key nothing is
 *      fetched; the stale catalog serves until /login or a key appears.
 *   3. patch.json + custom-models.json applied on top of whichever source won
 *
 * Merge order: [live|cache|embedded] → apply patch.json → merge custom-models.json
 *
 * Usage:
 *   # Option 1: /login coralbricks inside pi (stores the key in auth.json), or
 *   # add to ~/.pi/agent/auth.json yourself:
 *   #   "coralbricks": { "type": "api_key", "key": "cb_your-key" }
 *
 *   # Option 2: Set as environment variable
 *   # (localterm: `localterm secret set coralbricks_api_key` exposes CORALBRICKS_API_KEY)
 *   export CORALBRICKS_API_KEY=cb_your-key
 *
 *   # Run pi with the extension
 *   pi -e /path/to/pi-coralbricks-provider
 *
 * Then use /model to select from available models
 */

import { getAgentDir, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { lazyStream, type Api, type Credential, type Model, type RefreshModelsContext } from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { clampThinkingLevel, streamOpenAICompletions, streamOpenAIResponses } from "@earendil-works/pi-ai/compat";
import { loadConfig, registerSettingsCommand } from "./settings";
import { park, planPark, withParkFallback, type ParkPlan } from "./park";
import { coralApiKeyAuth, CORALBRICKS_ENV_VAR } from "./auth";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import deprecatedData from "./deprecated-models.json" with { type: "json" };
import fs from "fs";
import path from "path";

// Types

interface JsonModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: {
    off?: string | null;
    minimal?: string | null;
    low?: string | null;
    medium?: string | null;
    high?: string | null;
    xhigh?: string | null;
    max?: string | null;
  };
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsStore?: boolean;
    supportsReasoningEffort?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    thinkingFormat?: "openai" | "zai";
    supportsStrictMode?: boolean;
    requiresReasoningContentOnAssistantMessages?: boolean;
  };
  /** Curation-only (patch.json): keep a served model out of the catalog. */
  hidden?: boolean;
}

interface PatchEntry {
  name?: string;
  hidden?: boolean;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
}

type PatchData = Record<string, PatchEntry>;

// Patch Application

function applyPatch(model: JsonModel, patch: PatchEntry): JsonModel {
  // Deep-copy nested objects: the delete branches below must not mutate the
  // caller's (embedded or cached) source data through shared references.
  const result: JsonModel = {
    ...model,
    cost: { ...model.cost },
    compat: model.compat ? { ...model.compat } : undefined,
    thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
  };

  if (patch.name !== undefined) result.name = patch.name;
  if (patch.hidden !== undefined) result.hidden = patch.hidden;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.input !== undefined) result.input = patch.input;
  if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
  if (patch.thinkingLevelMap !== undefined) result.thinkingLevelMap = patch.thinkingLevelMap as JsonModel["thinkingLevelMap"];

  if (patch.cost) {
    result.cost = {
      input: patch.cost.input ?? result.cost.input,
      output: patch.cost.output ?? result.cost.output,
      cacheRead: patch.cost.cacheRead ?? result.cost.cacheRead,
      cacheWrite: patch.cost.cacheWrite ?? result.cost.cacheWrite,
    };
  }
  if (patch.compat) {
    result.compat = { ...(result.compat || {}), ...patch.compat };
  }

  if (!result.reasoning && result.compat?.thinkingFormat) {
    delete result.compat.thinkingFormat;
  }
  if (!result.reasoning && result.thinkingLevelMap) {
    delete result.thinkingLevelMap;
  }
  if (result.compat && Object.keys(result.compat).length === 0) {
    delete result.compat;
  }

  return result;
}

/** Full pipeline: base models → patch → custom → result */
function buildModels(base: JsonModel[], custom: JsonModel[], patch: PatchData): JsonModel[] {
  const modelMap = new Map<string, JsonModel>();

  for (const model of withDeprecated(base)) {
    modelMap.set(model.id, model);
  }

  for (const [id, patchEntry] of Object.entries(patch)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patchEntry));
    }
  }

  for (const model of custom) {
    const existing = modelMap.get(model.id);
    const patchEntry = patch[model.id];
    if (existing && patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else if (existing) {
      modelMap.set(model.id, model);
    } else if (patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else {
      modelMap.set(model.id, model);
    }
  }

  // Hidden models stay out of the registered catalog — and therefore out of
  // `/model` — while `models.json` keeps mirroring what Coral serves for the key.
  return Array.from(modelMap.values())
    .filter((m) => !m.hidden)
    .map(({ hidden: _hidden, ...model }) => model);
}

// Stale-While-Revalidate Model Sync

const PROVIDER_ID = "coralbricks";
const PROVIDER_NAME = "CoralBricks";
const BASE_URL = "https://inference.coralbricks.ai/v1";
const MODELS_URL = `${BASE_URL}/models`;
const CACHE_DIR = path.join(getAgentDir(), "cache");
const CACHE_PATH = path.join(CACHE_DIR, `${PROVIDER_ID}-models.json`);
const LIVE_FETCH_TIMEOUT_MS = 8000;

// Output-token fallbacks for models whose API rows do not report a limit.
// Empty today: every served model reports max_output_tokens. Keyed by model id
// when one does not.
const DEFAULT_MAX_TOKENS: Record<string, number> = {};
const FALLBACK_MAX_TOKENS = 32768;

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Full price of a written prompt token. Since 2026-10-08 Coral states the cache write ON TOP
 * of input (/v1/models cache_write_per_m, catalog cacheWritePerM), and a written token is
 * billed input + that. pi prices a written token at cacheWrite alone, so add the two. 0 when
 * the row carries no cache-write rate. Rounded so 1.12 + 0.56 is 1.68, not 1.6800000000000002.
 */
function writtenTokenCost(input: number, cacheWriteOnTop: unknown): number {
  if (typeof cacheWriteOnTop !== "number" || !Number.isFinite(cacheWriteOnTop)) return 0;
  return Math.round((input + cacheWriteOnTop) * 1e6) / 1e6;
}

function displayName(id: string): string {
  return id
    .split(/[-_/]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Parse "1M" / "128K" / "1048576" / 1048576 into a token count. */
function parseContextWindow(value: unknown, fallback = 131072): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const match = value.trim().match(/^([\d.]+)\s*([KkMm])$/);
    if (match) {
      const n = parseFloat(match[1]);
      if (Number.isFinite(n) && n > 0) {
        return Math.round(n * (match[2].toUpperCase() === "M" ? 1024 * 1024 : 1024));
      }
    }
    const n = parseInt(value, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

function baseCompat() {
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens" as const,
  };
}

/**
 * Transform a Coral /v1/models row. Coral reports per-million USD pricing
 * (input_per_m / output_per_m / cached_input_per_m — cached reads are $0 on
 * every model — and cache_write_per_m, the cache write ON TOP of input for a
 * prompt token written to the cache), context_length, and supports_image_input.
 * pi's cacheWrite is the full price of a written token: input + cache_write_per_m.
 */
function transformApiModel(apiModel: any): JsonModel | null {
  if (!apiModel?.id) return null;
  const pricing = apiModel.pricing || {};
  const model: JsonModel = {
    id: apiModel.id,
    name: typeof apiModel.name === "string" && apiModel.name ? apiModel.name : displayName(apiModel.id),
    reasoning: false,
    input: apiModel.supports_image_input ? ["text", "image"] : ["text"],
    cost: {
      input: toNumber(pricing.input_per_m),
      output: toNumber(pricing.output_per_m),
      cacheRead: toNumber(pricing.cached_input_per_m),
      cacheWrite: writtenTokenCost(toNumber(pricing.input_per_m), pricing.cache_write_per_m),
    },
    contextWindow: parseContextWindow(apiModel.context_length),
    maxTokens: DEFAULT_MAX_TOKENS[apiModel.id] ?? FALLBACK_MAX_TOKENS,
  };
  model.compat = baseCompat();
  return model;
}

async function fetchV1Models(apiKey: string, signal?: AbortSignal): Promise<JsonModel[] | null> {
  try {
    const response = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal ? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const apiModels = Array.isArray(data) ? data : (data.data || []);
    if (!Array.isArray(apiModels) || apiModels.length === 0) return null;
    return apiModels.map(transformApiModel).filter((m): m is JsonModel => m !== null);
  } catch {
    return null;
  }
}

/**
 * Live model fetch from the authenticated /v1/models, the exact per-key enabled
 * set. Without a key there is no request: the disk cache, then the embedded
 * models.json, serve until a key resolves (/login, auth.json, the environment).
 */
async function fetchLiveModels(apiKey: string | undefined, signal?: AbortSignal): Promise<JsonModel[] | null> {
  if (!apiKey) return null;
  return fetchV1Models(apiKey, signal);
}

function loadCachedModels(): JsonModel[] | null {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function cacheModels(models: JsonModel[]): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(models, null, 2) + "\n");
  } catch {
    // Cache write failure is non-fatal
  }
}

function mergeWithEmbedded(liveModels: JsonModel[], embeddedModels: JsonModel[]): JsonModel[] {
  const embeddedMap = new Map(embeddedModels.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const result: JsonModel[] = [];
  for (const liveModel of liveModels) {
    const embedded = embeddedMap.get(liveModel.id);
    seen.add(liveModel.id);
    if (embedded) {
      // Self-heal: live API pricing is authoritative field-by-field. Prefer the
      // live cost when the API reports it (non-zero); fall back to embedded when
      // the API is silent (0). Coral reports cached_input_per_m as 0 because
      // cached reads are free, which matches the curated cacheRead: 0. A row
      // without a cache-write rate reports 0, which keeps the embedded one.
      // Curation (reasoning/input/compat/name/thinkingLevelMap/maxTokens) still wins via ...embedded.
      result.push({
        ...liveModel,
        ...embedded,
        cost: {
          input: liveModel.cost.input || embedded.cost.input,
          output: liveModel.cost.output || embedded.cost.output,
          cacheRead: liveModel.cost.cacheRead || embedded.cost.cacheRead,
          cacheWrite: liveModel.cost.cacheWrite || embedded.cost.cacheWrite,
        },
        contextWindow: liveModel.contextWindow || embedded.contextWindow,
      });
    } else {
      result.push(liveModel);
    }
  }
  // Append any embedded models that the live API didn't return
  for (const em of embeddedModels) {
    if (!seen.has(em.id)) {
      result.push(em);
    }
  }
  return result;
}

// Grace period for delisted models. When the provider API stops listing a
// model, update-models.js moves its last-known definition into
// deprecated-models.json (stamped with deprecatedAt) instead of dropping it.
// For 14 days the model keeps working here so in-flight sessions and saved
// model settings do not break; afterwards it is evicted permanently.
const DEPRECATED_MODEL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Grace-period deprecated models with deprecation metadata stripped.
function activeDeprecatedModels(entries: Record<string, JsonModel & { deprecatedAt?: string }> = deprecatedData as Record<string, JsonModel & { deprecatedAt?: string }>): JsonModel[] {
  const now = Date.now();
  const result: JsonModel[] = [];
  for (const entry of Object.values(entries)) {
    if (!entry?.id) continue;
    const removedAt = Date.parse(entry.deprecatedAt ?? "");
    if (Number.isNaN(removedAt) || now - removedAt > DEPRECATED_MODEL_TTL_MS) continue;
    const model = { ...entry } as JsonModel & { deprecatedAt?: string };
    delete model.deprecatedAt;
    result.push(model);
  }
  return result;
}

// Append grace-period deprecated models the list does not already have (live data wins).
function withDeprecated(models: JsonModel[]): JsonModel[] {
  const seen = new Set(models.map((m) => m.id));
  const extras = activeDeprecatedModels().filter((m) => !seen.has(m.id));
  return extras.length > 0 ? [...models, ...extras] : models;
}

function loadStaleModels(embeddedModels: JsonModel[]): JsonModel[] {
  const cached = loadCachedModels();
  if (!cached || cached.length === 0) return embeddedModels;

  // Merge embedded models that are missing from cache (newly added models)
  const cachedMap = new Map(cached.map((m) => [m.id, m]));
  for (const em of embeddedModels) {
    if (!cachedMap.has(em.id)) {
      cached.push(em);
    }
  }
  return cached;
}

async function revalidateModels(apiKey: string | undefined, embeddedModels: JsonModel[], signal?: AbortSignal): Promise<JsonModel[] | null> {
  const liveModels = await fetchLiveModels(apiKey, signal);
  if (!liveModels || liveModels.length === 0) return null;
  const merged = mergeWithEmbedded(liveModels, embeddedModels);
  cacheModels(merged);
  return merged;
}

/** pi-ai's clampOpenAIPromptCacheKey, inlined: Coral accepts the same field. */
function clampPromptCacheKey(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const chars = Array.from(key);
  return chars.length <= 64 ? key : chars.slice(0, 64).join("");
}

export function streamCoral(
  model: any,
  context: any,
  options?: SimpleStreamOptions,
  settings: { park?: boolean } = {},
): AssistantMessageEventStream {
  const apiKey = options?.apiKey || cachedApiKey || "";
  if (!apiKey) {
    throw new Error(
      `No API key for CoralBricks. Run /login coralbricks, add it to ` +
      `~/.pi/agent/auth.json ("coralbricks"), set CORALBRICKS_API_KEY, or use --api-key.`,
    );
  }

  // pi hands the user's thinking selection to streamSimple providers as
  // options.reasoning (a raw ThinkingLevel); streamOpenAICompletions reads
  // options.reasoningEffort, so replicate pi-ai's clamp+convert here.
  const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
  const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
  const { reasoning: _reasoning, ...streamOptions } = options ?? {};

  // Coral groups a conversation's turns by the first session id it finds: a
  // session header, else the body's prompt_cache_key. pi-ai only sends the id as
  // x-session-affinity on Chat Completions when a model opts in (forced below),
  // and omits prompt_cache_key there for every base URL but api.openai.com, so
  // send Coral's own header on both surfaces and the body key on Completions.
  const sessionId = (streamOptions as any).sessionId as string | undefined;
  const sessionHeaders = sessionId
    ? { "x-coral-session": sessionId, ...((streamOptions as any).headers ?? {}) }
    : (streamOptions as any).headers;
  const promptCacheKey = (streamOptions as any).cacheRetention === "none" ? undefined : clampPromptCacheKey(sessionId);
  const withPromptCacheKey = (params: any) => {
    if (!promptCacheKey || params?.prompt_cache_key !== undefined) return params;
    return { ...params, prompt_cache_key: promptCacheKey };
  };

  const compat = { ...model.compat, sendSessionAffinityHeaders: true };
  const streamModel = { ...model, compat };

  if (streamModel.api !== "openai-responses") {
    const onPayload = (streamOptions as any).onPayload;
    return streamOpenAICompletions(streamModel, context, {
      ...streamOptions,
      headers: sessionHeaders,
      reasoningEffort,
      apiKey,
      onPayload: async (params: any, payloadModel: any) => withPromptCacheKey((await onPayload?.(params, payloadModel)) ?? params),
    } as any);
  }
  if (!settings.park) {
    return streamOpenAIResponses(streamModel, context, { ...streamOptions, headers: sessionHeaders, reasoningEffort, apiKey } as any);
  }

  let plan: ParkPlan | undefined;
  const baseFetch = (streamOptions as any).fetch ?? ((input: any, init?: any) => globalThis.fetch(input, init));
  const stream = streamOpenAIResponses(streamModel, context, {
    ...streamOptions,
    headers: sessionHeaders,
    reasoningEffort,
    apiKey,
    fetch: withParkFallback(baseFetch, () => plan),
    onPayload: async (params: any, payloadModel: any) => {
      const replaced = await options?.onPayload?.(params, payloadModel);
      plan = planPark(withPromptCacheKey(replaced ?? params), context?.messages, model);
      return plan.params;
    },
  } as any);
  void stream.result().then((message: any) => {
    if (plan && message?.responseId && message.stopReason !== "error" && message.stopReason !== "aborted") {
      park(message.responseId, model.id, plan.input);
    }
  }, () => {});
  return stream;
}

// API Key Resolution (via ModelRegistry)

let cachedApiKey: string | undefined;
let revalidateAbort: AbortController | null = null;

async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
  cachedApiKey = (await modelRegistry.getApiKeyForProvider(PROVIDER_ID)) ?? undefined;
}

/**
 * The chat models Pi composes from a `pi.registerProvider(name, config)` catalog:
 * each row bound to this provider's id, endpoint and selected API. The native
 * registration below serves exactly these, so ids, pricing, thinking maps and
 * compat flags reach Pi unchanged.
 */
function toProviderModels(models: JsonModel[], api: Api): Model<Api>[] {
  return models.map((model) => ({ ...model, api, provider: PROVIDER_ID, baseUrl: BASE_URL, headers: undefined }) as unknown as Model<Api>);
}

/** The key a refresh should fetch with: Pi's own resolution when a session exposed it. */
async function refreshApiKey(modelRegistry: ModelRegistry | undefined, credential: Credential | undefined): Promise<string | undefined> {
  if (modelRegistry) return (await modelRegistry.getApiKeyForProvider(PROVIDER_ID)) ?? undefined;
  if (credential?.type === "api_key" && credential.key) return credential.key;
  return process.env[CORALBRICKS_ENV_VAR] || undefined;
}

// Extension Entry Point

export default function (pi: ExtensionAPI) {
  const embeddedModels = modelsData as JsonModel[];
  const customModels = customModelsData as JsonModel[];
  const patches = patchData as PatchData;

  let config = loadConfig();
  let currentModels = buildModels(loadStaleModels(embeddedModels), customModels, patches);
  const selectedApi = () => config.api === "responses" ? "openai-responses" : "openai-completions";
  let providerModels = toProviderModels(currentModels, selectedApi());

  // The key the catalog was last revalidated with (null: not yet this process).
  // Pi refreshes catalogs on startup, on /model and after /login; only a changed
  // key (a fresh /login, --api-key) or a forced refresh re-fetches /v1/models,
  // so session-start revalidation stays the one routine fetch.
  let revalidatedKey: string | undefined | null = null;
  let keySync: Promise<void> = Promise.resolve();
  let modelRegistry: ModelRegistry | undefined;

  async function refreshModels(context: RefreshModelsContext): Promise<void> {
    if (!context.allowNetwork) return;
    await keySync;
    const apiKey = await refreshApiKey(modelRegistry, context.credential);
    if (context.signal.aborted || (!context.force && apiKey === revalidatedKey)) return;
    revalidatedKey = apiKey;
    cachedApiKey = apiKey;
    revalidateAbort?.abort(); // a newer credential supersedes an in-flight session revalidation
    const freshBase = await revalidateModels(apiKey, embeddedModels, context.signal);
    if (!freshBase || context.signal.aborted) return;
    const next = buildModels(freshBase, customModels, patches);
    await context.publish({
      update: () => {
        currentModels = next;
        providerModels = toProviderModels(next, selectedApi());
      },
    });
  }

  function registerProvider() {
    providerModels = toProviderModels(currentModels, selectedApi());
    // An already-selected model may still carry the previous API. Snapshot
    // the current selection per request, without mutating that model/history.
    const stream = (model: Model<any>, context: any, options?: any) =>
      lazyStream(model, async () => streamCoral({ ...model, api: selectedApi() }, context, options, { park: config.park }));
    // Native provider (pi-ai `Provider`): the same catalog and stream as the
    // config form, plus API-key auth with a `/login coralbricks` flow.
    pi.registerProvider({
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      baseUrl: BASE_URL,
      auth: { apiKey: coralApiKeyAuth() },
      getModels: () => providerModels,
      refreshModels,
      stream,
      streamSimple: stream,
    });
  }
  registerProvider();
  registerSettingsCommand(pi, () => config, (next) => {
    config = next;
    registerProvider();
  });

  pi.on("session_start", async (_event, ctx) => {
    modelRegistry = ctx.modelRegistry;
    revalidateAbort?.abort();
    revalidateAbort = new AbortController();
    const signal = revalidateAbort.signal;
    const resolved = resolveApiKey(ctx.modelRegistry);
    keySync = resolved.then(() => { revalidatedKey = cachedApiKey; }, () => {});
    void resolved
      .then(() => revalidateModels(cachedApiKey, embeddedModels, signal))
      .then((freshBase) => {
        if (freshBase && !signal.aborted) {
          currentModels = buildModels(freshBase, customModels, patches);
          registerProvider();
        }
      })
      .catch(() => { /* Keep the stale catalog if credential resolution fails. */ });
  });

  pi.on("session_shutdown", () => {
    revalidateAbort?.abort();
  });
}

export { applyPatch, buildModels, mergeWithEmbedded, transformApiModel, activeDeprecatedModels, withDeprecated, parseContextWindow, PROVIDER_ID, BASE_URL };
