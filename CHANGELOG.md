# Changelog

## 1.0.32

- Quiet startup sync. The session-start `/v1/models` revalidation runs in the background only with a key, only when the disk cache is older than 1 hour (`PI_PROVIDER_SYNC_TTL_MS`, `0` = always), missing or corrupt, or fetched with a different key, and only in one pi process at a time (a `coralbricks-models.lock` file next to the cache). `/login coralbricks` (Pi's forced refresh) and a key change still refresh at once. Failed refreshes back off for 5 minutes, and sessions that skip adopt a cache another process refreshed, so `/new`, `pi -p` and fan-out child agents no longer each call the API. Only the copy that owns the runtime takes the lock. The policy lives in `sync-policy.ts`, shared verbatim across pi-*-provider packages.
- Never store the API key: key changes are detected through a salted sha256 fingerprint in `cache/coralbricks-models.sync.json`. The cache file format is unchanged, so older versions keep reading it; a cache written by an older version is revalidated once.
- Write the model cache atomically.
- Register once when several copies load ([Coral-Bricks-AI/coralbricks-api#139](https://github.com/Coral-Bricks-AI/coralbricks-api/issues/139)). A standalone install and a copy bundled in another Pi package, such as pi-fabric, now share a process-global registry (`Symbol.for("pi-coralbricks-provider.registry.v1")`) scoped to the Pi extension runtime. Only the newest version registers `coralbricks`, syncs `/v1/models` and adds `/coralbricks-settings`, whichever order the copies load in. A newer copy that loads later takes over before the session starts. Ownership ends with the session, so `/reload` and session switches start clean. Copies before this release do not take part.
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
