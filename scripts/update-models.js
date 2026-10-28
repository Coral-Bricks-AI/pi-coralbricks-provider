#!/usr/bin/env node
/**
 * Update CoralBricks models from API
 *
 * Fetches models and updates:
 * - models.json: Provider model definitions (enriched with pricing & compat)
 * - README.md: Model table in the Available Models section
 *
 * Sources, in order:
 * 1. Authenticated https://inference.coralbricks.ai/v1/models — the authoritative
 *    per-key enabled set, with per-million USD pricing (input_per_m / output_per_m /
 *    cached_input_per_m), context_length, supports_image_input. These are the key's
 *    own rates: an organization can hold custom pricing.
 * 2. Unauthenticated public catalog https://www.coralbricks.ai/api/public/models —
 *    same control-plane data without a key (contextWindow like "1M", inputPerM,
 *    outputPerM, cacheReadPerM). Used when no key is configured or /v1/models fails.
 *
 * models.json carries the rates used for cost tracking. The README table is
 * rendered from the PUBLIC list prices instead, so it matches the page it links
 * to; your key's /v1/models rates replace them at runtime.
 *
 * The catalog is a subset: it lists each model's canonical slug, not every
 * variant enabled for a key, so a catalog run only ever adds or keeps models —
 * it never delists one (see keepUnlistedModels).
 *
 * models.json is the source of truth for curated specs — the script preserves
 * existing data and only adds new models with API-derived defaults.
 * Curate models.json manually after new model discovery.
 *
 * patch.json and custom-models.json are applied at runtime by the provider.
 * They are NOT baked into models.json, but ARE used to generate the README table.
 *
 * API key: the stored `coralbricks` credential in ~/.pi/agent/auth.json wins, then
 * the CORALBRICKS_API_KEY environment variable (localterm:
 * `localterm secret set coralbricks_api_key`).
 */

import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// pi's agent directory: PI_CODING_AGENT_DIR (with ~ expansion) or ~/.pi/agent.
function piAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    return envDir.startsWith('~/') || envDir === '~'
      ? path.join(os.homedir(), envDir.slice(1))
      : envDir;
  }
  return path.join(os.homedir(), '.pi', 'agent');
}

const AUTH_JSON_PATH = path.join(piAgentDir(), 'auth.json');

/**
 * Resolve a configured value using pi's semantics (resolve-config-value.ts in
 * pi-mono): "!command" runs via the shell (10s timeout) and uses trimmed
 * stdout; "$VAR" / "${VAR}" interpolate environment variables ("$$" escapes a
 * literal "$", "$!" a literal "!"); anything else is a literal. Returns
 * undefined when a referenced env var is unset or a command fails.
 */
function resolveConfigValue(config, env) {
  if (typeof config !== 'string' || config.length === 0) return undefined;
  if (config.startsWith('!')) {
    try {
      const out = execSync(config.slice(1), {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  let resolved = '';
  let index = 0;
  while (index < config.length) {
    const dollar = config.indexOf('$', index);
    if (dollar < 0) {
      resolved += config.slice(index);
      break;
    }
    resolved += config.slice(index, dollar);
    const next = config[dollar + 1];
    let name;
    if (next === '$' || next === '!') {
      resolved += next;
      index = dollar + 2;
      continue;
    } else if (next === '{') {
      const end = config.indexOf('}', dollar + 2);
      if (end < 0) {
        resolved += '$';
        index = dollar + 1;
        continue;
      }
      const inner = config.slice(dollar + 2, end);
      if (!ENV_NAME_RE.test(inner)) {
        resolved += config.slice(dollar, end + 1);
        index = end + 1;
        continue;
      }
      name = inner;
      index = end + 1;
    } else {
      const match = config.slice(dollar + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (!match) {
        resolved += '$';
        index = dollar + 1;
        continue;
      }
      name = match[0];
      index = dollar + 1 + name.length;
    }
    const value = (env && env[name]) || process.env[name] || undefined;
    if (value === undefined) return undefined;
    resolved += value;
  }
  return resolved;
}

/**
 * The API key, resolved the way pi itself resolves it for this provider: the
 * stored `coralbricks` credential in ~/.pi/agent/auth.json wins, then
 * the CORALBRICKS_API_KEY environment variable.
 */
function resolveApiKey() {
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_JSON_PATH, 'utf8'));
    const credential = auth?.coralbricks;
    if (credential && credential.type === 'api_key' && typeof credential.key === 'string') {
      const key = resolveConfigValue(credential.key, credential.env);
      if (key) return key;
    }
  } catch {
    // Missing or unparseable auth.json: fall through to the env var.
  }
  return process.env.CORALBRICKS_API_KEY || undefined;
}

const MODELS_API_URL = 'https://inference.coralbricks.ai/v1/models';
const CHAT_COMPLETIONS_URL = 'https://inference.coralbricks.ai/v1/chat/completions';
const PUBLIC_CATALOG_URL = 'https://www.coralbricks.ai/api/public/models';
const MODELS_JSON_PATH = path.join(__dirname, '..', 'models.json');
const PATCH_JSON_PATH = path.join(__dirname, '..', 'patch.json');
const CUSTOM_MODELS_JSON_PATH = path.join(__dirname, '..', 'custom-models.json');
const README_PATH = path.join(__dirname, '..', 'README.md');
const PUBLIC_PRICING_JSON_PATH = path.join(__dirname, '..', 'public-pricing.json');
const PUBLIC_CATALOG_TIMEOUT_MS = 10000;

// Output-token fallbacks for models whose API rows do not report a limit.
const DEFAULT_MAX_TOKENS = {};   // per-id output-token fallbacks; empty while every served model reports one
const FALLBACK_MAX_TOKENS = 32768;

// Helpers

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  console.log(`✓ Saved ${path.basename(filePath)}`);
}

// Coral states the cache write ON TOP of input (2026-10-08); pi's cacheWrite is the full
// price of a written token, input + it. 0 when the row has no cache-write rate.
function writtenTokenCost(input, cacheWriteOnTop) {
  if (typeof cacheWriteOnTop !== 'number' || !Number.isFinite(cacheWriteOnTop)) return 0;
  return Math.round((input + cacheWriteOnTop) * 1e6) / 1e6;
}

function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function generateDisplayName(id) {
  return id
    .split(/[-_/]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Parse "1M" / "128K" / "1048576" / 1048576 into a token count. */
function parseContextWindow(value, fallback = 131072) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const match = value.trim().match(/^([\d.]+)\s*([KkMm])$/);
    if (match) {
      const n = parseFloat(match[1]);
      if (Number.isFinite(n) && n > 0) {
        return Math.round(n * (match[2].toUpperCase() === 'M' ? 1024 * 1024 : 1024));
      }
    }
    const n = parseInt(value, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

// API fetch

async function fetchV1Models(apiKey) {
  console.log(`Fetching models from ${MODELS_API_URL}...`);
  const response = await fetch(MODELS_API_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  const models = data.data || [];
  console.log(`✓ Fetched ${models.length} models from API`);
  return models;
}

async function fetchPublicCatalog() {
  console.log(`Fetching public catalog from ${PUBLIC_CATALOG_URL}...`);
  const response = await fetch(PUBLIC_CATALOG_URL, { signal: AbortSignal.timeout(PUBLIC_CATALOG_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  const models = data.models || [];
  console.log(`✓ Fetched ${models.length} models from public catalog`);
  return models;
}

/** Reject incomplete prices instead of silently turning absent fields into free tokens. */
function isListPrice(rate) {
  return rate && ['input', 'output', 'cacheRead', 'cacheWrite'].every(
    (key) => typeof rate[key] === 'number' && Number.isFinite(rate[key]) && rate[key] >= 0
  );
}

/** Local-only unless refresh is explicit; never falls back to per-key models.json prices. */
async function loadPublicListPricing({ refresh = false, catalog, snapshotPath = PUBLIC_PRICING_JSON_PATH } = {}) {
  const saved = loadJson(snapshotPath);
  const entries = saved && typeof saved === 'object' && !Array.isArray(saved) ? Object.entries(saved) : [];
  const cached = entries.length > 0 && entries.every(([, rate]) => isListPrice(rate)) ? new Map(entries) : null;
  if (!refresh) return cached;

  try {
    const rows = catalog ?? await fetchPublicCatalog();
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('empty public catalog');
    const prices = new Map(cached);
    for (const entry of rows) {
      if (!entry || typeof entry.slug !== 'string' || !entry.slug ||
          ![entry.inputPerM, entry.outputPerM, entry.cacheReadPerM, entry.cacheWritePerM].every(
            (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
          )) throw new Error('incomplete public catalog pricing');
      prices.set(entry.slug, {
        input: entry.inputPerM,
        output: entry.outputPerM,
        cacheRead: entry.cacheReadPerM,
        cacheWrite: writtenTokenCost(entry.inputPerM, entry.cacheWritePerM),
      });
    }
    saveJson(snapshotPath, Object.fromEntries([...prices].sort(([a], [b]) => a.localeCompare(b))));
    return prices;
  } catch (error) {
    console.warn(`⚠ Public catalog unavailable (${error.message}); keeping the last public-price snapshot`);
    return cached;
  }
}

/** Only explicitly curated custom models may use a price absent from the public snapshot. */
function applyListPricing(models, prices, customModels = []) {
  const customIds = new Set(Array.isArray(customModels) ? customModels.map((m) => m.id) : []);
  if (models.some((model) => !prices?.has(model.id) && !customIds.has(model.id))) {
    console.warn('⚠ Public prices missing; leaving the README table unchanged');
    return false;
  }
  for (const model of models) {
    const rate = prices?.get(model.id);
    if (rate) model.cost = { ...rate };
  }
  return true;
}

async function fetchModels(apiKey) {
  if (apiKey) {
    try {
      return { models: await fetchV1Models(apiKey), authoritative: true };
    } catch (error) {
      console.warn(`⚠ /v1/models failed (${error.message}); falling back to public catalog`);
    }
  } else {
    console.warn('⚠ No API key found (no `coralbricks` credential in ' + AUTH_JSON_PATH + ', CORALBRICKS_API_KEY unset); using the public catalog');
  }
  return { models: await fetchPublicCatalog(), authoritative: false };
}

/**
 * The public catalog is a subset of the per-key /v1/models set: it advertises a
 * model's canonical slug, not every variant enabled for the key (the -fp4 twins
 * are listed by /v1/models only). It can vouch for what exists, never for what
 * is gone, so a non-authoritative fetch keeps every already-known model it does
 * not list: a keyless run may discover models, it may not delist them. Returns
 * the ids it kept, in the order they were appended.
 */
function keepUnlistedModels(models, existingModelsMap, authoritative) {
  if (authoritative) return [];
  const seen = new Set(models.map((m) => m.id));
  const kept = [];
  for (const [id, existing] of Object.entries(existingModelsMap)) {
    if (!seen.has(id)) {
      models.push(existing);
      kept.push(id);
    }
  }
  return kept;
}

// Transform API model → models.json entry

function transformApiModel(apiModel, existingModelsMap) {
  const id = apiModel.id;
  const pricing = apiModel.pricing || {};
  const input = apiModel.supports_image_input ? ['text', 'image'] : ['text'];
  const contextWindow = parseContextWindow(apiModel.context_length);
  const maxTokens = DEFAULT_MAX_TOKENS[id] ?? FALLBACK_MAX_TOKENS;

  // Preserve existing curated data (pricing, reasoning, compat, etc.)
  if (existingModelsMap[id]) {
    const existing = { ...existingModelsMap[id] };
    if (contextWindow) existing.contextWindow = contextWindow;
    if (apiModel.max_output_tokens) existing.maxTokens = apiModel.max_output_tokens;
    if (typeof pricing.input_per_m === 'number') existing.cost.input = pricing.input_per_m;
    if (typeof pricing.output_per_m === 'number') existing.cost.output = pricing.output_per_m;
    existing.cost.cacheRead = toNumber(pricing.cached_input_per_m);
    if (typeof pricing.cache_write_per_m === 'number') {
      existing.cost.cacheWrite = writtenTokenCost(existing.cost.input, pricing.cache_write_per_m);
    }
    existing.input = input;
    return existing;
  }

  // New model — build from API data + sensible defaults
  return {
    id,
    name: apiModel.name || generateDisplayName(id),
    reasoning: false,
    input,
    cost: {
      input: toNumber(pricing.input_per_m),
      output: toNumber(pricing.output_per_m),
      cacheRead: toNumber(pricing.cached_input_per_m),
      cacheWrite: writtenTokenCost(toNumber(pricing.input_per_m), pricing.cache_write_per_m),
    },
    contextWindow,
    maxTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: 'max_tokens',
    },
  };
}

function transformCatalogModel(entry, existingModelsMap) {
  const id = entry.slug;
  const contextWindow = parseContextWindow(entry.contextWindow);
  const maxTokens = DEFAULT_MAX_TOKENS[id] ?? FALLBACK_MAX_TOKENS;

  if (existingModelsMap[id]) {
    const existing = { ...existingModelsMap[id] };
    if (contextWindow) existing.contextWindow = contextWindow;
    if (typeof entry.inputPerM === 'number') existing.cost.input = entry.inputPerM;
    if (typeof entry.outputPerM === 'number') existing.cost.output = entry.outputPerM;
    if (typeof entry.cacheReadPerM === 'number') existing.cost.cacheRead = entry.cacheReadPerM;
    if (typeof entry.cacheWritePerM === 'number') {
      existing.cost.cacheWrite = writtenTokenCost(existing.cost.input, entry.cacheWritePerM);
    }
    return existing;
  }

  return {
    id,
    name: entry.name || generateDisplayName(id),
    reasoning: false,
    input: ['text'],
    cost: {
      input: toNumber(entry.inputPerM),
      output: toNumber(entry.outputPerM),
      cacheRead: toNumber(entry.cacheReadPerM),
      cacheWrite: writtenTokenCost(toNumber(entry.inputPerM), entry.cacheWritePerM),
    },
    contextWindow,
    maxTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: 'max_tokens',
    },
  };
}

// Patch Application (mirrors index.ts)

function applyPatch(model, patch) {
  // Deep-copy nested objects: the delete branches below must not mutate the
  // caller's (embedded or cached) source data through shared references.
  const result = {
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
  if (patch.thinkingLevelMap !== undefined) result.thinkingLevelMap = patch.thinkingLevelMap;
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
function buildModels(baseModels, customModels, patchData) {
  const modelMap = new Map();
  for (const model of baseModels) {
    modelMap.set(model.id, model);
  }
  for (const [id, patchEntry] of Object.entries(patchData)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patchEntry));
    }
  }
  for (const model of customModels) {
    const existing = modelMap.get(model.id);
    const patchEntry = patchData[model.id];
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
  // Mirrors index.ts buildModels: hidden models are served by Coral but kept out
  // of the catalog the provider offers, so the README table skips them too.
  return Array.from(modelMap.values())
    .filter((m) => !m.hidden)
    .map(({ hidden: _hidden, ...model }) => model);
}

// README generation

function formatContext(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return n.toString();
}

function formatCost(cost) {
  if (cost === 0 || cost === null || cost === undefined) return '—';
  // Two decimals everywhere Coral prices in cents; three for sub-cent cache reads ($0.008/M).
  return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toFixed(3)}`;
}

function generateReadmeTable(models) {
  const lines = [
    '| Model | Context | Vision | Reasoning | Input $/M | Cache Read $/M | Cache Write $/M | Output $/M |',
    '|-------|---------|--------|-----------|-----------|-----------------|------------------|------------|',
  ];

  for (const model of models) {
    const context = formatContext(model.contextWindow);
    const vision = model.input.includes('image') ? '✅' : '❌';
    const reasoning = model.reasoning ? '✅' : '❌';
    const inputCost = formatCost(model.cost.input);
    const cacheReadCost = formatCost(model.cost.cacheRead);
    const cacheWriteCost = formatCost(model.cost.cacheWrite);
    const outputCost = formatCost(model.cost.output);

    lines.push(`| ${model.name} | ${context} | ${vision} | ${reasoning} | ${inputCost} | ${cacheReadCost} | ${cacheWriteCost} | ${outputCost} |`);
  }

  return lines.join('\n');
}

function updateReadme(models) {
  let readme = fs.readFileSync(README_PATH, 'utf8');
  const newTable = generateReadmeTable(models);

  const tableRegex = /(## Available Models\n\n)\| Model \|[^\n]+\|\n\|[-| ]+\|(\n\|[^\n]+\|)*\n*/;

  if (tableRegex.test(readme)) {
    readme = readme.replace(tableRegex, (match, header) => `${header}${newTable}\n\n`);
    fs.writeFileSync(README_PATH, readme);
    console.log('✓ Updated README.md');
  } else {
    console.warn('⚠ Could not find model table in "## Available Models" section');
  }
}

// Grace period for delisted models: update-models.js moves models the API no
// longer lists into deprecated-models.json (stamped with deprecatedAt) instead
// of dropping them; the runtime appends them back so sessions and saved model
// settings keep working, and after 14 days they are evicted permanently.
//
// The grace period exists for a model that is still ANSWERING while it leaves
// the catalog. A retired one is not: Coral answers 404 with
// `error.code == "model_retired"`, so keeping it registered only offers the
// user a model that cannot reply, and /model still lists it for two weeks.
// Each delisted model is probed once, and a retired one is dropped instead of
// parked. Anything else — an unknown id, a key without access, a network
// blip — keeps the grace period, because only `model_retired` is a statement
// that the model is gone for everybody rather than missing for this key.
//
// A model patch.json hides skips the grace period too: it was never in the
// registered catalog, so no session or saved setting can be using it, and
// parking it only keeps a dead patch.json entry alive for two weeks.
const DEPRECATED_MODEL_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const RETIRED_PROBE_TIMEOUT_MS = 10000;

/**
 * Ask the gateway whether a model is retired. Returns true ONLY on an explicit
 * 404 `model_retired`; every other outcome returns false, so a probe that
 * cannot answer never shortens a grace period.
 */
async function isRetiredUpstream(id, apiKey) {
  if (!apiKey) return false;
  try {
    const response = await fetch(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: id, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(RETIRED_PROBE_TIMEOUT_MS),
    });
    if (response.status !== 404) return false;
    const body = await response.json();
    return body?.error?.code === 'model_retired';
  } catch {
    return false;   // offline, timeout, unparseable body: keep the grace period
  }
}

async function updateDeprecatedModels(modelsJsonPath, newModels, apiKey, hiddenIds = new Set()) {
  const deprecatedPath = path.join(path.dirname(modelsJsonPath), 'deprecated-models.json');

  let oldModels = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'));
    if (Array.isArray(parsed)) oldModels = parsed;
  } catch { /* first run: no previous models.json */ }

  let deprecated = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(deprecatedPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) deprecated = parsed;
  } catch { /* no graveyard yet */ }

  const currentIds = new Set(newModels.map((m) => m.id));
  const now = new Date().toISOString();
  const added = [];
  const resurrected = [];
  const evicted = [];
  const retired = [];
  const hidden = [];

  const candidates = oldModels.filter((old) => old && old.id && !currentIds.has(old.id) && !deprecated[old.id]);
  for (const old of candidates) if (hiddenIds.has(old.id)) hidden.push(old.id);
  // Probe the delisted models plus anything already parked: a model can retire
  // during its own grace period, which is exactly when it starts 404ing.
  // Hidden ones are dropped either way, so they are not probed.
  const parked = Object.keys(deprecated).filter((id) => !currentIds.has(id) && !hiddenIds.has(id));
  const toProbe = [...new Set([...candidates.filter((m) => !hiddenIds.has(m.id)).map((m) => m.id), ...parked])];
  const retiredIds = new Set(
    (await Promise.all(toProbe.map(async (id) => ((await isRetiredUpstream(id, apiKey)) ? id : null))))
      .filter((id) => id !== null)
  );

  for (const old of candidates) {
    if (hiddenIds.has(old.id)) continue;   // never offered: nothing to keep working
    if (retiredIds.has(old.id)) {
      retired.push(old.id);
      continue;   // retired upstream: 404s, so a grace period buys nothing
    }
    deprecated[old.id] = { ...old, deprecatedAt: now };
    added.push(old.id);
  }

  for (const [id, entry] of Object.entries(deprecated)) {
    if (currentIds.has(id)) {
      delete deprecated[id];
      resurrected.push(id);
      continue;
    }
    if (retiredIds.has(id)) {
      delete deprecated[id];
      retired.push(id);
      continue;
    }
    if (hiddenIds.has(id)) {
      delete deprecated[id];
      hidden.push(id);
      continue;
    }
    const removedAt = Date.parse(entry && entry.deprecatedAt ? entry.deprecatedAt : '');
    if (Number.isNaN(removedAt) || Date.now() - removedAt > DEPRECATED_MODEL_TTL_MS) {
      delete deprecated[id];
      evicted.push(id);
    }
  }

  if (added.length > 0 || resurrected.length > 0 || evicted.length > 0 || retired.length > 0 || hidden.length > 0) {
    fs.writeFileSync(deprecatedPath, JSON.stringify(deprecated, null, 2) + '\n');
    console.log('Updated deprecated-models.json ' + JSON.stringify({ added, resurrected, evicted, retired, hidden }));
  }
}

async function main() {
  try {
    // Regenerate the derived README table from local source data without an API
    // key. This is useful for offline workflows while curating custom models.
    if (process.argv.includes('--readme-only')) {
      const baseModels = loadJson(MODELS_JSON_PATH);
      const patchData = loadJson(PATCH_JSON_PATH);
      const customModels = loadJson(CUSTOM_MODELS_JSON_PATH);
      const readmeBase = Array.isArray(baseModels) ? baseModels : [];
      const readmeModels = buildModels(readmeBase, Array.isArray(customModels) ? customModels : [], patchData);
      const prices = await loadPublicListPricing();
      if (applyListPricing(readmeModels, prices, customModels)) {
        readmeModels.sort((a, b) => a.name.localeCompare(b.name));
        updateReadme(readmeModels);
        console.log('✓ Regenerated README.md from local model data and public-price snapshot');
      }
      return;
    }

    const apiKey = resolveApiKey();
    const { models: apiModels, authoritative } = await fetchModels(apiKey);

    // Load existing models.json — source of truth for curated specs
    const existingModels = loadJson(MODELS_JSON_PATH);
    const existingModelsMap = {};
    for (const m of (Array.isArray(existingModels) ? existingModels : [])) {
      existingModelsMap[m.id] = m;
    }

    // Transform API models, preserving existing data where available
    const isCatalogShape = apiModels.length > 0 && apiModels.every((m) => m && m.slug && m.id === undefined);
    let models = apiModels.map((m) =>
      isCatalogShape ? transformCatalogModel(m, existingModelsMap) : transformApiModel(m, existingModelsMap)
    );

    // Live API is authoritative — models absent from it are removed (embedded
    // data is already used for enrichment in transformApiModel). A catalog run
    // is not: keep every known model it does not list.
    const kept = keepUnlistedModels(models, existingModelsMap, authoritative);
    if (kept.length > 0) {
      console.warn(`⚠ Public catalog listed ${kept.length} fewer model(s) than models.json; kept: ${kept.join(', ')}`);
    }

    // Sort by model name
    models.sort((a, b) => a.name.localeCompare(b.name));

    // Save models.json (pure API output, no patch/custom baked in)
    // Move delisted models to deprecated-models.json BEFORE models.json is overwritten
    const patchData = loadJson(PATCH_JSON_PATH);
    const hiddenIds = new Set(Object.entries(patchData).filter(([, entry]) => entry && entry.hidden === true).map(([id]) => id));
    await updateDeprecatedModels(MODELS_JSON_PATH, models, apiKey, hiddenIds);
    saveJson(MODELS_JSON_PATH, models);

    // Build the README model list: base → patch → custom. Grace-period models stay
    // servable at runtime (index.ts appends them) but are not listed as available.
    // Prices come from the public list, not the key's /v1/models rates.
    const customModels = loadJson(CUSTOM_MODELS_JSON_PATH);
    const readmeBase = models;
    const readmeModels = buildModels(readmeBase, Array.isArray(customModels) ? customModels : [], patchData);
    // Reuse the public catalog when it already supplied the model list.
    const prices = await loadPublicListPricing({ refresh: true, catalog: authoritative ? undefined : apiModels });
    if (applyListPricing(readmeModels, prices, customModels)) {
      readmeModels.sort((a, b) => a.name.localeCompare(b.name));
      updateReadme(readmeModels);
    }

    // Summary
    const newIds = new Set(models.map((m) => m.id));
    const oldIds = new Set(Object.keys(existingModelsMap));
    const added = [...newIds].filter((id) => !oldIds.has(id));
    const removed = [...oldIds].filter((id) => !newIds.has(id));

    console.log('\n--- Summary ---');
    console.log(`Total models: ${models.length}`);
    console.log(`Reasoning models: ${models.filter((m) => m.reasoning).length}`);
    console.log(`Vision models: ${models.filter((m) => m.input.includes('image')).length}`);
    if (added.length > 0) console.log(`New models: ${added.join(', ')} — curate models.json manually`);
    if (removed.length > 0) console.log(`Removed models: ${removed.join(', ')}`);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Run only when invoked as a script, so the deprecation logic below can be
// imported by tests without kicking off a sync.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}

export { isRetiredUpstream, keepUnlistedModels, updateDeprecatedModels, loadPublicListPricing, applyListPricing };
