// Stub for @earendil-works/pi-coding-agent peer dependency
export class DynamicBorder {
  constructor(private color: (text: string) => string) {}
  render(width: number) { return [this.color("─".repeat(Math.max(1, width)))]; }
  invalidate() {}
}
export function getSettingsListTheme() {
  const identity = (text: string) => text;
  return { label: identity, value: identity, description: identity, cursor: "→ ", hint: identity };
}

import os from "os";
import path from "path";

/** Mirrors the real getAgentDir(): respects PI_CODING_AGENT_DIR, defaults to ~/.pi/agent */
export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export interface ExtensionAPI {
  registerProvider(_providerOrName: any, _config?: any): void;
  registerCommand(_name: string, _command: any): void;
  on(_event: string, _handler: any): void;
  appendEntry(_type: string, _data: any): void;
  events: { emit(_event: string, _data: any): void };
}

export interface ModelRegistry {
  getApiKeyForProvider(_provider: string): Promise<string | null>;
}

export interface ExtensionContext {
  hasUI: boolean;
  ui: any;
  sessionManager: any;
  modelRegistry: ModelRegistry;
}
