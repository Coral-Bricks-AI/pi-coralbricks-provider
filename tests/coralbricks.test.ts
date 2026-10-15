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
  // models.json holds only the bare API row, so apply patch.json's entry for
  // the live slug first — applyPatch's merge/strip behavior needs curated input.
  const base = applyPatch(
    modelsData.find((m) => m.id === "glm-5.3-fast")!,
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
  it("applies patch.json on top of base models", () => {
    const patch = { "glm-5.3-fast": { name: "GLM 5.3 (patched)" } };
    const models = buildModels(modelsData as any, [], patch);
    const glm = models.find((m) => m.id === "glm-5.3-fast");
    expect(glm?.name).toBe("GLM 5.3 (patched)");
  });

  it("ignores patch entries for unknown ids", () => {
    const models = buildModels(modelsData as any, [], { "no-such-model": { name: "x" } });
    expect(models.find((m) => m.id === "x")).toBeUndefined();
    expect(models.length).toBe(withDeprecated(modelsData as any).length);
  });

  it("adds custom models and applies their patches", () => {
    const custom = [{ ...modelsData[0], id: "router-model" }];
    const patch = { "router-model": { reasoning: false } };
    const models = buildModels(modelsData as any, custom as any, patch);
    const router = models.find((m) => m.id === "router-model");
    expect(router).toBeDefined();
    expect(router?.reasoning).toBe(false);
    expect(router?.compat?.thinkingFormat).toBeUndefined();
  });
});

describe("mergeWithEmbedded (live vs curated)", () => {
  it("keeps curated compat/thinking over live rows while live cost wins", () => {
    const live = transformApiModel({
      ...v1DeepSeekRow,
      id: "glm-5.3-fast",
      supports_image_input: false,
      pricing: { cache_write_per_m: 2, cached_input_per_m: 0, input_per_m: 5, output_per_m: 20 },
    })!;
    // Curated reasoning/compat lives in patch.json, applied after the merge by
    // buildModels; mergeWithEmbedded only proves the embedded curation wins here.
    const merged = mergeWithEmbedded([live], modelsData as any);
    const glm = merged.find((m) => m.id === "glm-5.3-fast")!;
    // cache_write_per_m (2) is on top of input (5): a written token costs 7.
    expect(glm.cost).toEqual({ input: 5, output: 20, cacheRead: 0, cacheWrite: 7 });
    expect(glm.input).toEqual(["text"]);
  });

  it("keeps the curated cache-write rate when a live row omits cache_write_per_m", () => {
    const { cache_write_per_m: _omitted, ...pricing } = v1DeepSeekRow.pricing;
    const live = transformApiModel({ ...v1DeepSeekRow, id: "glm-5.3-fast", pricing: { ...pricing, input_per_m: 1.12, output_per_m: 4.4 } })!;
    expect(live.cost.cacheWrite).toBe(0);
    // The -fast slug's embedded row no longer carries the rate either, so
    // patch.json is the durable source.
    const merged = buildModels(mergeWithEmbedded([live], modelsData as any), [], patchData as any);
    expect(merged.find((m) => m.id === "glm-5.3-fast")!.cost.cacheWrite).toBe(1.68);
  });

  it("appends embedded-only models (delisted from live)", () => {
    const live = [transformApiModel({ id: "brand-new-model", pricing: { input_per_m: 1, output_per_m: 2 } })!];
    const merged = mergeWithEmbedded(live, modelsData as any);
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
      "gone-model": { ...(modelsData[0] as any), id: "gone-model", deprecatedAt: iso(fresh) },
      "old-model": { ...(modelsData[0] as any), id: "old-model", deprecatedAt: iso(ancient) },
    });
    expect(active.map((m) => m.id)).toEqual(["gone-model"]);
    expect(active[0].deprecatedAt).toBeUndefined();
  });

  it("withDeprecated appends only missing deprecated models", () => {
    const base = [{ ...modelsData[0], id: "live-model" }];
    const extras = activeDeprecatedModels();
    const result = withDeprecated(base as any);
    expect(result.map((m) => m.id)).toEqual([...base.map((m) => m.id), ...extras.map((m) => m.id)]);

    const existing = [...base, ...extras];
    expect(withDeprecated(existing as any)).toHaveLength(existing.length);
  });
});

describe("embedded model catalog invariants", () => {
  const models = modelsData as any[];
  const deprecatedModels = Object.values(deprecatedData) as any[];
  const catalog = [...models, ...deprecatedModels];

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

  it("offers the canonical -fast slugs", () => {
    // models.json mirrors the per-key /v1/models set. Coral stopped serving the
    // hidden -fp4 twins on 2026-10-12, so only the -fast slugs remain…
    expect(models.map((m) => m.id).sort()).toEqual(["deepseek-v4.1-flash-fast", "glm-5.3-fast"]);
    // …and the provider catalog (what pi's /model lists) is exactly that.
    const effective = buildModels(models as any, customModelsData as any, patchData as any);
    expect(effective.map((m) => m.id)).toEqual(["deepseek-v4.1-flash-fast", "glm-5.3-fast"]);
    expect(effective.every((m) => (m as { hidden?: boolean }).hidden === undefined)).toBe(true);
  });

  it("gives every -fast slug the reasoning settings its legacy -fp4 id carried", () => {
    // The -fp4 ids were the curated originals (models.json + patch.json at
    // 4ce2b3d). When Coral served the -fast slugs instead, the new API rows
    // arrived with no reasoning at all, so the curation had to be re-keyed —
    // this pins the settings each -fast slug must keep.
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
    const effective = buildModels(models as any, [], patchData as any);
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

  it("has well-formed costs with free cached reads and a cache-write rate", () => {
    for (const m of models) {
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        expect(typeof m.cost[key]).toBe("number");
      }
      expect(m.cost.cacheRead).toBe(0); // Coral: cached input is free
      expect(m.contextWindow).toBeGreaterThanOrEqual(131072);
      expect(m.maxTokens).toBeGreaterThan(0);
    }
    // Coral bills uncached prompt tokens as cache writes, but the -fast API rows
    // (and the public catalog) omit cache_write_per_m, so patch.json must supply
    // it — the effective model is what a user actually gets.
    const effective = buildModels(models as any, [], patchData as any);
    for (const m of effective) {
      expect(m.cost.cacheWrite).toBeGreaterThan(0);
    }
  });

  it("keeps pricing aligned with Coral's published rates", () => {
    // Effective = after patch.json; the raw -fast rows omit cacheWrite.
    const byId = Object.fromEntries(
      buildModels(catalog as any, [], patchData as any).map((m) => [m.id, m]),
    );
    // glm-5.2-fp4 is delisted; it is present only during its grace window.
    const glm52 = byId["glm-5.2-fp4"];
    if (glm52) expect(glm52.cost).toMatchObject({ input: 1.12, output: 4.4 });
    // https://www.coralbricks.ai/pricing, 2026-09-22 (slugs renamed -fp4 → -fast, 2026-10)
    expect(byId["glm-5.3-fast"].cost).toMatchObject({ input: 1.12, output: 4.4, cacheWrite: 1.68 });
    // 2026-10-08: DeepSeek $0.01 input + $0.08 cache write on top = $0.09 per written token.
    expect(byId["deepseek-v4.1-flash-fast"].cost).toMatchObject({ input: 0.01, output: 1.2, cacheWrite: 0.09 });
  });

  it("gives every effective model reasoning config after patch.json", () => {
    const effective = buildModels(modelsData as any, customModelsData as any, patchData as any);
    for (const m of effective) {
      expect(m.reasoning).toBe(true);
      expect(m.thinkingLevelMap).toBeDefined();
      expect(m.compat?.thinkingFormat).toBeDefined();
      expect(m.compat?.supportsStore).toBe(false);
      expect(m.compat?.supportsDeveloperRole).toBe(false);
    }
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
    const effective = buildModels([...modelsData, glm52Fixture] as any, customModelsData as any, patchData as any);
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

  it("flags vision from the live API flag, with patch.json restoring the -fast rows' image input", () => {
    // The -fast API rows omit supports_image_input, so patch.json supplies it.
    const byId = Object.fromEntries(buildModels(models as any, [], patchData as any).map((m) => [m.id, m]));
    expect(byId["deepseek-v4.1-flash-fast"].input).toContain("image");
    expect(byId["glm-5.3-fast"].input).toEqual(["text"]);
  });

  it("curates every live model via patch.json, and nothing else", () => {
    // Coral's rows carry no reasoning or display name, so every id in
    // models.json needs a patch entry; an entry for a model Coral no longer
    // serves is dead. update-models.js drops delisted hidden models at once, so
    // the -fp4 twins' entries went with them.
    expect(Object.keys(patchData).sort()).toEqual(modelsData.map((m) => m.id).sort());
    expect(customModelsData).toEqual([]);
    expect(Object.values(patchData as Record<string, any>).filter((entry) => entry.hidden === true)).toEqual([]);
  });
});

