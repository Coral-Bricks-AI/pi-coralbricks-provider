// Offline Pi 1.3.0 manifest, lifecycle, catalog, /login and real transport regression.
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = await mkdtemp(join(tmpdir(), 'pi-provider-compat-'));
const previousHome = process.env.PI_CODING_AGENT_DIR;
const previousFetch = globalThis.fetch;
const previousSyncTtl = process.env.PI_PROVIDER_SYNC_TTL_MS;
process.env.PI_CODING_AGENT_DIR = home;
delete process.env.PI_PROVIDER_SYNC_TTL_MS; // the default 1h sync TTL, whatever the caller's shell sets
// Never allow a background catalog/account request to reach a real endpoint.
let backgroundRequests = 0;
const offlineFetch = async () => { backgroundRequests++; return new Response('', { status: 503 }); };
globalThis.fetch = offlineFetch;
let session;
try {
  const host = process.env.PI1_HOST_PACKAGE;
  const hostEntry = process.env.PI1_HOST_ENTRY === 'bundle' ? 'dist/bundle/index.js' : 'dist/index.js';
  const sdk = await import(host ? pathToFileURL(join(host, hostEntry)).href : '@earendil-works/pi-coding-agent');
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION } = sdk;
  assert.equal(VERSION, '1.3.0', 'executing host version');
  assert.equal((await import('@earendil-works/pi-coding-agent')).VERSION, '1.3.0', 'development host version');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
    assert.equal(manifest.dependencies?.[name], undefined, `${name}: do not bundle host packages`);
    if (manifest.peerDependencies?.[name] !== undefined) assert.equal(manifest.peerDependencies[name], '*');
    if (name !== 'typebox' && manifest.devDependencies?.[name]) assert.equal(manifest.devDependencies[name], '1.3.0');
  }
  const settingsManager = SettingsManager.inMemory({ packages: [root], compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: home, agentDir: home, settingsManager,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.warnings ?? [], []);
  assert.equal(loaded.extensions.length, manifest.pi.extensions.length, 'all manifest entrypoints load');
  // Endpoint/header-only re-registration (e.g. MCR) retains the prior catalog.
  const registrations = [...loaded.runtime.pendingProviderRegistrations.reduce((byName, { name, config }) =>
    byName.set(name, { name, models: (config.models ?? byName.get(name)?.models), config: { ...byName.get(name)?.config, ...config } }), new Map()).values()];
  // Native pi-ai providers (`pi.registerProvider(provider)`); the last registration per id wins.
  for (const { provider } of loaded.runtime.pendingNativeProviderRegistrations ?? []) {
    const index = registrations.findIndex(({ name }) => name === provider.id);
    const entry = { name: provider.id, models: provider.getAllModels?.() ?? provider.getModels(), provider };
    if (index >= 0) registrations[index] = entry; else registrations.push(entry);
  }
  assert(registrations.length > 0, 'providers register before session startup');
  const modelRuntime = await ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: null, modelsStorePath: join(home, 'models-cache'), allowModelNetwork: false });
  ({ session } = await createAgentSession({ cwd: home, agentDir: home, resourceLoader, modelRuntime, settingsManager, sessionManager: SessionManager.inMemory(home) }));
  const errors = [];
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
  await new Promise(done => setImmediate(done));
  const tools = new Set();
  for (const extension of loaded.extensions) for (const [name, { definition }] of extension.tools) {
    assert.equal(definition.name, name); assert.equal(typeof definition.execute, 'function');
    assert.equal(typeof definition.parameters, 'object'); assert(!tools.has(name)); tools.add(name);
    assert(session.getAllTools().some(tool => tool.name === name));
  }
  let modelCount = 0, streamChecks = 0;
  for (const { name, models: registered } of registrations) {
    const models = modelRuntime.getAllModels(name);
    assert.equal(models.length, registered.length, `${name}: catalog survives registration`);
    assert(models.length > 0);
    assert.equal(new Set(models.map(m => `${m.type}/${m.id}`)).size, models.length);
    for (const model of models) {
      assert.equal(model.provider, name); assert(model.api && model.baseUrl && model.id && model.name);
      if (model.type === 'image') assert(model.output.includes('image'));
      else assert(model.contextWindow > 0);
      if ((model.type ?? 'chat') === 'chat') assert(model.maxTokens > 0);
      assert(model.input.includes('text'));
      for (const cost of Object.values(model.cost)) assert(Number.isFinite(cost) && cost >= 0);
    }
    const chatModels = modelRuntime.getModels(name);
    const model = chatModels.find(m => m.api === 'openai-completions') ?? chatModels[0];
    assert(model, 'a chat model is available for offline transport checks');
    const user = { role: 'user', content: 'hello', timestamp: 1 };
    async function probe(tool = false, empty = false) {
      let payloadCalls = 0, responseCalls = 0, observed = 0, wire;
      const fetch = async (_url, init) => {
        wire = JSON.parse(init.body);
        const delta = tool ? { tool_calls: [{ index: 0, id: 'call_probe', type: 'function', function: { name: 'probe', arguments: '{"value":7}' } }] } : { content: empty ? '' : 'Hello 界' };
        const chunks = [{ id: 'offline', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] }, { id: 'offline', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }];
        return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      };
      const stream = modelRuntime.streamSimple(model, { messages: [{ role: 'system', content: 'Offline probe', toolsAdded: [{ name: 'probe', description: 'Probe', parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] } }], timestamp: 0 }, user] }, {
        apiKey: 'offline-placeholder', maxTokens: 32, maxRetries: 0, fetch,
        onPayload: p => { payloadCalls++; return { ...p, temperature: 0.123 }; },
        onResponse: () => { responseCalls++; }, onProviderStreamEvent: () => { observed++; },
      });
      const events = []; for await (const event of stream) events.push(event.type);
      const result = await stream.result();
      assert.equal(result.stopReason, tool ? 'toolUse' : 'stop', result.errorMessage);
      assert.equal(events.filter(e => e === 'start').length, 1);
      assert.equal(events.filter(e => e === 'done' || e === 'error').length, 1);
      assert.equal(events.at(-1), 'done');
      assert.equal(payloadCalls, 1); assert.equal(responseCalls, 1); assert(observed >= 2);
      assert.equal(wire.temperature, 0.123); assert.equal(wire.tools[0].function.name, 'probe');
      assert.equal(result.usage.totalTokens, 12);
      if (tool) assert.deepEqual(result.content.find(c => c.type === 'toolCall').arguments, { value: 7 });
      else if (!empty) assert.equal(result.content.find(c => c.type === 'text').text, 'Hello 界');
      streamChecks++;
    }
    await probe(); await probe(true); await probe(false, true);
    // Abort after preflight: the SDK's lazy preflight reports an already-aborted
    // auth operation as an error; this checks provider transport cancellation.
    const controller = new AbortController();
    const aborted = await modelRuntime.streamSimple(model, { messages: [user] }, {
      apiKey: 'offline-placeholder', signal: controller.signal, maxRetries: 0,
      onPayload: () => { controller.abort(); },
      fetch: async () => { throw new DOMException('Aborted', 'AbortError'); },
    }).result();
    assert.equal(aborted.stopReason, 'aborted', aborted.errorMessage); streamChecks++;
    modelCount += models.length;
  }
  // No key anywhere: session start serves the cached/embedded catalog and requests nothing.
  await new Promise(done => setTimeout(done, 50));
  assert.equal(backgroundRequests, 0, 'no catalog request without a key');
  // /login <provider>: the host's own API-key flow stores the key in auth.json,
  // the post-login catalog refresh fetches /v1/models with it, and /logout removes it.
  let loginChecks = 0;
  const authFile = join(home, 'auth.json');
  const readAuth = async () => JSON.parse(await readFile(authFile, 'utf8').catch(() => '{}'));
  for (const { name } of registrations) {
    const provider = modelRuntime.getProvider(name);
    if (!provider?.auth.apiKey?.login) continue;
    const prompts = [], notices = [], requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), authorization: init?.headers?.Authorization });
      return String(url).endsWith('/v1/models')
        ? Response.json({ data: [{ id: 'probe-login-model', context_length: 131072, pricing: { input_per_m: 1, output_per_m: 2 } }] })
        : new Response('', { status: 503 });
    };
    try {
      await modelRuntime.login(name, 'api_key', { prompt: async prompt => { prompts.push(prompt); return 'probe-login-key'; }, notify: event => notices.push(event) });
      assert.deepEqual((await readAuth())[name], { type: 'api_key', key: 'probe-login-key' }, `${name}: /login stores an api_key credential`);
      assert(prompts.some(prompt => prompt.type === 'secret'), `${name}: /login prompts for a secret`);
      assert.equal((await modelRuntime.getAuth(name))?.auth.apiKey, 'probe-login-key');
      const refreshed = await modelRuntime.refresh({ providers: [name], allowNetwork: true });
      assert.equal(refreshed.errors.size, 0, `${name}: post-login catalog refresh`);
      assert(requests.some(request => request.authorization === 'Bearer probe-login-key'), `${name}: catalog fetched with the new key`);
      assert(modelRuntime.getAllModels(name).some(model => model.id === 'probe-login-model'), `${name}: authenticated catalog published`);
      await modelRuntime.logout(name);
      assert.equal((await readAuth())[name], undefined, `${name}: /logout removes the credential`);
      loginChecks++;
    } finally {
      globalThis.fetch = offlineFetch;
    }
  }
  assert(loginChecks > 0, 'a registered provider offers /login');
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  assert.deepEqual(errors, []);
  // Two copies in one runtime (a standalone install plus one bundled in another
  // package, e.g. pi-fabric): only the newer registers, syncs and adds the command.
  const newer = join(home, 'newer-copy');
  await mkdir(newer);
  for (const file of manifest.files) if (!file.includes('/')) await copyFile(join(root, file), join(newer, file));
  await writeFile(join(newer, 'package.json'), JSON.stringify({ ...manifest, version: '999.0.0' }));
  await writeFile(authFile, JSON.stringify({ coralbricks: { type: 'api_key', key: 'probe-dual-key' } }));
  let dualChecks = 0;
  for (const packages of [[root, newer], [newer, root]]) {
    await rm(join(home, 'cache'), { recursive: true, force: true }); // no catalog left by the previous order
    const dualSettings = SettingsManager.inMemory({ packages, compaction: { enabled: false }, retry: { enabled: false } });
    const dualLoader = new DefaultResourceLoader({ cwd: home, agentDir: home, settingsManager: dualSettings,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await dualLoader.reload();
    const dual = dualLoader.getExtensions();
    assert.deepEqual(dual.errors, []);
    assert.equal(dual.extensions.length, 2, 'both copies load');
    const natives = dual.runtime.pendingNativeProviderRegistrations.filter(({ provider }) => provider.id === 'coralbricks');
    assert(natives.at(-1).extensionPath.startsWith(newer), 'the newer copy serves coralbricks');
    assert.deepEqual(dual.extensions.flatMap(extension => [...extension.commands.keys()]), ['coralbricks-settings']);
    const requests = [];
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return Response.json({ data: [{ id: 'probe-dual-model', context_length: 131072, pricing: { input_per_m: 1, output_per_m: 2 } }] });
    };
    const dualRuntime = await ModelRuntime.create({ authPath: authFile, modelsPath: null, modelsStorePath: join(home, 'models-cache-dual'), allowModelNetwork: false });
    const { session: dualSession } = await createAgentSession({ cwd: home, agentDir: home, resourceLoader: dualLoader, modelRuntime: dualRuntime,
      settingsManager: dualSettings, sessionManager: SessionManager.inMemory(home) });
    try {
      const dualErrors = [];
      await dualSession.bindExtensions({ mode: 'print', onError: error => dualErrors.push(error) });
      for (let i = 0; i < 100 && !dualRuntime.getAllModels('coralbricks').some(model => model.id === 'probe-dual-model'); i++) await new Promise(done => setTimeout(done, 10));
      await new Promise(done => setTimeout(done, 50)); // let a second copy's sync, if any, land
      assert(dualRuntime.getAllModels('coralbricks').some(model => model.id === 'probe-dual-model'), 'the owner synced the catalog');
      assert.deepEqual(requests, ['https://inference.coralbricks.ai/v1/models'], 'one catalog sync for two copies');
      await dualSession.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      assert.deepEqual(dualErrors, []);
      dualChecks++;
    } finally {
      dualSession.dispose();
      globalThis.fetch = offlineFetch;
    }
  }
  // Quiet startup sync: the next session start (a new pi process, /new, `pi -p`)
  // within the TTL serves the cache the last sync wrote and requests nothing.
  let quietChecks = 0;
  for (const packages of [[root], [root, newer]]) {
    const quietSettings = SettingsManager.inMemory({ packages, compaction: { enabled: false }, retry: { enabled: false } });
    const quietLoader = new DefaultResourceLoader({ cwd: home, agentDir: home, settingsManager: quietSettings,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await quietLoader.reload();
    assert.deepEqual(quietLoader.getExtensions().errors, []);
    const requests = [];
    globalThis.fetch = async (url) => { requests.push(String(url)); return new Response('', { status: 503 }); };
    const quietRuntime = await ModelRuntime.create({ authPath: authFile, modelsPath: null, modelsStorePath: join(home, 'models-cache-quiet'), allowModelNetwork: false });
    const { session: quietSession } = await createAgentSession({ cwd: home, agentDir: home, resourceLoader: quietLoader, modelRuntime: quietRuntime,
      settingsManager: quietSettings, sessionManager: SessionManager.inMemory(home) });
    try {
      const quietErrors = [];
      await quietSession.bindExtensions({ mode: 'print', onError: error => quietErrors.push(error) });
      await new Promise(done => setTimeout(done, 100)); // let any background sync land
      assert.deepEqual(requests, [], `${packages.length} cop${packages.length > 1 ? 'ies' : 'y'}: no /v1/models request within the sync TTL`);
      assert(quietRuntime.getAllModels('coralbricks').some(model => model.id === 'probe-dual-model'), 'the cached catalog serves');
      await quietSession.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      assert.deepEqual(quietErrors, []);
      quietChecks++;
    } finally {
      quietSession.dispose();
      globalThis.fetch = offlineFetch;
    }
  }
  console.log(JSON.stringify({ repo: manifest.name, pi: VERSION, hostEntry, extensions: loaded.extensions.length, tools: tools.size, models: modelCount, streamChecks, loginChecks, dualChecks, quietChecks, lifecycle: 'passed' }));
} finally {
  session?.dispose(); globalThis.fetch = previousFetch;
  if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousHome;
  if (previousSyncTtl !== undefined) process.env.PI_PROVIDER_SYNC_TTL_MS = previousSyncTtl;
  await rm(home, { recursive: true, force: true });
}
