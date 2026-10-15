import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { isRetiredUpstream, keepUnlistedModels, updateDeprecatedModels } from "../scripts/update-models.js";

const realFetch = globalThis.fetch;
const dirs: string[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A models.json + deprecated-models.json pair in a throwaway directory. */
function workspace(models: object[], deprecated: Record<string, object> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coralbricks-deprecation-"));
  dirs.push(dir);
  const modelsPath = path.join(dir, "models.json");
  fs.writeFileSync(modelsPath, JSON.stringify(models, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "deprecated-models.json"), JSON.stringify(deprecated, null, 2) + "\n");
  return {
    modelsPath,
    read: () => JSON.parse(fs.readFileSync(path.join(dir, "deprecated-models.json"), "utf8")),
  };
}

const model = (id: string) => ({
  id,
  name: id,
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 1.5 },
  contextWindow: 131072,
  maxTokens: 32768,
});

/** Stub the gateway: ids in `retired` 404 as model_retired, the rest 404 unknown. */
function gateway(retired: string[], onCall?: (id: string) => void) {
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const id = JSON.parse(init.body).model;
    onCall?.(id);
    const code = retired.includes(id) ? "model_retired" : "model_not_public";
    return new Response(JSON.stringify({ error: { code } }), { status: 404 });
  }) as unknown as typeof fetch;
}

describe("updateDeprecatedModels", () => {
  it("parks a delisted model that is merely missing from the live list", async () => {
    const ws = workspace([model("glm-5.3-fp4"), model("gone-model")]);
    gateway([]);
    await updateDeprecatedModels(ws.modelsPath, [model("glm-5.3-fp4")], "cb_key");
    expect(Object.keys(ws.read())).toEqual(["gone-model"]);
    expect(ws.read()["gone-model"].deprecatedAt).toBeTruthy();
  });

  it("drops a retired model instead of parking it", async () => {
    const ws = workspace([model("glm-5.3-fp4"), model("retired-model")]);
    gateway(["retired-model"]);
    await updateDeprecatedModels(ws.modelsPath, [model("glm-5.3-fp4")], "cb_key");
    expect(ws.read()).toEqual({});
  });

  it("evicts a parked model that has since retired, mid grace period", async () => {
    const parked = { "retired-model": { ...model("retired-model"), deprecatedAt: new Date().toISOString() } };
    const ws = workspace([model("glm-5.3-fp4")], parked);
    gateway(["retired-model"]);
    await updateDeprecatedModels(ws.modelsPath, [model("glm-5.3-fp4")], "cb_key");
    expect(ws.read()).toEqual({});
  });

  it("keeps the grace period when no API key is available to probe with", async () => {
    let probed = false;
    const ws = workspace([model("glm-5.3-fp4"), model("gone-model")]);
    gateway(["gone-model"], () => { probed = true; });
    await updateDeprecatedModels(ws.modelsPath, [model("glm-5.3-fp4")], undefined);
    expect(probed).toBe(false);
    expect(Object.keys(ws.read())).toEqual(["gone-model"]);
  });

  it("keeps the grace period when the probe itself fails", async () => {
    const ws = workspace([model("glm-5.3-fp4"), model("gone-model")]);
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await updateDeprecatedModels(ws.modelsPath, [model("glm-5.3-fp4")], "cb_key");
    expect(Object.keys(ws.read())).toEqual(["gone-model"]);
  });

  it("drops a delisted model patch.json hides instead of parking it, without probing it", async () => {
    let probed = false;
    const ws = workspace([model("glm-5.3-fast"), model("glm-5.3-fp4")]);
    gateway([], () => { probed = true; });
    await updateDeprecatedModels(ws.modelsPath, [model("glm-5.3-fast")], "cb_key", new Set(["glm-5.3-fp4"]));
    expect(probed).toBe(false);
    expect(ws.read()).toEqual({});
  });

  it("drops a parked model patch.json hides, mid grace period", async () => {
    const parked = {
      "glm-5.3-fp4": { ...model("glm-5.3-fp4"), deprecatedAt: new Date().toISOString() },
      "gone-model": { ...model("gone-model"), deprecatedAt: new Date().toISOString() },
    };
    const ws = workspace([model("glm-5.3-fast")], parked);
    gateway([]);
    await updateDeprecatedModels(ws.modelsPath, [model("glm-5.3-fast")], "cb_key", new Set(["glm-5.3-fp4"]));
    expect(Object.keys(ws.read())).toEqual(["gone-model"]);
  });

  it("resurrects a parked model the live list carries again, without probing it", async () => {
    const parked = { "glm-5.3-fp4": { ...model("glm-5.3-fp4"), deprecatedAt: new Date().toISOString() } };
    const ws = workspace([model("glm-5.3-fp4")], parked);
    gateway(["glm-5.3-fp4"]);   // even a retired verdict must not matter here
    await updateDeprecatedModels(ws.modelsPath, [model("glm-5.3-fp4")], "cb_key");
    expect(ws.read()).toEqual({});
  });
});

describe("keepUnlistedModels", () => {
  it("keeps known models an unauthenticated catalog does not list", () => {
    const known = { "glm-5.3-fast": model("glm-5.3-fast"), "glm-5.3-fp4": model("glm-5.3-fp4") };
    const fetched = [model("glm-5.3-fast")];
    expect(keepUnlistedModels(fetched, known, false)).toEqual(["glm-5.3-fp4"]);
    expect(fetched.map((m) => m.id)).toEqual(["glm-5.3-fast", "glm-5.3-fp4"]);
  });

  it("treats the per-key /v1/models list as authoritative", () => {
    const known = { "gone-model": model("gone-model") };
    const fetched = [model("glm-5.3-fast")];
    expect(keepUnlistedModels(fetched, known, true)).toEqual([]);
    expect(fetched.map((m) => m.id)).toEqual(["glm-5.3-fast"]);
  });

  it("keeps nothing it already has", () => {
    const known = { "glm-5.3-fast": model("glm-5.3-fast") };
    const fetched = [model("glm-5.3-fast")];
    expect(keepUnlistedModels(fetched, known, false)).toEqual([]);
    expect(fetched.map((m) => m.id)).toEqual(["glm-5.3-fast"]);
  });
});

describe("isRetiredUpstream", () => {
  it("is true only for a 404 that says model_retired", async () => {
    gateway(["retired-model"]);
    expect(await isRetiredUpstream("retired-model", "cb_key")).toBe(true);
    expect(await isRetiredUpstream("unknown-model", "cb_key")).toBe(false);
  });

  it("is false for a served model, a non-404 error, and a body it cannot parse", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: "chatcmpl" }), { status: 200 })) as unknown as typeof fetch;
    expect(await isRetiredUpstream("glm-5.3-fp4", "cb_key")).toBe(false);

    globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    expect(await isRetiredUpstream("glm-5.3-fp4", "cb_key")).toBe(false);

    globalThis.fetch = (async () => new Response("<html>not json", { status: 404 })) as unknown as typeof fetch;
    expect(await isRetiredUpstream("glm-5.3-fp4", "cb_key")).toBe(false);
  });

  it("never probes without a key", async () => {
    globalThis.fetch = (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch;
    expect(await isRetiredUpstream("retired-model", undefined)).toBe(false);
  });
});
