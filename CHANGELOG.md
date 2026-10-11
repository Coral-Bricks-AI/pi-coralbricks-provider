# Changelog

## Unreleased

- Make no network request without a key ([Coral-Bricks-AI/coralbricks-api#139](https://github.com/Coral-Bricks-AI/coralbricks-api/issues/139)). Session start no longer fetches the public catalog when no key is configured: the cached or embedded catalog serves until `/login coralbricks` or a key resolves, then the authenticated `/v1/models` syncs as before. `scripts/update-models.js` keeps its public-catalog fallback for maintainers.

## 1.0.31

- Add `/login coralbricks` ([Coral-Bricks-AI/coralbricks-api#139](https://github.com/Coral-Bricks-AI/coralbricks-api/issues/139)). The provider now registers as a native pi-ai provider with API-key auth, the pattern Pi's OpenRouter and Vercel AI Gateway providers use. Login points to https://www.coralbricks.ai for a key, prompts for it and stores it as the `coralbricks` api_key in `auth.json`, the entry the extension already read. `/logout` removes it. The model list then refreshes from the authenticated `/v1/models`, as it does at session start. The provider id, model ids, catalog sync, thinking levels, pricing, Responses parking and the `auth.json` / `--api-key` / `CORALBRICKS_API_KEY` resolution are unchanged.

## 1.0.30

- Send the pi session id to Coral on every route: the `x-coral-session` header on Chat Completions and Responses, and `prompt_cache_key` in Completions bodies, where pi-ai omits it for non-OpenAI hosts. Coral reads the session's prompt cache from either signal alone (verified live); `cacheRetention: "none"` still omits the body key.

## 1.0.29

- Add opt-in Responses parking (`"park": true` or `/coralbricks-settings`). Turns are stored and chained with `previous_response_id`, sending only new items, with a full-replay fallback when the history no longer matches or Coral lost the parent.

## 1.0.21

- Pin Pi SDK development dependencies to 1.0.0 while retaining wildcard host peers.
- Verify real manifest loading, provider catalogs, startup/shutdown and native/bundled Pi hosts offline.
- Exercise real transport adapters with Unicode text, tool calls, empty responses, usage, request hooks and cancellation; no live provider calls.

## 1.0.20

- Validate against Pi 0.99.0, including an offline real-host package-loading probe.
- Declare imported host packages as wildcard peers and pin development dependencies to Pi 0.99.0.
- Stop installing duplicate Pi AI and coding-agent runtime packages.
