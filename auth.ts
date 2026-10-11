import { envApiKeyAuth, type ApiKeyAuth } from "@earendil-works/pi-ai";

export const CORALBRICKS_ENV_VAR = "CORALBRICKS_API_KEY";
export const CORALBRICKS_KEYS_URL = "https://www.coralbricks.ai/api-keys";

/**
 * API-key auth for `/login coralbricks`, the pattern Pi's built-in OpenRouter and
 * Vercel AI Gateway providers use (pi-ai `envApiKeyAuth`): a stored auth.json
 * `coralbricks` api_key wins, then CORALBRICKS_API_KEY. Login stores
 * `{ "type": "api_key", "key": ... }` under `coralbricks`, the entry this
 * extension has always read, and `/logout` removes it.
 */
export function coralApiKeyAuth(): ApiKeyAuth {
  const base = envApiKeyAuth("CoralBricks API key", [CORALBRICKS_ENV_VAR]);
  return {
    ...base,
    login: async (interaction) => {
      interaction.signal.throwIfAborted();
      interaction.notify({
        type: "info",
        message: "Create a Coral Inference API key at https://www.coralbricks.ai (API keys page). New keys can take ~30 seconds to be honored.",
        links: [{ url: CORALBRICKS_KEYS_URL, label: "coralbricks.ai/api-keys" }],
      });
      const key = (await interaction.prompt({ type: "secret", message: "Enter CoralBricks API key", placeholder: "cb_..." })).trim();
      interaction.signal.throwIfAborted();
      if (!key) throw new Error("No CoralBricks API key entered");
      return { type: "api_key", key };
    },
  };
}
