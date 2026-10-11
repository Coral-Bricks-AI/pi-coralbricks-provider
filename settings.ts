import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type CoralApi = "chat-completions" | "responses";
export interface CoralConfig { api: CoralApi; park: boolean }

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

export function loadConfig(): CoralConfig {
  try {
    const raw = readRawConfig();
    return { api: raw.api === "responses" ? "responses" : "chat-completions", park: raw.park === true };
  } catch {
    return { api: "chat-completions", park: false };
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

type SettingsCommand = Parameters<ExtensionAPI["registerCommand"]>[1];

export const SETTINGS_COMMAND = "coralbricks-settings";

/** `/coralbricks-settings` for one loaded copy; index.ts registers it once per runtime. */
export function createSettingsCommand(
  getConfig: () => CoralConfig,
  apply: (config: CoralConfig) => void,
): SettingsCommand {
  return {
    description: "Configure CoralBricks API (Chat Completions or opt-in Responses) and Responses parking",
    async handler(_args, ctx) {
      if (!ctx.hasUI) {
        ctx.ui.notify("/coralbricks-settings requires a UI (TUI or GUI).", "error");
        return;
      }
      const values: CoralApi[] = ["chat-completions", "responses"];
      const parkValues = ["off", "on"];
      const change = (id: string, value: string): boolean => {
        let patch: Partial<CoralConfig>;
        if (id === "api" && values.includes(value as CoralApi)) patch = { api: value as CoralApi };
        else if (id === "park" && parkValues.includes(value)) patch = { park: value === "on" };
        else return false;
        try {
          saveConfig(patch);
        } catch {
          ctx.ui.notify(`Could not save ${configPath()}. Check its JSON and permissions; API unchanged.`, "error");
          return false;
        }
        const next = { ...getConfig(), ...patch };
        apply(next);
        const label = id === "api" ? `CoralBricks API: ${value}` : `CoralBricks parking: ${value}`;
        ctx.ui.notify(`${label} — applies to the next request.`, "info");
        return true;
      };

      if (ctx.mode !== "tui") {
        const selected = await ctx.ui.select(`CoralBricks API (current: ${getConfig().api})`, values);
        if (selected === undefined || !change("api", selected) || selected !== "responses") return;
        const park = await ctx.ui.select(`Park Responses turns with previous_response_id? (current: ${getConfig().park ? "on" : "off"})`, parkValues);
        if (park !== undefined) change("park", park);
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
            currentValue: getConfig().park ? "on" : "off",
            values: parkValues,
          },
        ], 3, getSettingsListTheme(), (id, value) => {
          if (!change(id, value)) list.updateValue(id, id === "api" ? getConfig().api : getConfig().park ? "on" : "off");
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
