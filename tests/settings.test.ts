import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configPath, loadConfig, saveApi, saveConfig, registerSettingsCommand } from "../settings";

const DEFAULTS = { api:"chat-completions", park:false, cacheOptimized:false, cacheOptimizedShortcut:"ctrl+alt+c" };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "coral-settings-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});
function raw(value: unknown) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(value));
}
function command() {
  let config = loadConfig();
  const pi = { registerCommand: vi.fn() };
  const apply = vi.fn((next) => { config = next; });
  registerSettingsCommand(pi as any, () => config, apply);
  expect(pi.registerCommand.mock.calls[0][0]).toBe("coralbricks-settings");
  return { handler: pi.registerCommand.mock.calls[0][1].handler, apply };
}
function context(mode = "rpc", hasUI = true) {
  return { mode, hasUI, ui: { notify: vi.fn(), select: vi.fn(), custom: vi.fn() } };
}

describe("configuration", () => {
  it("defaults to chat without creating a file", () => {
    expect(loadConfig().api).toBe("chat-completions");
    expect(fs.existsSync(configPath())).toBe(false);
  });
  it.each([null, [], false, {api:true}, {api:"openai-responses"}])("safely defaults invalid config %j", (value) => {
    raw(value);
    expect(loadConfig().api).toBe("chat-completions");
  });
  it("persists opt-in/out, preserving unknown fields and leaving no temporary files", () => {
    raw({ other: { keep: true } });
    saveApi("responses");
    expect(loadConfig().api).toBe("responses");
    saveApi("chat-completions");
    expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toEqual({ api:"chat-completions", other:{keep:true} });
    expect(fs.readdirSync(path.dirname(configPath()))).toEqual(["coralbricks.json"]);
  });
  it("reads parking only when it is literally true and preserves it across API toggles", () => {
    expect(loadConfig().park).toBe(false);
    raw({ api:"responses", park:"yes" });
    expect(loadConfig().park).toBe(false);
    saveConfig({ park:true });
    expect(loadConfig()).toEqual({ ...DEFAULTS, api:"responses", park:true });
    saveApi("chat-completions");
    expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toEqual({ api:"chat-completions", park:true });
  });
  it("does not overwrite malformed files", () => {
    raw({});
    fs.writeFileSync(configPath(), "broken");
    expect(loadConfig().api).toBe("chat-completions");
    expect(() => saveApi("responses")).toThrow();
    expect(fs.readFileSync(configPath(), "utf8")).toBe("broken");
  });
  it("reads cache-optimized only when it is literally true", () => {
    expect(loadConfig().cacheOptimized).toBe(false);
    raw({ cacheOptimized:"yes" });
    expect(loadConfig().cacheOptimized).toBe(false);
    raw({ cacheOptimized:true });
    expect(loadConfig().cacheOptimized).toBe(true);
  });
  it.each([
    [undefined, "ctrl+alt+c"], [42, "ctrl+alt+c"], ["  ", "ctrl+alt+c"],
    [" alt+x ", "alt+x"], [null, null], [false, null],
  ])("reads cacheOptimizedShortcut %j as %j", (value, expected) => {
    raw(value === undefined ? {} : { cacheOptimizedShortcut:value });
    expect(loadConfig().cacheOptimizedShortcut).toBe(expected);
  });
});

describe("settings command", () => {
  it("offers RPC selection and applies immediately", async () => {
    const { handler, apply } = command();
    const ctx = context();
    ctx.ui.select.mockResolvedValue("responses");
    await handler("", ctx);
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(loadConfig().api).toBe("responses");
    expect(apply).toHaveBeenCalledWith({...DEFAULTS,api:"responses"});
  });
  it("asks about parking after choosing Responses over RPC, then about cache-optimized", async () => {
    const { handler, apply } = command();
    const ctx = context();
    ctx.ui.select.mockResolvedValueOnce("responses").mockResolvedValueOnce("on").mockResolvedValueOnce("on");
    await handler("", ctx);
    expect(ctx.ui.select).toHaveBeenCalledTimes(3);
    expect(ctx.ui.select.mock.calls[2][0]).toContain("X-Coral-Pricing: cache-optimized");
    expect(loadConfig()).toEqual({ ...DEFAULTS, api:"responses", park:true, cacheOptimized:true });
    expect(apply).toHaveBeenLastCalledWith({...DEFAULTS,api:"responses",park:true,cacheOptimized:true});
  });
  it("does not ask about parking for Chat Completions", async () => {
    const { handler } = command();
    const ctx = context();
    ctx.ui.select.mockResolvedValueOnce("chat-completions").mockResolvedValueOnce(undefined);
    await handler("", ctx);
    expect(ctx.ui.select).toHaveBeenCalledTimes(2);
    expect(ctx.ui.select.mock.calls[1][0]).toContain("X-Coral-Pricing");
    expect(loadConfig().cacheOptimized).toBe(false);
  });
  it.each([
    ["cache-optimized", [true, false]],
    ["cache-optimized toggle", [true, false]],
    ["Cache-Optimized ON", [true, true]],
    ["cache-optimized off", [false, false]],
  ] as const)("%s sets the header without a dialog", async (args, expected) => {
    const { handler, apply } = command();
    for (const on of expected) {
      const ctx = context("json", false);
      await handler(args, ctx);
      expect(ctx.ui.select).not.toHaveBeenCalled();
      expect(ctx.ui.custom).not.toHaveBeenCalled();
      expect(loadConfig().cacheOptimized).toBe(on);
      expect(apply).toHaveBeenLastCalledWith({...DEFAULTS,cacheOptimized:on});
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(`cache-optimized: ${on ? "on" : "off"}`), "info");
    }
  });
  it("leaves cache-optimized unchanged when the toggle cannot save", async () => {
    raw(null);
    const { handler, apply } = command();
    const ctx = context();
    await handler("cache-optimized", ctx);
    expect(apply).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("pricing header unchanged"), "error");
  });
  it("does nothing on cancel or without UI", async () => {
    const { handler, apply } = command();
    await handler("", context());
    const ctx = context("json", false);
    await handler("", ctx);
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(fs.existsSync(configPath())).toBe(false);
  });
  it("reports save failure without applying", async () => {
    raw(null);
    const { handler, apply } = command();
    const ctx = context();
    ctx.ui.select.mockResolvedValue("responses");
    await handler("", ctx);
    expect(apply).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("API unchanged"), "error");
  });
  it("leaves config and runtime unchanged when an atomic write fails", async () => {
    saveApi("chat-completions");
    const { handler, apply } = command();
    const ctx = context();
    ctx.ui.select.mockResolvedValue("responses");
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("permission denied"); });
    await handler("", ctx);
    expect(loadConfig().api).toBe("chat-completions");
    expect(apply).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.dirname(configPath()))).toEqual(["coralbricks.json"]);
  });
  it("restores the displayed value after a failed TUI save", async () => {
    raw(null);
    const { handler, apply } = command();
    const ctx = context("tui");
    ctx.ui.custom.mockImplementation(async (factory) => {
      const component = factory({requestRender:vi.fn()}, {fg:(_c:string,s:string)=>s}, {}, vi.fn());
      component.handleInput("\r");
      expect(component.render(80).join("\n")).toContain("chat-completions");
      expect(apply).not.toHaveBeenCalled();
    });
    await handler("", ctx);
  });
  it("renders the real SettingsList at narrow widths, toggles and exits", async () => {
    const { handler, apply } = command();
    const ctx = context("tui");
    const { visibleWidth } = await import("@earendil-works/pi-tui");
    ctx.ui.custom.mockImplementation(async (factory) => {
      const done = vi.fn();
      const render = vi.fn();
      const component = factory({requestRender:render}, {fg:(_c:string,s:string)=>s}, {}, done);
      for (const width of [24, 80]) {
        expect(component.render(width).every((line:string) => visibleWidth(line) <= width)).toBe(true);
      }
      component.handleInput("\r");
      expect(loadConfig().api).toBe("responses");
      expect(component.render(80).join("\n")).toContain("responses");
      component.handleInput("\u001b[B");
      component.handleInput("\r");
      expect(loadConfig().park).toBe(true);
      component.handleInput("\u001b[B");
      expect(component.render(80).join("\n")).toContain("ctrl+alt+c");
      component.handleInput("\r");
      expect(loadConfig().cacheOptimized).toBe(true);
      component.invalidate();
      component.handleInput("\u001b");
      expect(done).toHaveBeenCalled();
      expect(render).toHaveBeenCalled();
    });
    await handler("", ctx);
    expect(apply).toHaveBeenCalledWith({...DEFAULTS,api:"responses"});
  });
});

describe("provider registration", () => {
  async function setup() {
    vi.resetModules();
    const { default: extension } = await import("../index");
    const pi = {registerProvider:vi.fn(),registerCommand:vi.fn(),registerShortcut:vi.fn(),on:vi.fn()};
    extension(pi as any);
    // The native provider, viewed through the config-form fields these tests pinned.
    const latest = () => {
      const provider = pi.registerProvider.mock.calls.at(-1)![0];
      const models = provider.getModels();
      return {provider, models, api:models[0].api, baseUrl:provider.baseUrl, streamSimple:provider.streamSimple};
    };
    const handler = pi.registerCommand.mock.calls[0][1].handler;
    return {pi, latest, handler};
  }
  it.each(["chat-completions", "responses"] as const)("loads %s at startup", async (api) => {
    if (api === "responses") saveApi(api);
    const {latest} = await setup();
    expect(latest().api).toBe(api === "responses" ? "openai-responses" : "openai-completions");
    const env = async (name:string) => name === "CORALBRICKS_API_KEY" ? "env-key" : undefined;
    const resolved = await latest().provider.auth.apiKey.resolve({ctx:{env, fileExists:async()=>false}, signal:new AbortController().signal});
    expect(resolved?.auth.apiKey).toBe("env-key");
  });
  it("keeps opt-in across in-flight refresh and fresh models across toggles", async () => {
    let finish!: (r:Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const {pi, latest, handler} = await setup();
    const start = pi.on.mock.calls.find(c => c[0] === "session_start")![1];
    await start({}, {modelRegistry:{getApiKeyForProvider:async()=>"test-key"}});
    await vi.waitFor(() => expect(finish).toBeDefined());
    const ctx = context();
    ctx.ui.select.mockResolvedValue("responses");
    await handler("", ctx);
    finish(Response.json({data:[{id:"live-only",context_length:123456,pricing:{}}]}));
    await vi.waitFor(() => expect(latest().models.some((m:any)=>m.id === "live-only")).toBe(true));
    expect(latest().api).toBe("openai-responses");
    ctx.ui.select.mockResolvedValue("chat-completions");
    await handler("", ctx);
    expect(latest().api).toBe("openai-completions");
    expect(latest().models.some((m:any)=>m.id === "live-only")).toBe(true);
  });
  it.each([false, true])("applies parking=%s to Responses requests", async (park) => {
    saveConfig({ api:"responses", park });
    const {latest} = await setup();
    const registration = latest();
    const model = {...registration.models[0], provider:"coralbricks", baseUrl:registration.baseUrl, api:registration.api};
    let body: any;
    await registration.streamSimple(model, {messages:[{role:"user",content:"hi",timestamp:1}]}, {
      apiKey:"test", maxRetries:0,
      fetch:async (_input:any, init:any) => { body = JSON.parse(init.body); return Response.json({error:{message:"test"}}, {status:400}); },
    }).result();
    expect(body.store).toBe(park);
  });
  it("registers the toggle shortcut from settings, or none when it is null", async () => {
    let {pi} = await setup();
    expect(pi.registerShortcut).toHaveBeenCalledOnce();
    expect(pi.registerShortcut.mock.calls[0][0]).toBe("ctrl+alt+c");
    saveConfig({ cacheOptimizedShortcut:"alt+shift+c" } as any);
    ({pi} = await setup());
    expect(pi.registerShortcut.mock.calls[0][0]).toBe("alt+shift+c");
    saveConfig({ cacheOptimizedShortcut:null } as any);
    ({pi} = await setup());
    expect(pi.registerShortcut).not.toHaveBeenCalled();
  });
  it("toggles the header, prices and footer status from the shortcut", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({data:[{id:"glm-5.3-fast",context_length:1048576,
      pricing:{input_per_m:1.25,cached_input_per_m:0.25,cache_write_per_m:0,output_per_m:4.4},
      pricing_plans:{cache_optimized:{input_per_m:1.12,cached_input_per_m:0,cache_write_per_m:0.56,output_per_m:4.4}}}]})));
    const {pi, latest} = await setup();
    const on = (event:string) => pi.on.mock.calls.find(c => c[0] === event)![1];
    const ui = {notify:vi.fn(), setStatus:vi.fn()};
    await on("session_start")({}, {modelRegistry:{getApiKeyForProvider:async()=>"test-key"}, ui, model:{provider:"coralbricks"}});
    await vi.waitFor(() => expect(latest().models.find((m:any)=>m.id === "glm-5.3-fast").cost.cacheRead).toBe(0.25));
    expect(ui.setStatus).toHaveBeenLastCalledWith("coralbricks", undefined);
    const glm = () => latest().models.find((m:any)=>m.id === "glm-5.3-fast");
    const selected = {...glm(), provider:"coralbricks", baseUrl:latest().baseUrl};

    const toggle = pi.registerShortcut.mock.calls[0][1].handler;
    await toggle({mode:"tui", hasUI:true, ui});
    expect(loadConfig().cacheOptimized).toBe(true);
    expect(glm().cost).toEqual({input:1.12,output:4.4,cacheRead:0,cacheWrite:1.68});
    expect(glm()).not.toHaveProperty("cacheOptimizedCost");
    expect(ui.setStatus).toHaveBeenLastCalledWith("coralbricks", "coral: cache-optimized");

    // The model pi already selected still carries Standard prices; the request is priced cache-optimized.
    let headers = new Headers();
    const result = await latest().streamSimple(selected, {messages:[{role:"user",content:"hi",timestamp:1}]}, {
      apiKey:"test", maxRetries:0,
      fetch:async (_input:any, init:any) => { headers = new Headers(init.headers); return new Response([
        {id:"c",object:"chat.completion.chunk",created:0,model:"m",choices:[{index:0,delta:{role:"assistant",content:"Hi"},finish_reason:null}]},
        {id:"c",object:"chat.completion.chunk",created:0,model:"m",choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:1000000,completion_tokens:0,total_tokens:1000000}},
      ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), {headers:{"content-type":"text/event-stream"}}); },
    }).result();
    expect(headers.get("x-coral-pricing")).toBe("cache-optimized");
    expect(result.usage.cost.input).toBeCloseTo(1.12);

    on("model_select")({model:{provider:"other"}}, {ui});
    expect(ui.setStatus).toHaveBeenLastCalledWith("coralbricks", undefined);
    on("model_select")({model:{provider:"coralbricks"}}, {ui});
    expect(ui.setStatus).toHaveBeenLastCalledWith("coralbricks", "coral: cache-optimized");

    await toggle({mode:"tui", hasUI:true, ui});
    expect(loadConfig().cacheOptimized).toBe(false);
    expect(glm().cost.input).toBe(1.25);
    expect(ui.setStatus).toHaveBeenLastCalledWith("coralbricks", undefined);
  });
  it("routes an already selected model through the new API without mutation", async () => {
    const {latest, handler} = await setup();
    const registration = latest();
    const model = {...registration.models[0], provider:"coralbricks", baseUrl:registration.baseUrl, api:registration.api};
    const ctx = context();
    ctx.ui.select.mockResolvedValue("responses");
    await handler("", ctx);
    let url = "";
    const result = await registration.streamSimple(model, {messages:[]}, {
      apiKey:"test", maxRetries:0,
      fetch:async (input:any) => { url = String(input); return Response.json({error:{message:"test"}}, {status:400}); },
    }).result();
    expect(url).toContain("/responses");
    expect(result.api).toBe("openai-responses");
    expect(model.api).toBe("openai-completions");
  });
});
