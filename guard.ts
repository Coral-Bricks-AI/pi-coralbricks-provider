/**
 * One provider per Pi runtime, however many copies of this package load.
 *
 * A standalone install (`pi install npm:pi-coralbricks-provider`) and a copy
 * bundled inside another Pi package (pi-fabric) load from separate module
 * roots, so module state is not shared between them. Without coordination both
 * would register `coralbricks`, both would sync models at session start, and
 * both would add `/coralbricks-settings`.
 *
 * Copies coordinate through a process-global registry under
 * `Symbol.for("pi-coralbricks-provider.registry.v1")`. It is scoped per Pi
 * extension runtime: copies discover a shared scope token over the extension
 * event bus Pi gives every extension of one runtime (`pi.events`). Pi drops a
 * runtime's bus subscriptions when it invalidates that runtime (`/reload`,
 * `/new`, `/resume`, `/fork`), so the next generation starts from an empty
 * scope and never inherits a stale owner. Separate runtimes in one process
 * (another SDK session, an isolated loader) get separate scopes.
 *
 * Within a scope the highest version owns the provider; equal versions keep the
 * copy that loaded first. Ownership is decided while extensions load, before
 * Pi binds a session:
 *
 * - The first copy owns the scope and registers the provider.
 * - A later copy that is not newer yields: it registers nothing and never
 *   syncs models.
 * - A later, newer copy takes over: the incumbent resigns (its hooks go inert)
 *   and the newer copy registers the provider. Pi applies registrations in
 *   load order and a native provider with an existing id replaces the previous
 *   one, so the newer registration is the one Pi serves.
 *
 * Ownership only ever moves to a strictly newer version, and only at load
 * time, so it cannot flap, and only the owner fetches `/v1/models`. The first
 * copy registers `/coralbricks-settings` once and serves it through whichever
 * copy owns the scope. A feature newer than the copy that loaded first (the
 * cache-optimized shortcut) is registered by whichever copy asks `once()` for
 * it first, so an older first copy cannot leave it out. Ownership ends with the
 * session (`session_shutdown`).
 * Copies older than this protocol do not take part and keep registering.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REGISTRY_KEY = Symbol.for("pi-coralbricks-provider.registry.v1");
const SCOPE_CHANNEL = "pi-coralbricks-provider:scope.v1";

/** What one loaded copy offers the registry. Stable across versions (protocol v1). */
export interface CoralCopy {
  readonly version: string;
  /** A newer copy took over this runtime: stop syncing and serving. */
  resign(): void;
  /** `/coralbricks-settings`, as this copy implements it. */
  settings(args: string, ctx: unknown): Promise<void>;
}

interface Scope {
  owner?: CoralCopy;
  /** Features a copy already registered for this scope. Optional: older copies never set it. */
  claimed?: Set<string>;
}

type Registry = WeakMap<object, Scope>;

export interface RuntimeClaim {
  /** True while this copy owns the provider in its runtime. */
  owns(): boolean;
  /** True for the first copy in the runtime, which registers the shared command. */
  readonly first: boolean;
  /** The copy that owns the runtime now, if any. */
  owner(): CoralCopy | undefined;
  /** True for the first copy in the runtime to ask for `feature`, which then registers it. */
  once(feature: string): boolean;
  /** End this copy's ownership (session shutdown). */
  release(): void;
}

function registry(): Registry {
  const global = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
  global[REGISTRY_KEY] ??= new WeakMap();
  return global[REGISTRY_KEY];
}

function parseVersion(version: string): { core: number[]; pre: string | undefined } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] };
}

function comparePrerelease(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    const numericLeft = /^\d+$/.test(left[i]);
    const numericRight = /^\d+$/.test(right[i]);
    if (numericLeft && numericRight) {
      const diff = Number(left[i]) - Number(right[i]);
      if (diff !== 0) return Math.sign(diff);
    } else if (numericLeft !== numericRight) {
      return numericLeft ? -1 : 1;
    } else if (left[i] !== right[i]) {
      return left[i] < right[i] ? -1 : 1;
    }
  }
  return 0;
}

/** Semver precedence; a malformed version sorts below every valid one. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    const diff = left.core[i] - right.core[i];
    if (diff !== 0) return Math.sign(diff);
  }
  if (left.pre === undefined || right.pre === undefined) {
    return left.pre === right.pre ? 0 : left.pre === undefined ? 1 : -1;
  }
  return comparePrerelease(left.pre, right.pre);
}

/** The scope token every copy in this extension runtime shares. */
function joinScope(pi: ExtensionAPI): { token: object; first: boolean } {
  // A host without an extension event bus gives every copy its own scope.
  if (typeof pi.events?.emit !== "function" || typeof pi.events.on !== "function") return { token: {}, first: true };
  let token: object | undefined;
  // Copies already loaded in this runtime answer synchronously on the bus.
  pi.events.emit(SCOPE_CHANNEL, (found: unknown) => {
    if (!token && typeof found === "object" && found !== null) token = found;
  });
  const first = token === undefined;
  const scope = token ?? {};
  pi.events.on(SCOPE_CHANNEL, (reply: unknown) => {
    if (typeof reply === "function") reply(scope);
  });
  return { token: scope, first };
}

/** Decide, while this copy loads, whether it owns the `coralbricks` provider in its runtime. */
export function claimRuntime(pi: ExtensionAPI, copy: CoralCopy): RuntimeClaim {
  const { token, first } = joinScope(pi);
  const scopes = registry();
  let scope = scopes.get(token);
  if (!scope) {
    scope = {};
    scopes.set(token, scope);
  }
  const incumbent = scope.owner;
  if (!incumbent || compareVersions(copy.version, incumbent.version) > 0) {
    scope.owner = copy;
    incumbent?.resign();
  }
  const current = scope;
  return {
    first,
    owns: () => current.owner === copy,
    owner: () => current.owner,
    once: (feature) => {
      current.claimed ??= new Set();
      if (current.claimed.has(feature)) return false;
      current.claimed.add(feature);
      return true;
    },
    release: () => {
      if (current.owner === copy) current.owner = undefined;
    },
  };
}
