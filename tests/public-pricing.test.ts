import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyListPricing, loadPublicListPricing } from "../scripts/update-models.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
const publicRow = {
  slug: "deepseek-v4.1-flash-fast", name: "DeepSeek V4.1 Flash Fast", contextWindow: "1M",
  inputPerM: 0.45, outputPerM: 1.8, cacheReadPerM: 0.009, cacheWritePerM: 0,
};
const publicCost = { input: 0.45, output: 1.8, cacheRead: 0.009, cacheWrite: 0.45 };
const legacy = {
  id: publicRow.slug, name: publicRow.name, reasoning: true, input: ["text", "image"],
  cost: { input: 0.01, output: 1.2, cacheRead: 0, cacheWrite: 0.09 },
  contextWindow: 1048576, maxTokens: 32768,
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request in an offline test"); }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(snapshot = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coral-public-pricing-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(path.join(root, "scripts/update-models.js"), path.join(dir, "scripts/update-models.js"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  for (const [name, value] of Object.entries({
    "models.json": [legacy], "patch.json": {}, "custom-models.json": [], "deprecated-models.json": {},
  })) fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  const snapshotPath = path.join(dir, "public-pricing.json");
  if (snapshot) fs.writeFileSync(snapshotPath, JSON.stringify({ [publicRow.slug]: publicCost }));
  fs.writeFileSync(path.join(dir, "README.md"), "## Available Models\n\n| Model | Input |\n|-------|-------|\n| preserved table | $0.45 |\n\n");
  return { dir, snapshotPath };
}

function runCli(dir: string, { offline = false, keyless = false, failPublic = false } = {}) {
  const preloader = `import fs from 'node:fs';
    globalThis.fetch = async (url, options) => {
      fs.appendFileSync('requests.log', String(url) + '\\n');
      if (${offline}) throw new Error('offline command must never fetch');
      if (String(url).includes('/v1/models')) return new Response(JSON.stringify({data:[{
        id:${JSON.stringify(legacy.id)}, name:${JSON.stringify(legacy.name)}, context_length:1048576,
        supports_image_input:true, pricing:{input_per_m:0.01, output_per_m:1.2, cached_input_per_m:0, cache_write_per_m:0.08}
      }]}));
      if (!options?.signal) throw new Error('missing fetch deadline');
      if (${failPublic}) return new Response('unavailable', {status:503});
      return new Response(JSON.stringify({models:[${JSON.stringify(publicRow)}]}));
    };`;
  fs.writeFileSync(path.join(dir, "preload.mjs"), preloader);
  const result = spawnSync(process.execPath, ["--import", "./preload.mjs", "scripts/update-models.js", ...(offline ? ["--readme-only"] : [])], {
    cwd: dir, timeout: 5000, encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(dir, "no-auth"), CORALBRICKS_API_KEY: keyless ? "" : "test-key" },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const requests = fs.existsSync(path.join(dir, "requests.log")) ? fs.readFileSync(path.join(dir, "requests.log"), "utf8").trim().split("\n") : [];
  return { requests, readme: fs.readFileSync(path.join(dir, "README.md"), "utf8"), models: JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8")) };
}

describe("public README pricing", () => {
  it("regenerates offline without a request, using public prices rather than the legacy key", () => {
    const { dir } = workspace();
    const result = runCli(dir, { offline: true });
    expect(result.requests).toEqual([]);
    expect(result.readme).toContain("$0.45 | $0.009 | $0.45 | $1.80");
    expect(result.models[0].cost).toEqual(legacy.cost);
  });

  it("keeps public prices on HTTP failure without changing the legacy key's model costs", () => {
    const { dir, snapshotPath } = workspace();
    const before = fs.readFileSync(snapshotPath, "utf8");
    const result = runCli(dir, { failPublic: true });
    expect(result.requests).toHaveLength(2);
    expect(result.readme).toContain("$0.45 | $0.009 | $0.45 | $1.80");
    expect(result.models[0].cost).toEqual(legacy.cost);
    expect(fs.readFileSync(snapshotPath, "utf8")).toBe(before);
  });

  it("leaves the table unchanged when no public snapshot is available offline", () => {
    const { dir } = workspace(false);
    const before = fs.readFileSync(path.join(dir, "README.md"), "utf8");
    const result = runCli(dir, { offline: true });
    expect(result.requests).toEqual([]);
    expect(result.readme).toBe(before);
  });

  it("leaves the table unchanged when both the public catalog and snapshot are unavailable", () => {
    const { dir } = workspace(false);
    const before = fs.readFileSync(path.join(dir, "README.md"), "utf8");
    expect(runCli(dir, { failPublic: true }).readme).toBe(before);
  });

  it("reuses the keyless catalog, carrying cached-read rates into both model and README prices", () => {
    const { dir, snapshotPath } = workspace(false);
    const result = runCli(dir, { keyless: true });
    expect(result.requests).toEqual(["https://www.coralbricks.ai/api/public/models"]);
    expect(result.models[0].cost).toEqual(publicCost);
    expect(result.readme).toContain("$0.009");
    expect(JSON.parse(fs.readFileSync(snapshotPath, "utf8"))).toEqual({ [publicRow.slug]: publicCost });
  });

  it.each([
    { catalog: [] },
    { catalog: [{ ...publicRow, cacheReadPerM: undefined }] },
    { catalog: [{ ...publicRow, inputPerM: -1 }] },
  ])(
    "does not replace a valid snapshot with empty or malformed catalog rows: $catalog", async ({ catalog }) => {
      const { snapshotPath } = workspace();
      const before = fs.readFileSync(snapshotPath, "utf8");
      const prices = await loadPublicListPricing({ refresh: true, catalog, snapshotPath });
      expect(prices?.get(publicRow.slug)).toEqual(publicCost);
      expect(fs.readFileSync(snapshotPath, "utf8")).toBe(before);
    },
  );

  it("retains last-known public rates for slugs absent from a newer public catalog", async () => {
    const { snapshotPath } = workspace();
    const prices = await loadPublicListPricing({ refresh: true, catalog: [{ ...publicRow, slug: "new-model" }], snapshotPath });
    expect(prices?.get(publicRow.slug)).toEqual(publicCost);
    expect(prices?.get("new-model")).toEqual(publicCost);
  });

  it("preserves legitimate zero prices in the public snapshot", async () => {
    const { snapshotPath } = workspace();
    const catalog = [{ ...publicRow, inputPerM: 0, outputPerM: 0, cacheReadPerM: 0 }];
    const prices = await loadPublicListPricing({ refresh: true, catalog, snapshotPath });
    expect(prices?.get(publicRow.slug)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("bounds network requests and falls back when the request rejects", async () => {
    const { snapshotPath } = workspace();
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      throw new Error("request timed out");
    });
    vi.stubGlobal("fetch", fetch);
    const prices = await loadPublicListPricing({ refresh: true, snapshotPath });
    expect(fetch).toHaveBeenCalledOnce();
    expect(prices?.get(publicRow.slug)).toEqual(publicCost);
  });

  it("rejects a corrupt saved price rather than leaking a model's legacy price", async () => {
    const { snapshotPath } = workspace();
    fs.writeFileSync(snapshotPath, JSON.stringify({ [publicRow.slug]: { ...publicCost, cacheRead: "0.009" } }));
    expect(await loadPublicListPricing({ snapshotPath })).toBeNull();
  });

  it("requires public rates for every API model before mutating any row", () => {
    const models = [structuredClone(legacy), { ...structuredClone(legacy), id: "unlisted" }];
    expect(applyListPricing(models, new Map([[legacy.id, publicCost]]))).toBe(false);
    expect(models[0].cost).toEqual(legacy.cost);
  });

  it("permits explicit custom-model prices but never changes embedded source costs", () => {
    const model = structuredClone(legacy);
    const source = model.cost;
    const custom = { ...structuredClone(legacy), id: "custom-router" };
    expect(applyListPricing([model, custom], new Map([[legacy.id, publicCost]]), [custom])).toBe(true);
    expect(model.cost).toEqual(publicCost);
    expect(source).toEqual(legacy.cost);
    expect(custom.cost).toEqual(legacy.cost);
  });
});
