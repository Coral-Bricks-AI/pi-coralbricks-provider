import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type CoralApi = "chat-completions" | "responses";
export interface CoralConfig {
  api: CoralApi;
  park: boolean;
  /** Send `X-Coral-Pricing: cache-optimized` on every request. */
  cacheOptimized: boolean;
  /** The key that toggles `cacheOptimized`; null when disabled. Read at load. */
  cacheOptimizedShortcut: string | null;
}

/** The request header Coral reads to bill a request on Cache-optimized pricing. */
export const PRICING_HEADER = { name: "X-Coral-Pricing", value: "cache-optimized" } as const;
export const DEFAULT_CACHE_OPTIMIZED_SHORTCUT = "ctrl+alt+c";

export function configPath(): string {
  return path.join(getAgentDir(), "extensions", "coralbricks.json");
}

function readRawConfig(): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected a JSON object");
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function readShortcut(value: unknown): string | null {
  if (value === null || value === false) return null;
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_CACHE_OPTIMIZED_SHORTCUT;
}

export function loadConfig(): CoralConfig {
  try {
    const raw = readRawConfig();
    return {
      api: raw.api === "responses" ? "responses" : "chat-completions",
      park: raw.park === true,
      cacheOptimized: raw.cacheOptimized === true,
      cacheOptimizedShortcut: readShortcut(raw.cacheOptimizedShortcut),
    };
  } catch {
    return { api: "chat-completions", park: false, cacheOptimized: false, cacheOptimizedShortcut: DEFAULT_CACHE_OPTIMIZED_SHORTCUT };
  }
}

/** Preserve unrelated fields; never overwrite malformed settings. */
export function saveConfig(patch: Partial<CoralConfig>): void {
  const raw = { ...readRawConfig(), ...patch };
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function saveApi(api: CoralApi): void {
  saveConfig({ api });
}

const PARK_DESCRIPTION = "Responses only. Stores each response on Coral (store:true) and sends only new items with previous_response_id. Falls back to a full replay when the chain does not match.";
const CACHE_OPTIMIZED_DESCRIPTION = `Sends ${PRICING_HEADER.name}: ${PRICING_HEADER.value} on every request. It counts only for organizations CoralBricks enabled for Cache-optimized; others are served and billed as before.`;

/** `/coralbricks-settings cache-optimized [on|off|toggle]`: what the keyboard shortcut runs. */
export const CACHE_OPTIMIZED_TOGGLE_ARGS = "cache-optimized toggle";
const CACHE_OPTIMIZED_ARGS = /^cache-optimized(?:\s+(on|off|toggle))?$/i;

type SettingsCommand = Parameters<ExtensionAPI["registerCommand"]>[1];

export const SETTINGS_COMMAND = "coralbricks-settings";

/** `/coralbricks-settings` for one loaded copy; index.ts registers it once per runtime. */
export function createSettingsCommand(
  getConfig: () => CoralConfig,
  apply: (config: CoralConfig) => void,
): SettingsCommand {
  return {
    description: "Configure CoralBricks API (Chat Completions or opt-in Responses), Responses parking and cache-optimized pricing",
    async handler(args, ctx) {
      const toggle = CACHE_OPTIMIZED_ARGS.exec((args ?? "").trim());
      if (toggle) {
        const wanted = (toggle[1] ?? "toggle").toLowerCase();
        const on = wanted === "toggle" ? !getConfig().cacheOptimized : wanted === "on";
        try {
          saveConfig({ cacheOptimized: on });
        } catch {
          ctx.ui.notify(`Could not save ${configPath()}. Check its JSON and permissions; pricing header unchanged.`, "error");
          return;
        }
        apply({ ...getConfig(), cacheOptimized: on });
        ctx.ui.notify(on
          ? `CoralBricks cache-optimized: on — sending ${PRICING_HEADER.name}: ${PRICING_HEADER.value} from the next request.`
          : `CoralBricks cache-optimized: off — ${PRICING_HEADER.name} is no longer sent.`, "info");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/coralbricks-settings requires a UI (TUI or GUI).", "error");
        return;
      }
      const values: CoralApi[] = ["chat-completions", "responses"];
      const onOff = ["off", "on"];
      const current = (id: string): string => {
        const config = getConfig();
        if (id === "api") return config.api;
        return (id === "park" ? config.park : config.cacheOptimized) ? "on" : "off";
      };
      const labels: Record<string, string> = { api: "CoralBricks API", park: "CoralBricks parking", cacheOptimized: "CoralBricks cache-optimized" };
      const change = (id: string, value: string): boolean => {
        let patch: Partial<CoralConfig>;
        if (id === "api" && values.includes(value as CoralApi)) patch = { api: value as CoralApi };
        else if (id === "park" && onOff.includes(value)) patch = { park: value === "on" };
        else if (id === "cacheOptimized" && onOff.includes(value)) patch = { cacheOptimized: value === "on" };
        else return false;
        try {
          saveConfig(patch);
        } catch {
          ctx.ui.notify(`Could not save ${configPath()}. Check its JSON and permissions; API unchanged.`, "error");
          return false;
        }
        const next = { ...getConfig(), ...patch };
        apply(next);
        ctx.ui.notify(`${labels[id]}: ${value} — applies to the next request.`, "info");
        return true;
      };

      if (ctx.mode !== "tui") {
        const selected = await ctx.ui.select(`CoralBricks API (current: ${getConfig().api})`, values);
        if (selected === undefined || !change("api", selected)) return;
        if (selected === "responses") {
          const park = await ctx.ui.select(`Park Responses turns with previous_response_id? (current: ${current("park")})`, onOff);
          if (park === undefined || !change("park", park)) return;
        }
        const cacheOptimized = await ctx.ui.select(`Send ${PRICING_HEADER.name}: ${PRICING_HEADER.value}? (current: ${current("cacheOptimized")})`, onOff);
        if (cacheOptimized !== undefined) change("cacheOptimized", cacheOptimized);
        return;
      }

      const { SettingsList, Container, Text } = await import("@earendil-works/pi-tui");
      const { getSettingsListTheme, DynamicBorder } = await import("@earendil-works/pi-coding-agent");
      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        const container = new Container();
        const border = () => new DynamicBorder((s: string) => theme.fg("border", s));
        container.addChild(border());
        container.addChild(new Text("CoralBricks settings", 1, 0));
        const list = new SettingsList([
          {
            id: "api",
            label: "API surface",
            description: "Chat Completions is the default. Responses is opt-in; it replays full history with store:false unless parking is on.",
            currentValue: getConfig().api,
            values,
          },
          {
            id: "park",
            label: "Park Responses turns",
            description: PARK_DESCRIPTION,
            currentValue: current("park"),
            values: onOff,
          },
          {
            id: "cacheOptimized",
            label: "Cache-optimized pricing",
            description: getConfig().cacheOptimizedShortcut
              ? `${CACHE_OPTIMIZED_DESCRIPTION} Toggle anytime with ${getConfig().cacheOptimizedShortcut}.`
              : CACHE_OPTIMIZED_DESCRIPTION,
            currentValue: current("cacheOptimized"),
            values: onOff,
          },
        ], 4, getSettingsListTheme(), (id, value) => {
          if (!change(id, value)) list.updateValue(id, current(id));
        }, () => done(), { enableSearch: true });
        container.addChild(list);
        container.addChild(border());
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput(data: string) {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      });
    },
  };
}

export function registerSettingsCommand(
  pi: ExtensionAPI,
  getConfig: () => CoralConfig,
  apply: (config: CoralConfig) => void,
): void {
  pi.registerCommand(SETTINGS_COMMAND, createSettingsCommand(getConfig, apply));
}
