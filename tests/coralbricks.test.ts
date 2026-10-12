import { describe, expect, it } from "vitest";
import {
  activeDeprecatedModels,
  applyPatch,
  buildModels,
  mergeWithEmbedded,
  parseContextWindow,
  transformApiModel,
  withDeprecated,
} from "../index";
import modelsData from "../models.json" with { type: "json" };
import customModelsData from "../custom-models.json" with { type: "json" };
import patchData from "../patch.json" with { type: "json" };
import deprecatedData from "../deprecated-models.json" with { type: "json" };
import { DEEPSEEK_FLASH_ROW, GLM_FAST_ROW, baseModels, fixtureCatalog } from "./model-fixtures";

const DEPRECATED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// A Coral /v1/models row shaped as the gateway returns it (2026-09-22, less the
// rolling speed/latency/cache-hit stats, which the transform ignores).
const v1DeepSeekRow = {
  id: "deepseek-v4.1-flash-fast-fp4",
  object: "model",
  owned_by: "coralbricks",
  context_length: 1048576,
  created: 1789000000,
  // Since 2026-10-08: fixed prices, cache_write_per_m is the cache write ON TOP of input.
  pricing: { cache_write_per_m: 0.08, cached_input_per_m: 0, input_per_m: 0.01, output_per_m: 1.2 },
  supports_chat: true,
  supports_image_input: true,
  supports_tools: true,
};

describe("transformApiModel (/v1/models rows)", () => {
  it("maps pricing, context, and image support", () => {
    const m = transformApiModel(v1DeepSeekRow)!;
    expect(m.id).toBe("deepseek-v4.1-flash-fast-fp4");
    expect(m.input).toEqual(["text", "image"]);
    expect(m.cost).toEqual({ input: 0.01, output: 1.2, cacheRead: 0, cacheWrite: 0.09 });
    expect(m.contextWindow).toBe(1048576);
    expect(m.compat?.supportsStore).toBe(false);
    expect(m.compat?.supportsDeveloperRole).toBe(false);
    expect(m.compat?.maxTokensField).toBe("max_tokens");
  });

  it("keeps Coral's free cached reads at cacheRead: 0", () => {
    const m = transformApiModel(v1DeepSeekRow)!;
    expect(m.cost.cacheRead).toBe(0);
  });

  it("prices a written token at input + cache_write_per_m, and 0 when a row omits it", () => {
    expect(transformApiModel(v1DeepSeekRow)!.cost.cacheWrite).toBe(0.09);
    const glm = { ...v1DeepSeekRow, id: "glm-5.3-fast",
      pricing: { cache_write_per_m: 0.56, cached_input_per_m: 0, input_per_m: 1.12, output_per_m: 4.4 } };
    expect(transformApiModel(glm)!.cost.cacheWrite).toBe(1.68);
    const { cache_write_per_m: _omitted, ...pricing } = v1DeepSeekRow.pricing;
    expect(transformApiModel({ ...v1DeepSeekRow, pricing })!.cost.cacheWrite).toBe(0);
  });

  it("defaults new models to text-only and falls back for maxTokens", () => {
    const text = transformApiModel({ id: "some-text-model", context_length: 131072, pricing: {} })!;
    expect(text.input).toEqual(["text"]);
    expect(text.maxTokens).toBe(32768);

    const unknown = transformApiModel({ id: "some-new-model", pricing: {} })!;
    expect(unknown.maxTokens).toBe(32768);
    expect(unknown.contextWindow).toBe(131072);
  });

  it("returns null for rows without an id", () => {
    expect(transformApiModel(null)).toBeNull();
    expect(transformApiModel({})).toBeNull();
  });
});

describe("parseContextWindow", () => {
  it("handles M/K strings, numerics, and garbage", () => {
    expect(parseContextWindow("1M")).toBe(1048576);
    expect(parseContextWindow("128K")).toBe(131072);
    expect(parseContextWindow("1048576")).toBe(1048576);
    expect(parseContextWindow(262144)).toBe(262144);
    expect(parseContextWindow("bogus")).toBe(131072);
  });
});

describe("applyPatch", () => {
  // A fixture API row (reasoning false, no thinking config) plus the REAL
  // patch.json entry for the same id: this is what the provider serves.
  const base = applyPatch(
    baseModels.find((m) => m.id === "glm-5.3-fast")!,
    (patchData as any)["glm-5.3-fast"],
  );
  expect(base.reasoning).toBe(true);
  expect(base.compat?.thinkingFormat).toBe("zai");

  it("merges cost fields selectively", () => {
    const patched = applyPatch(base, { cost: { output: 5 } });
    expect(patched.cost.output).toBe(5);
    expect(patched.cost.input).toBe(base.cost.input);
    expect(patched.cost.cacheRead).toBe(0);
  });

  it("merges compat without dropping existing keys", () => {
    const patched = applyPatch(base, { compat: { supportsStrictMode: false } });
    expect(patched.compat?.thinkingFormat).toBe("zai");
    expect(patched.compat?.supportsStrictMode).toBe(false);
  });

  it("strips thinking config when reasoning is turned off", () => {
    const patched = applyPatch(base, { reasoning: false });
    expect(patched.reasoning).toBe(false);
    expect(patched.compat?.thinkingFormat).toBeUndefined();
    expect(patched.thinkingLevelMap).toBeUndefined();
  });
});

describe("buildModels pipeline", () => {
  it("applies patch on top of base models", () => {
    const patch = { "glm-5.3-fast": { name: "GLM 5.3 (patched)" } };
    const models = buildModels(baseModels, [], patch);
    const glm = models.find((m) => m.id === "glm-5.3-fast");
    expect(glm?.name).toBe("GLM 5.3 (patched)");
  });

  it("ignores patch entries for unknown ids", () => {
    const models = buildModels(baseModels, [], { "no-such-model": { name: "x" } });
    expect(models.find((m) => m.id === "x")).toBeUndefined();
    expect(models.length).toBe(withDeprecated(baseModels).length);
  });

  it("adds custom models and applies their patches", () => {
    const custom = [{ ...baseModels[0], id: "router-model" }];
    const patch = { "router-model": { name: "Router" } };
    const models = buildModels(baseModels, custom, patch);
    const router = models.find((m) => m.id === "router-model");
    expect(router).toBeDefined();
    expect(router?.name).toBe("Router");
  });
});

describe("mergeWithEmbedded (live vs curated)", () => {
  it("keeps curated compat/thinking over live rows while live cost wins", () => {
    const live = transformApiModel({
      ...GLM_FAST_ROW,
      supports_image_input: false,
      pricing: { cache_write_per_m: 2, cached_input_per_m: 0, input_per_m: 5, output_per_m: 20 },
    })!;
    // Curated reasoning/compat lives in patch.json, applied after the merge by
    // buildModels; mergeWithEmbedded only proves the embedded curation wins here.
    const merged = mergeWithEmbedded([live], baseModels);
    const glm = merged.find((m) => m.id === "glm-5.3-fast")!;
    // cache_write_per_m (2) is on top of input (5): a written token costs 7.
    expect(glm.cost).toEqual({ input: 5, output: 20, cacheRead: 0, cacheWrite: 7 });
    expect(glm.input).toEqual(["text"]);
  });

  it("keeps the curated cache-write rate when a live row omits cache_write_per_m", () => {
    const { cache_write_per_m: _omitted, ...pricing } = GLM_FAST_ROW.pricing;
    const live = transformApiModel({ ...GLM_FAST_ROW, pricing: { ...pricing, input_per_m: 1.12, output_per_m: 4.4 } })!;
    expect(live.cost.cacheWrite).toBe(0);
    // The -fast slug's embedded row no longer carries a cache-write rate, so
    // patch.json is the durable source.
    const merged = buildModels(mergeWithEmbedded([live], baseModels), [], patchData as any);
    expect(merged.find((m) => m.id === "glm-5.3-fast")!.cost.cacheWrite).toBe(1.68);
  });

  it("appends embedded-only models (delisted from live)", () => {
    const live = [transformApiModel({ id: "brand-new-model", pricing: { input_per_m: 1, output_per_m: 2 } })!];
    const merged = mergeWithEmbedded(live, baseModels);
    expect(merged.some((m) => m.id === "glm-5.3-fast")).toBe(true);
    expect(merged.some((m) => m.id === "brand-new-model")).toBe(true);
  });
});

describe("deprecated model grace period", () => {
  it("keeps recently deprecated models and evicts stale ones", () => {
    const fresh = Date.now() - 1000;
    const ancient = Date.now() - DEPRECATED_TTL_MS - 1000;
    const iso = (t: number) => new Date(t).toISOString();
    const active = activeDeprecatedModels({
      "gone-model": { ...(baseModels[0] as any), id: "gone-model", deprecatedAt: iso(fresh) },
      "old-model": { ...(baseModels[0] as any), id: "old-model", deprecatedAt: iso(ancient) },
    });
    expect(active.map((m) => m.id)).toEqual(["gone-model"]);
    expect(active[0].deprecatedAt).toBeUndefined();
  });

  it("withDeprecated appends only missing deprecated models", () => {
    const base = [{ ...baseModels[0], id: "live-model" }];
    const extras = activeDeprecatedModels();
    const result = withDeprecated(base as any);
    expect(result.map((m) => m.id)).toEqual([...base.map((m) => m.id), ...extras.map((m) => m.id)]);

    const existing = [...base, ...extras];
    expect(withDeprecated(existing as any)).toHaveLength(existing.length);
  });
});

// Invariants on the REAL generated files. These are structural only: they hold
// no matter which models Coral adds, delists, retires or re-prices, and no
// matter which deprecated entries the updater retains or evicts.
describe("embedded model catalog invariants", () => {
  const models = modelsData as any[];
  const deprecatedModels = Object.values(deprecatedData) as any[];
  const patch = patchData as Record<string, any>;
  const hiddenIds = new Set(
    Object.entries(patch).filter(([, entry]) => entry.hidden === true).map(([id]) => id),
  );
  // What the provider actually serves, including any grace-period entries the
  // deprecated graveyard still carries.
  const effective = buildModels(
    [...models, ...deprecatedModels] as any,
    customModelsData as any,
    patchData as any,
  );

  it("separates current and recently removed Coral models", () => {
    // The live catalog changes independently of this separation contract.
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models.map((m) => m.id)).size).toBe(models.length);
    expect(models.every((m) => m.deprecatedAt === undefined)).toBe(true);
    // Deprecated entries live only for the updater's 14-day grace window
    // (evicted once now - deprecatedAt exceeds DEPRECATED_TTL_MS), so assert
    // the separation contract rather than a pinned id.
    expect(deprecatedModels.filter((m) => models.some((active) => active.id === m.id))).toEqual([]);
    expect(new Set(deprecatedModels.map((m) => m.id)).size).toBe(deprecatedModels.length);
    for (const m of deprecatedModels) {
      expect(Number.isNaN(Date.parse(m.deprecatedAt ?? ""))).toBe(false);
    }
  });

  it("has well-formed costs with free cached reads on every embedded model", () => {
    for (const m of models) {
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        expect(typeof m.cost[key]).toBe("number");
      }
      expect(m.cost.cacheRead).toBe(0); // Coral: cached input is free
      expect(m.contextWindow).toBeGreaterThanOrEqual(131072);
      expect(m.maxTokens).toBeGreaterThan(0);
    }
    for (const m of effective) {
      expect(m.cost.cacheRead).toBe(0);
    }
  });

  it("never offers an id a patch entry hides, nor leaks the hidden flag", () => {
    for (const m of effective) {
      expect(hiddenIds.has(m.id)).toBe(false);
      expect((m as { hidden?: boolean }).hidden).toBeUndefined();
    }
  });
});

// patch.json is hand-edited source, not generated data, so these pins stay
// strict: they are the regression guard for "the fast model has no reasoning",
// a real bug users hit.
describe("patch.json curation", () => {
  const patch = patchData as Record<string, any>;

  it("keeps the -fast slugs reasoned with their family thinking maps, compat and rates", () => {
    expect(patch["deepseek-v4.1-flash-fast"]).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
      compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
      cost: { cacheWrite: 0.09 },
    });
    expect(patch["glm-5.3-fast"]).toMatchObject({
      reasoning: true,
      maxTokens: 131072,
      thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
      compat: { supportsReasoningEffort: true, thinkingFormat: "zai" },
      cost: { cacheWrite: 1.68 },
    });
  });

  it("keeps the delisted -fp4 ids hidden", () => {
    // The -fp4 twins were delisted by Coral and parked in deprecated-models.json
    // for the grace period; patch.json still hides them so a stale disk cache or
    // a grace-period catalog never lists them.
    expect(patch["deepseek-v4.1-flash-fast-fp4"].hidden).toBe(true);
    expect(patch["glm-5.3-fp4"].hidden).toBe(true);
  });

  it("allows a patch entry for an id the base list no longer carries", () => {
    // After eviction the -fp4 ids are in no generated file, yet their patch
    // entries must stay. buildModels must tolerate them, not throw.
    expect(Object.keys(patch)).toContain("glm-5.3-fp4");
    expect(Object.keys(patch)).toContain("deepseek-v4.1-flash-fast-fp4");
    expect(() => buildModels(baseModels, [], patchData as any)).not.toThrow();
  });

  it("hides a delisted, patch-hidden id supplied by a stale cache or the grace list", () => {
    const stale = [...baseModels, { ...baseModels[0], id: "deepseek-v4.1-flash-fast-fp4" }];
    const served = buildModels(stale, [], patchData as any);
    expect(served.map((m) => m.id)).not.toContain("deepseek-v4.1-flash-fast-fp4");
    expect(served.map((m) => m.id)).toEqual(["deepseek-v4.1-flash-fast", "glm-5.3-fast"]);
  });

  it("gives the effective -fast slugs the reasoning settings the legacy -fp4 ids carried", () => {
    const legacy = {
      "deepseek-v4.1-flash-fast": {
        reasoning: true,
        input: ["text", "image"],
        maxTokens: 32768,
        thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
        compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
        cacheWrite: 0.09,
      },
      "glm-5.3-fast": {
        reasoning: true,
        input: ["text"],
        maxTokens: 131072,
        thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
        compat: { supportsReasoningEffort: true, thinkingFormat: "zai" },
        cacheWrite: 1.68,
      },
    } as const;
    const effective = fixtureCatalog();
    for (const [id, expected] of Object.entries(legacy)) {
      const model = effective.find((m) => m.id === id);
      expect(model).toBeDefined();
      expect(model!.reasoning).toBe(expected.reasoning);
      expect(model!.input).toEqual(expected.input);
      expect(model!.maxTokens).toBe(expected.maxTokens);
      expect(model!.thinkingLevelMap).toEqual(expected.thinkingLevelMap);
      expect(model!.cost.cacheWrite).toBe(expected.cacheWrite);
      expect(model!.compat).toMatchObject({
        ...expected.compat,
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
      });
    }
  });

  it("supplies a cache-write rate for every model patch.json curates", () => {
    // Coral bills uncached prompt tokens as cache writes, but the -fast API rows
    // (and the public catalog) omit cache_write_per_m, so patch.json supplies it.
    for (const m of fixtureCatalog()) {
      if (!(m.id in patch)) continue;
      expect(m.cost.cacheWrite).toBeGreaterThan(0);
    }
  });

  it("takes input/output from the live row and cache-write from patch.json", () => {
    const byId = Object.fromEntries(fixtureCatalog().map((m) => [m.id, m]));
    expect(byId["glm-5.3-fast"].cost).toMatchObject({ input: 1.12, output: 4.4, cacheWrite: 1.68 });
    // 2026-10-08: DeepSeek $0.01 input + $0.08 cache write on top = $0.09 per written token.
    expect(byId["deepseek-v4.1-flash-fast"].cost).toMatchObject({ input: 0.01, output: 1.2, cacheWrite: 0.09 });
  });

  it("flags vision from the live API flag, with patch.json restoring the -fast rows' image input", () => {
    // The -fast API rows omit supports_image_input, so patch.json supplies it;
    // the fixture GLM row is text-only.
    const byId = Object.fromEntries(fixtureCatalog().map((m) => [m.id, m]));
    expect(byId["deepseek-v4.1-flash-fast"].input).toContain("image");
    expect(byId["glm-5.3-fast"].input).toEqual(["text"]);
  });

  it("maps thinking levels per upstream model family", () => {
    // GLM 5.2 is delisted and embedded only during its grace window, so inject
    // its last-known definition to keep the family mapping covered permanently.
    const glm52Fixture = {
      id: "glm-5.2-fp4",
      name: "GLM 5.2 FP4",
      reasoning: true,
      input: ["text"],
      cost: { input: 1.12, output: 4.4, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1048576,
      maxTokens: 131072,
      thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
        thinkingFormat: "zai",
      },
    };
    const effective = buildModels([...baseModels, glm52Fixture] as any, [], patchData as any);
    const byId = Object.fromEntries(effective.map((m) => [m.id, m]));
    // GLM 5.2: zai format, off→disabled + high/max efforts
    expect(byId["glm-5.2-fp4"].compat?.thinkingFormat).toBe("zai");
    expect(byId["glm-5.2-fp4"].thinkingLevelMap).toMatchObject({ off: "none", high: "high", max: "max" });
    // GLM 5.3 adds a low effort
    expect(byId["glm-5.3-fast"].thinkingLevelMap).toMatchObject({ off: "none", low: "low", high: "high", max: "max" });
    expect(byId["glm-5.3-fast"].maxTokens).toBe(131072);
    // DeepSeek V4.1 Flash: openai reasoning_effort; reasoning is opt-in, so off sends none
    expect(byId["deepseek-v4.1-flash-fast"].compat?.thinkingFormat).toBe("openai");
    expect(byId["deepseek-v4.1-flash-fast"].compat?.supportsReasoningEffort).toBe(true);
    expect(byId["deepseek-v4.1-flash-fast"].thinkingLevelMap).toMatchObject({ off: "none", low: "low", medium: null, high: "high", max: "max" });
  });
});

// A new Coral model arrives with no patch entry. It is served uncurated at
// runtime, so no test may require it to be patched.
describe("brand-new unpatched Coral models", () => {
  const fresh = () => transformApiModel({
    id: "coral-new-model",
    context_length: 262144,
    pricing: { input_per_m: 0.5, output_per_m: 1.5 },
  })!;

  it("serves a model with no patch entry uncurated and visible", () => {
    const effective = buildModels([...baseModels, fresh()], customModelsData as any, patchData as any);
    const model = effective.find((m) => m.id === "coral-new-model")!;
    expect(model).toBeDefined();
    expect((model as { hidden?: boolean }).hidden).toBeUndefined();
    expect(model.reasoning).toBe(false); // no patch entry: served as Coral reported it
  });

  it("scopes the reasoning-configuration contract to ids patch.json curates", () => {
    const effective = buildModels([...baseModels, fresh()], [], patchData as any);
    const patch = patchData as Record<string, any>;
    for (const m of effective) {
      if (!(m.id in patch)) continue;
      expect(m.reasoning).toBe(true);
      expect(m.thinkingLevelMap).toBeDefined();
      expect(m.compat?.thinkingFormat).toBeDefined();
      expect(m.compat?.supportsStore).toBe(false);
      expect(m.compat?.supportsDeveloperRole).toBe(false);
    }
  });
});
