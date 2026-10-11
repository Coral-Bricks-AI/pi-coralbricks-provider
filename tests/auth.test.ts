import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// The real host's config-form composer: what `pi.registerProvider("coralbricks", config)` became.
import { composeModelProvider } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js";
import { coralApiKeyAuth, CORALBRICKS_KEYS_URL } from "../auth";
import modelsData from "../models.json" with { type: "json" };
import customModelsData from "../custom-models.json" with { type: "json" };
import patchData from "../patch.json" with { type: "json" };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "coral-auth-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  vi.stubEnv("CORALBRICKS_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

const signal = () => new AbortController().signal;
const envCtx = (vars: Record<string, string> = {}) => ({ env: async (name: string) => vars[name], fileExists: async () => false });
function interaction(answer = "  cb_pasted-key \n") {
  return { signal: signal(), prompt: vi.fn(async () => answer), notify: vi.fn() };
}

async function setup() {
  vi.resetModules();
  const mod = await import("../index");
  const handlers: Record<string, any> = {};
  const pi = { registerProvider: vi.fn(), registerCommand: vi.fn(), on: vi.fn((event: string, handler: any) => { handlers[event] = handler; }) };
  mod.default(pi as any);
  const provider = () => pi.registerProvider.mock.calls.at(-1)![0];
  return { mod, pi, provider, handlers };
}

function refreshContext(overrides: Record<string, unknown> = {}) {
  return {
    allowNetwork: true,
    signal: signal(),
    publish: vi.fn(async (publication: any) => { publication.update?.(); return true; }),
    ...overrides,
  } as any;
}

function v1Models(ids: string[]) {
  return Response.json({ data: ids.map((id) => ({ id, context_length: 131072, pricing: { input_per_m: 1, output_per_m: 2 } })) });
}

describe("/login coralbricks", () => {
  it("registers a native provider that keeps the coralbricks id and offers an API-key login", async () => {
    const { pi, provider } = await setup();
    expect(pi.registerProvider.mock.calls.at(-1)).toHaveLength(1);
    expect(provider()).toMatchObject({ id: "coralbricks", name: "CoralBricks", baseUrl: "https://inference.coralbricks.ai/v1" });
    expect(provider().auth.oauth).toBeUndefined();
    expect(typeof provider().auth.apiKey.login).toBe("function");
  });

  it("points at coralbricks.ai, prompts for a secret and stores a trimmed api_key credential", async () => {
    const io = interaction();
    const credential = await coralApiKeyAuth().login!(io);
    expect(credential).toEqual({ type: "api_key", key: "cb_pasted-key" });
    expect(io.notify).toHaveBeenCalledWith(expect.objectContaining({
      type: "info",
      message: expect.stringContaining("https://www.coralbricks.ai"),
      links: [expect.objectContaining({ url: CORALBRICKS_KEYS_URL })],
    }));
    expect(io.prompt).toHaveBeenCalledWith(expect.objectContaining({ type: "secret", message: expect.stringContaining("CoralBricks API key") }));
  });

  it("rejects an empty key and honors cancellation", async () => {
    await expect(coralApiKeyAuth().login!(interaction("   "))).rejects.toThrow("No CoralBricks API key entered");
    const controller = new AbortController();
    controller.abort();
    const io = { ...interaction(), signal: controller.signal };
    await expect(coralApiKeyAuth().login!(io)).rejects.toThrow();
    expect(io.prompt).not.toHaveBeenCalled();
  });

  it("resolves a stored auth.json key before CORALBRICKS_API_KEY, and nothing when neither is set", async () => {
    const auth = coralApiKeyAuth();
    const env = envCtx({ CORALBRICKS_API_KEY: "env-key" });
    const stored = await auth.resolve({ ctx: env, credential: { type: "api_key", key: "stored-key" }, signal: signal() });
    expect(stored?.auth.apiKey).toBe("stored-key");
    expect((await auth.resolve({ ctx: env, signal: signal() }))?.auth.apiKey).toBe("env-key");
    expect(await auth.resolve({ ctx: envCtx(), signal: signal() })).toBeUndefined();
  });
});

describe("parity with the config-form registration", () => {
  const legacy = (api: string) => composeModelProvider("coralbricks", undefined, { getProvider: () => undefined } as any, {
    baseUrl: "https://inference.coralbricks.ai/v1",
    apiKey: "$CORALBRICKS_API_KEY",
    api,
    models: buildCatalog(),
    streamSimple: () => { throw new Error("unused"); },
  } as any);
  let buildCatalog: () => any[];
  beforeEach(async () => {
    const { buildModels } = await import("../index");
    buildCatalog = () => buildModels(modelsData as any, customModelsData as any, patchData as any);
  });

  it.each(["openai-completions", "openai-responses"])("serves the same %s models Pi composed before", async (api) => {
    if (api === "openai-responses") {
      fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
      fs.writeFileSync(path.join(dir, "extensions", "coralbricks.json"), JSON.stringify({ api: "responses" }));
    }
    const { provider } = await setup();
    expect(provider().getModels()).toEqual(legacy(api).getModels());
  });

  it.each([
    ["a stored key", { type: "api_key", key: "stored-key" }, { CORALBRICKS_API_KEY: "env-key" }],
    ["CORALBRICKS_API_KEY", undefined, { CORALBRICKS_API_KEY: "env-key" }],
    ["no key", undefined, {}],
  ] as const)("resolves %s to the same request key", async (_label, credential, vars) => {
    const { provider } = await setup();
    const input = { ctx: envCtx(vars as any), credential: credential as any, signal: signal() };
    // With no key the config form threw on the unset $CORALBRICKS_API_KEY and the
    // native auth reports "not configured"; either way Pi has no request key.
    const before = await legacy("openai-completions").auth.apiKey!.resolve(input).catch(() => undefined);
    const after = await provider().auth.apiKey.resolve(input);
    expect(after?.auth.apiKey).toBe(before?.auth.apiKey);
    const legacyCheck = await legacy("openai-completions").auth.apiKey!.check!(input);
    expect(Boolean(after)).toBe(Boolean(legacyCheck));
  });
});

describe("catalog refresh after /login", () => {
  it("re-fetches /v1/models with a newly stored key and publishes the authenticated catalog", async () => {
    const fetch = vi.fn(async () => v1Models(["glm-5.3-fp4", "login-only"]));
    vi.stubGlobal("fetch", fetch);
    const { provider } = await setup();
    const context = refreshContext({ credential: { type: "api_key", key: "cb_new" } });
    await provider().refreshModels(context);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls[0] as any[])[0])).toBe("https://inference.coralbricks.ai/v1/models");
    expect((fetch.mock.calls[0] as any[])[1].headers.Authorization).toBe("Bearer cb_new");
    expect(context.publish).toHaveBeenCalledTimes(1);
    expect(context.publish.mock.calls[0][0].persist).toBeUndefined();
    expect(provider().getModels().map((m: any) => m.id)).toContain("login-only");
    expect(provider().getModels().every((m: any) => m.provider === "coralbricks" && m.api === "openai-completions")).toBe(true);
  });

  it("stays offline when Pi refreshes without network", async () => {
    const fetch = vi.fn(async () => v1Models(["login-only"]));
    vi.stubGlobal("fetch", fetch);
    const { provider } = await setup();
    const context = refreshContext({ allowNetwork: false, credential: { type: "api_key", key: "cb_new" } });
    await provider().refreshModels(context);
    expect(fetch).not.toHaveBeenCalled();
    expect(context.publish).not.toHaveBeenCalled();
  });

  it("leaves routine refreshes to session start, re-fetching only for a new key or a forced refresh", async () => {
    const fetch = vi.fn(async () => v1Models(["glm-5.3-fp4", "session-only"]));
    vi.stubGlobal("fetch", fetch);
    const { provider, handlers } = await setup();
    let key = "cb_session";
    const modelRegistry = { getApiKeyForProvider: vi.fn(async () => key) };
    await handlers.session_start({}, { modelRegistry });
    await vi.waitFor(() => expect(provider().getModels().map((m: any) => m.id)).toContain("session-only"));
    expect(fetch).toHaveBeenCalledTimes(1);

    // Startup and /model catalog refreshes with the same key: no extra request.
    await provider().refreshModels(refreshContext());
    expect(fetch).toHaveBeenCalledTimes(1);

    // /login stored a different key: Pi's resolution now returns it.
    key = "cb_logged_in";
    fetch.mockImplementation(async () => v1Models(["glm-5.3-fp4", "login-only"]));
    const context = refreshContext();
    await provider().refreshModels(context);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[1] as any[])[1].headers.Authorization).toBe("Bearer cb_logged_in");
    expect(provider().getModels().map((m: any) => m.id)).toContain("login-only");

    await provider().refreshModels(refreshContext({ force: true }));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("makes no request without a key, then syncs /v1/models once /login stores one", async () => {
    const fetch = vi.fn(async () => v1Models(["glm-5.3-fp4", "after-login"]));
    vi.stubGlobal("fetch", fetch);
    const { provider, handlers } = await setup();
    const before = provider().getModels().map((m: any) => m.id);
    let key: string | undefined;
    await handlers.session_start({}, { modelRegistry: { getApiKeyForProvider: vi.fn(async () => key) } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Pi's startup, /model and forced refreshes with no key stay offline too.
    await provider().refreshModels(refreshContext());
    await provider().refreshModels(refreshContext({ force: true }));
    expect(fetch).not.toHaveBeenCalled();
    expect(provider().getModels().map((m: any) => m.id)).toEqual(before);

    key = "cb_new";
    await provider().refreshModels(refreshContext({ credential: { type: "api_key", key } }));
    expect(fetch.mock.calls.map((call: any[]) => String(call[0]))).toEqual(["https://inference.coralbricks.ai/v1/models"]);
    expect((fetch.mock.calls[0] as any[])[1].headers.Authorization).toBe("Bearer cb_new");
    expect(provider().getModels().map((m: any) => m.id)).toContain("after-login");
  });

  it("syncs only the authenticated /v1/models, never the public catalog", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const { handlers } = await setup();
    await handlers.session_start({}, { modelRegistry: { getApiKeyForProvider: vi.fn(async () => "cb_session") } });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch.mock.calls.map((call: any[]) => String(call[0]))).toEqual(["https://inference.coralbricks.ai/v1/models"]);
  });

  it("keeps the current catalog when the refresh fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    const { provider } = await setup();
    const before = provider().getModels();
    const context = refreshContext({ credential: { type: "api_key", key: "cb_new" } });
    await provider().refreshModels(context);
    expect(context.publish).not.toHaveBeenCalled();
    expect(provider().getModels()).toEqual(before);
  });
});
