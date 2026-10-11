import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// The real host's extension loader and event bus: copies coordinate through what Pi gives them.
import { createExtensionRuntime, loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { createEventBus } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import { claimRuntime, compareVersions, type CoralCopy } from "../guard";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "coral-guard-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  vi.stubEnv("CORALBRICKS_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("../package.json");
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("compareVersions", () => {
  it.each([
    ["1.0.32", "1.0.31", 1],
    ["1.0.31", "1.0.32", -1],
    ["1.0.32", "1.0.32", 0],
    ["1.10.0", "1.9.9", 1],
    ["2.0.0", "1.99.99", 1],
    ["1.0.32", "1.0.32-rc.1", 1],
    ["1.0.32-rc.2", "1.0.32-rc.10", -1],
    ["1.0.32-alpha", "1.0.32-1", 1],
    ["1.0.32-alpha.1", "1.0.32-alpha", 1],
    ["v1.0.32", "1.0.32", 0],
    ["1.0.32+build.5", "1.0.32", 0],
    ["1.0.0", "not-a-version", 1],
    ["garbage", "1.0.0", -1],
    ["garbage", "", 0],
  ])("%s vs %s → %i", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

/** A real Pi extension runtime: shared event bus, real pending-registration queue. */
function runtime(bus = createEventBus()) {
  return { bus, runtime: createExtensionRuntime() };
}

function fakeCopy(version: string): CoralCopy & { resign: ReturnType<typeof vi.fn> } {
  return { version, resign: vi.fn(), settings: vi.fn(async () => {}) };
}

async function claimIn(scope: ReturnType<typeof runtime>, copy: CoralCopy) {
  let claim!: ReturnType<typeof claimRuntime>;
  await loadExtensionFromFactory((pi: any) => { claim = claimRuntime(pi, copy); }, dir, scope.bus, scope.runtime, `<copy ${copy.version}>`);
  return claim;
}

describe("claimRuntime", () => {
  it("gives the first copy the runtime and keeps it on equal or older later copies", async () => {
    const scope = runtime();
    const first = fakeCopy("1.0.32");
    const a = await claimIn(scope, first);
    expect(a.first).toBe(true);
    expect(a.owns()).toBe(true);

    const equal = await claimIn(scope, fakeCopy("1.0.32"));
    const older = await claimIn(scope, fakeCopy("1.0.31"));
    expect(equal.first).toBe(false);
    expect(equal.owns()).toBe(false);
    expect(older.owns()).toBe(false);
    expect(a.owns()).toBe(true);
    expect(first.resign).not.toHaveBeenCalled();
    expect(older.owner()).toBe(first);
  });

  it("hands the runtime to a newer copy that loads later, once", async () => {
    const scope = runtime();
    const older = fakeCopy("1.0.32");
    const a = await claimIn(scope, older);
    const newer = fakeCopy("1.1.0");
    const b = await claimIn(scope, newer);
    expect(b.first).toBe(false);
    expect(b.owns()).toBe(true);
    expect(a.owns()).toBe(false);
    expect(older.resign).toHaveBeenCalledTimes(1);
    expect(a.owner()).toBe(newer);

    // A third copy between the two changes nothing: no flapping.
    const middle = await claimIn(scope, fakeCopy("1.0.40"));
    expect(middle.owns()).toBe(false);
    expect(b.owns()).toBe(true);
    expect(newer.resign).not.toHaveBeenCalled();
  });

  it("keeps runtimes apart, even within one process", async () => {
    const a = await claimIn(runtime(), fakeCopy("1.0.32"));
    const b = await claimIn(runtime(), fakeCopy("1.0.31"));
    expect(a.owns()).toBe(true);
    expect(b.owns()).toBe(true);
    expect(b.first).toBe(true);
  });

  it("starts a reloaded runtime empty instead of inheriting a stale owner", async () => {
    const bus = createEventBus();
    const before = runtime(bus);
    const stale = await claimIn(before, fakeCopy("9.0.0"));
    // /reload: session_shutdown, then Pi invalidates the old runtime, dropping its
    // bus subscriptions, and loads the extensions again on the same bus.
    before.runtime.invalidate();
    const after = await claimIn(runtime(bus), fakeCopy("1.0.32"));
    expect(after.first).toBe(true);
    expect(after.owns()).toBe(true);
    expect(stale.owns()).toBe(true); // the dead generation's view, never consulted again
  });

  it("ends ownership with the session", async () => {
    const scope = runtime();
    const owner = await claimIn(scope, fakeCopy("1.0.32"));
    const other = await claimIn(scope, fakeCopy("1.0.31"));
    other.release();
    expect(owner.owns()).toBe(true);
    owner.release();
    expect(owner.owns()).toBe(false);
    expect(owner.owner()).toBeUndefined();
  });

  it("gives each copy its own scope on a host without an event bus", () => {
    const pi = { registerProvider: vi.fn() } as any;
    expect(claimRuntime(pi, fakeCopy("1.0.32")).owns()).toBe(true);
    expect(claimRuntime(pi, fakeCopy("1.0.32")).owns()).toBe(true);
  });

  it("shares one registry across module roots through Symbol.for", async () => {
    const scope = runtime();
    const a = await claimIn(scope, fakeCopy("1.0.32"));
    vi.resetModules();
    const other = await import("../guard"); // a separate module instance, as a second install would load
    expect(other.claimRuntime).not.toBe(claimRuntime);
    let b!: ReturnType<typeof claimRuntime>;
    await loadExtensionFromFactory((pi: any) => { b = other.claimRuntime(pi, fakeCopy("1.0.31")); }, dir, scope.bus, scope.runtime, "<other root>");
    expect(b.owns()).toBe(false);
    expect(a.owns()).toBe(true);
  });
});

// Two copies of the whole extension, loaded from separate module instances into one runtime.
async function loadCopy(scope: ReturnType<typeof runtime>, version: string) {
  vi.resetModules();
  vi.doMock("../package.json", () => ({ default: { version } }));
  const { default: extension } = await import("../index");
  vi.doUnmock("../package.json");
  const loaded = await loadExtensionFromFactory(extension as any, dir, scope.bus, scope.runtime, `<coralbricks ${version}>`);
  const handlers = (event: string) => loaded.handlers.get(event) ?? [];
  return { version, loaded, handlers };
}

/** The provider Pi would serve: registrations apply in queue order and a native id replaces the previous one. */
function served(scope: ReturnType<typeof runtime>) {
  const natives = scope.runtime.pendingNativeProviderRegistrations.filter(({ provider }: any) => provider.id === "coralbricks");
  return { count: natives.length, provider: natives.at(-1)?.provider, path: natives.at(-1)?.extensionPath };
}

function v1Models(ids: string[]) {
  return Response.json({ data: ids.map((id) => ({ id, context_length: 131072, pricing: { input_per_m: 1, output_per_m: 2 } })) });
}

async function startSession(copies: Array<Awaited<ReturnType<typeof loadCopy>>>, key: string | undefined | (() => string | undefined)) {
  const modelRegistry = { getApiKeyForProvider: vi.fn(async () => typeof key === "function" ? key() : key) };
  for (const copy of copies) for (const handler of copy.handlers("session_start")) await handler({ type: "session_start" }, { modelRegistry });
  return modelRegistry;
}

describe("two copies in one runtime", () => {
  it.each([
    ["older first", ["1.0.32", "1.0.40"]],
    ["newer first", ["1.0.40", "1.0.32"]],
  ])("serves only the newer copy when it loads %s, with one sync and one command", async (_label, order) => {
    const fetch = vi.fn(async () => v1Models(["glm-5.3-fast", "synced"]));
    vi.stubGlobal("fetch", fetch);
    const scope = runtime();
    const copies = [];
    for (const version of order) copies.push(await loadCopy(scope, version));

    expect(served(scope).path).toBe("<coralbricks 1.0.40>");
    // Newer first: the older copy registers nothing. Older first: it registered
    // before the takeover and the newer registration replaces it in load order.
    expect(served(scope).count).toBe(order[0] === "1.0.40" ? 1 : 2);
    const commands = copies.flatMap((copy) => [...copy.loaded.commands.keys()]);
    expect(commands).toEqual(["coralbricks-settings"]);

    await startSession(copies, "cb_key");
    await vi.waitFor(() => expect(served(scope).provider.getModels().map((m: any) => m.id)).toContain("synced"));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls[0] as any[])[0])).toBe("https://inference.coralbricks.ai/v1/models");
  });

  it("serves /coralbricks-settings through the copy that owns the runtime", async () => {
    const scope = runtime();
    const older = await loadCopy(scope, "1.0.32");
    const newer = await loadCopy(scope, "1.0.40");
    const command = older.loaded.commands.get("coralbricks-settings")!;
    const before = served(scope).count;
    const ui = { notify: vi.fn(), select: vi.fn(async () => "responses"), custom: vi.fn() };
    await command.handler("", { mode: "rpc", hasUI: true, ui } as any);
    // The newer copy applied the change and re-registered; the resigned copy stayed out.
    const after = scope.runtime.pendingNativeProviderRegistrations.slice(before);
    expect(after.map(({ extensionPath }: any) => extensionPath)).toEqual(["<coralbricks 1.0.40>"]);
    expect(after[0].provider.getModels()[0].api).toBe("openai-responses");
    expect(newer.loaded.commands.size).toBe(0);
  });

  it("lets a reloaded runtime register again", async () => {
    const bus = createEventBus();
    const first = runtime(bus);
    const copies = [await loadCopy(first, "1.0.40"), await loadCopy(first, "1.0.32")];
    for (const copy of copies) for (const handler of copy.handlers("session_shutdown")) await handler({ type: "session_shutdown", reason: "reload" }, {});
    first.runtime.invalidate();
    const second = runtime(bus);
    await loadCopy(second, "1.0.32");
    await loadCopy(second, "1.0.40");
    expect(served(second).path).toBe("<coralbricks 1.0.40>");
  });
});
