/**
 * Quiet startup sync, end to end through the extension's real session_start
 * handler: the live /models catalog is fetched only with a key, only when the
 * disk cache is stale (or the key changed), only by one process at a time, and
 * never on the session_start critical path.
 *
 * Porting: only the "Provider specifics" block below differs between
 * pi-*-provider repos.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyFingerprint, syncLockPath, syncMetaPath } from "../sync-policy";
import embeddedModels from "../models.json" with { type: "json" };

// ─── Provider specifics ───────────────────────────────────────────────────────
const PROVIDER_ID = "coralbricks";
const LIVE_ONLY_ID = "live-only-test-model";
/** A minimal successful /v1/models response containing LIVE_ONLY_ID. */
const liveModelsResponse = () => Response.json({
  data: [{
    id: LIVE_ONLY_ID,
    context_length: 65536,
    pricing: { input_per_m: 1, output_per_m: 2 },
  }],
});
// ──────────────────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const KEY = "sk-quiet-sync-test";

let home: string;
let cachePath: string;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

function setupHome(): void {
  home = fs.mkdtempSync(path.join(os.tmpdir(), `pi-${PROVIDER_ID}-sync-`));
  cachePath = path.join(home, "cache", `${PROVIDER_ID}-models.json`);
  vi.stubEnv("PI_CODING_AGENT_DIR", home);
  vi.stubEnv("PI_PROVIDER_SYNC_TTL_MS", "");
  vi.stubEnv("CORALBRICKS_API_KEY", "");
}

function writeCache(ageMs: number, models: unknown[] = embeddedModels, fingerprintKey: string | null = KEY): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(models));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(cachePath, t, t);
  if (fingerprintKey !== null) {
    fs.writeFileSync(syncMetaPath(cachePath), JSON.stringify({ version: 1, keyFingerprint: keyFingerprint(fingerprintKey) }));
  }
}

function stubFetch(impl: () => Promise<Response> = async () => liveModelsResponse()) {
  const fetch = vi.fn(impl);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** Load the extension fresh (module-level cache paths read PI_CODING_AGENT_DIR). */
async function loadExtension() {
  vi.resetModules();
  const mod = await import("../index");
  const handlers = new Map<string, (...args: any[]) => any>();
  const registrations: Array<{ models: Array<{ id: string }> }> = [];
  let provider: any;
  mod.default({
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    // Native pi-ai provider: snapshot the catalog each registration serves.
    registerProvider: (native: any) => { provider = native; registrations.push({ models: native.getModels() }); },
    registerCommand: () => {},
  } as any);
  const getApiKeyForProvider = vi.fn(async (): Promise<string | undefined> => KEY);
  const startSession = () => handlers.get("session_start")!({ type: "session_start" }, { modelRegistry: { getApiKeyForProvider } });
  /** Pi's catalog refresh (startup, /model, after /login with force). */
  const refresh = async (overrides: Record<string, unknown> = {}) => {
    const publish = vi.fn(async (publication: any) => { publication.update?.(); return true; });
    await provider.refreshModels({ allowNetwork: true, signal: new AbortController().signal, publish, credential: { type: "api_key", key: KEY }, ...overrides });
    return publish;
  };
  const served = () => provider.getModels() as Array<{ id: string }>;
  return { handlers, registrations, getApiKeyForProvider, startSession, refresh, served };
}

/** Let the fire-and-forget revalidation chain run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const hasLiveModel = (config: { models: Array<{ id: string }> } | undefined) => !!config?.models.some((m) => m.id === LIVE_ONLY_ID);

describe("quiet startup sync", () => {
  it("skips the live fetch while the disk cache is fresher than the TTL", async () => {
    setupHome();
    writeCache(10 * 60 * 1000);
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await settle();
    expect(ext.getApiKeyForProvider).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(ext.registrations).toHaveLength(1);
  });

  it("revalidates a stale cache once, hot-swaps the catalog and rewrites the cache", async () => {
    setupHome();
    writeCache(2 * HOUR);
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    // Cache stays a plain JSON array so older extension versions still read it.
    expect(Array.isArray(cached)).toBe(true);
    expect(cached.some((m: { id: string }) => m.id === LIVE_ONLY_ID)).toBe(true);
    expect(Date.now() - fs.statSync(cachePath).mtimeMs).toBeLessThan(60_000);
    expect(fs.existsSync(syncLockPath(cachePath))).toBe(false);
    const meta = fs.readFileSync(syncMetaPath(cachePath), "utf8");
    expect(meta).not.toContain(KEY);
    expect(JSON.parse(meta).keyFingerprint).toBe(keyFingerprint(KEY));

    // A second session in the same process (/new) is now inside the TTL.
    await ext.startSession();
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("never touches the network without an API key", async () => {
    setupHome();
    const fetch = stubFetch();
    const ext = await loadExtension();
    ext.getApiKeyForProvider.mockResolvedValue(undefined);
    await ext.startSession();
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(syncLockPath(cachePath))).toBe(false);
    expect(ext.registrations).toHaveLength(1);
  });

  it("skips when another process holds the revalidation lock", async () => {
    setupHome();
    writeCache(2 * HOUR);
    fs.writeFileSync(syncLockPath(cachePath), JSON.stringify({ pid: 999999, token: "other-process" }));
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(syncLockPath(cachePath), "utf8")).token).toBe("other-process");
  });

  it("reclaims a stale lock left by a crashed process", async () => {
    setupHome();
    writeCache(2 * HOUR);
    const lockPath = syncLockPath(cachePath);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: "crashed" }));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockPath, old, old);
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("forces a revalidation when the API key changed, even inside the TTL", async () => {
    setupHome();
    writeCache(60 * 1000, embeddedModels, "previous-key");
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("revalidates once when the cache predates the sync sidecar (older extension version)", async () => {
    setupHome();
    writeCache(60 * 1000, embeddedModels, null);
    const fetch = stubFetch();
    const ext = await loadExtension();
    expect(ext.registrations[0].models.length).toBeGreaterThan(0); // old cache is still served
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not throw or fetch when the cache dir is unwritable", async () => {
    setupHome();
    fs.writeFileSync(path.join(home, "cache"), "a file where the cache dir should be");
    const fetch = stubFetch();
    const ext = await loadExtension();
    await expect(ext.startSession()).resolves.toBeUndefined();
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(ext.registrations).toHaveLength(1);
  });

  it("does not await the network in session_start", async () => {
    setupHome();
    writeCache(2 * HOUR);
    let release!: () => void;
    const fetch = stubFetch(() => new Promise<Response>((resolve) => { release = () => resolve(liveModelsResponse()); }));
    const ext = await loadExtension();
    const outcome = await Promise.race([
      Promise.resolve(ext.startSession()).then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 1000)),
    ]);
    expect(outcome).toBe("returned");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    release();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
  });

  it("swallows API key resolution failures (no unhandled rejection)", async () => {
    setupHome();
    const fetch = stubFetch();
    const ext = await loadExtension();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      ext.getApiKeyForProvider.mockRejectedValue(new Error("keychain locked"));
      await ext.startSession();
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("backs off after a failed fetch instead of retrying in every new process", async () => {
    setupHome();
    writeCache(2 * HOUR);
    const fetch = stubFetch(async () => new Response("unauthorized", { status: 401 }));
    let ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await settle();
    ext = await loadExtension(); // next pi process
    await ext.startSession();
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("adopts a cache refreshed by another process without fetching", async () => {
    setupHome();
    writeCache(30 * 60 * 1000);
    const fetch = stubFetch();
    const ext = await loadExtension();
    // Another pi process revalidated after this one started.
    const refreshed = [...embeddedModels, { ...embeddedModels[0], id: LIVE_ONLY_ID }];
    fs.writeFileSync(cachePath, JSON.stringify(refreshed));
    await ext.startSession();
    await vi.waitFor(() => expect(hasLiveModel(ext.registrations.at(-1))).toBe(true));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("PI_PROVIDER_SYNC_TTL_MS=0 revalidates on every session start", async () => {
    setupHome();
    vi.stubEnv("PI_PROVIDER_SYNC_TTL_MS", "0");
    writeCache(0);
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  });
});

// ─── Provider specifics: native refreshModels and the single-registration guard ─

describe("quiet startup sync: Pi catalog refreshes", () => {
  it("serves a fresh disk cache to Pi's startup refresh instead of fetching", async () => {
    setupHome();
    writeCache(10 * 60 * 1000);
    const fetch = stubFetch();
    const ext = await loadExtension();
    const publish = await ext.refresh();
    expect(fetch).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("revalidates inside the TTL when Pi forces the refresh after /login", async () => {
    setupHome();
    writeCache(10 * 60 * 1000);
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.startSession();
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    await ext.refresh({ force: true });
    expect(fetch).toHaveBeenCalledOnce();
    expect(hasLiveModel({ models: ext.served() })).toBe(true);
    expect(fs.existsSync(syncLockPath(cachePath))).toBe(false);
  });

  it("lets a new key's refresh fetch even while the session revalidation holds the lock", async () => {
    setupHome();
    writeCache(2 * HOUR);
    let release!: () => void;
    const fetch = stubFetch(() => new Promise<Response>((resolve, reject) => {
      const signal = (fetch.mock.calls.at(-1) as any[])?.[1]?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => reject(signal.reason));
      release = () => resolve(liveModelsResponse());
    }));
    const ext = await loadExtension();
    await ext.startSession();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce()); // session sync in flight, lock held
    ext.getApiKeyForProvider.mockResolvedValue("sk-new-login-key");
    const refreshed = ext.refresh();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    release();
    await refreshed;
    expect((fetch.mock.calls[1] as any[])[1].headers.Authorization).toBe("Bearer sk-new-login-key");
    expect(hasLiveModel({ models: ext.served() })).toBe(true);
    expect(JSON.parse(fs.readFileSync(syncMetaPath(cachePath), "utf8")).keyFingerprint).toBe(keyFingerprint("sk-new-login-key"));
    expect(fs.existsSync(syncLockPath(cachePath))).toBe(false);
  });

  it("keeps Pi's offline refreshes off the network", async () => {
    setupHome();
    const fetch = stubFetch();
    const ext = await loadExtension();
    await ext.refresh({ allowNetwork: false, force: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(syncLockPath(cachePath))).toBe(false);
  });
});

describe("quiet startup sync: two copies in one runtime", () => {
  /** Load the whole extension as `version` into a real Pi runtime sharing `bus`. */
  async function loadCopy(bus: unknown, runtime: unknown, version: string) {
    const { loadExtensionFromFactory } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
    vi.resetModules();
    vi.doMock("../package.json", () => ({ default: { version } }));
    const { default: extension } = await import("../index");
    vi.doUnmock("../package.json");
    return loadExtensionFromFactory(extension as any, home, bus as any, runtime as any, `<coralbricks ${version}>`);
  }

  it("only the owning copy takes the lease or fetches; the resigned copy stays off the network and the lock", async () => {
    setupHome();
    writeCache(2 * HOUR);
    const { createExtensionRuntime } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
    const { createEventBus } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js");
    const bus = createEventBus();
    const runtime = createExtensionRuntime();
    const older = await loadCopy(bus, runtime, "1.0.32");
    const newer = await loadCopy(bus, runtime, "1.0.40"); // takes over; older resigns
    const natives = runtime.pendingNativeProviderRegistrations.filter(({ provider }: any) => provider.id === PROVIDER_ID);
    const resigned = natives[0].provider;
    const owner = natives.at(-1)!.provider;

    // The resigned copy: Pi's forced refresh and its session start reach neither the network nor the lock.
    const lockSpy = vi.spyOn(fs, "openSync");
    const publish = vi.fn();
    await resigned.refreshModels({ allowNetwork: true, force: true, signal: new AbortController().signal, publish, credential: { type: "api_key", key: KEY } });
    const fetch = stubFetch();
    const modelRegistry = { getApiKeyForProvider: vi.fn(async () => KEY) };
    for (const handler of older.handlers.get("session_start") ?? []) await handler({ type: "session_start" }, { modelRegistry });
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(lockSpy).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();

    // The owner syncs once.
    for (const handler of newer.handlers.get("session_start") ?? []) await handler({ type: "session_start" }, { modelRegistry });
    await vi.waitFor(() => expect(owner.getModels().some((m: { id: string }) => m.id === LIVE_ONLY_ID)).toBe(true));
    expect(fetch).toHaveBeenCalledOnce();
    expect(fs.existsSync(syncLockPath(cachePath))).toBe(false);
  });
});
