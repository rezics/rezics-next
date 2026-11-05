const MAX_DEFINITION_ENTRIES = 16;
const MAX_DEFINITION_REQUESTS = 16;
const MAX_RELEASE_ENTRIES = 16;

const storedAtHeader = 'x-rezics-definition-stored-at';

export type DisplayDefinitionCachePorts = {
  fetch(request: Request): Promise<Response>;
  cache(): Cache | undefined;
  now(): number;
};

export type DisplayDefinitionCache = {
  read<T>(url: string, ttl: number | undefined, parse: (value: unknown) => T): Promise<T>;
  readRelease<T>(origin: string, digest: string, load: () => Promise<T>): Promise<T>;
  refresh(url: string): Promise<void>;
};

/** Creates an anonymous display cache whose network, cache storage, and clock are supplied by its adapter. */
export function createDisplayDefinitionCache(ports: DisplayDefinitionCachePorts): DisplayDefinitionCache {
  const definitions = new Map<string, { storedAt: number; value: unknown }>();
  const requests = new Map<string, Promise<unknown>>();
  const releases = new Map<string, Promise<unknown>>();

  function remember<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > limit) {
      const oldest = map.keys().next();
      if (!oldest.done) map.delete(oldest.value);
    }
  }

  function releaseKey(origin: string, digest: string): string {
    return `${new URL(origin).origin}\u0000${digest}`;
  }

  async function deleteCached(cache: Cache, request: Request): Promise<void> {
    try {
      await cache.delete(request);
    } catch {
      // Cache API storage is an optional acceleration; the validated native read remains usable.
    }
  }

  async function fetchAndValidate<T>(url: string, ttl: number | undefined, parse: (value: unknown) => T): Promise<T> {
    const request = new Request(url, { method: 'GET' });
    const cache = ports.cache();

    if (cache) {
      let cached: Response | undefined;
      try {
        cached = (await cache.match(request)) ?? undefined;
      } catch {
        // Continue with memory or the native endpoint when Cache API reads are unavailable.
      }

      if (cached) {
        const storedAt = Number(cached.headers.get(storedAtHeader));
        const fresh = ttl === undefined || (Number.isFinite(storedAt) && ports.now() - storedAt < ttl);
        if (!fresh) {
          await deleteCached(cache, request);
        } else {
          try {
            const value = parse(await cached.json());
            const at = Number.isFinite(storedAt) ? storedAt : ports.now();
            remember(definitions, url, { storedAt: at, value }, MAX_DEFINITION_ENTRIES);
            return value;
          } catch {
            await deleteCached(cache, request);
          }
        }
      }
    }

    const response = await ports.fetch(request);
    if (!response.ok) throw new Error('Definitions read failed');
    const raw = await response.json();
    const value = parse(raw);
    const storedAt = ports.now();
    remember(definitions, url, { storedAt, value }, MAX_DEFINITION_ENTRIES);

    if (cache) {
      const headers = new Headers({
        'content-type': 'application/json',
        'cache-control': ttl === undefined ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
        [storedAtHeader]: String(storedAt),
      });
      try {
        await cache.put(request, new Response(JSON.stringify(raw), { headers }));
      } catch {
        // Keep the validated bounded in-memory value when Cache API writes are unavailable.
      }
    }

    return value;
  }

  async function read<T>(url: string, ttl: number | undefined, parse: (value: unknown) => T): Promise<T> {
    const remembered = definitions.get(url);
    if (remembered) {
      if (ttl === undefined || ports.now() - remembered.storedAt < ttl) {
        remember(definitions, url, remembered, MAX_DEFINITION_ENTRIES);
        return remembered.value as T;
      }
      definitions.delete(url);
    }

    const pending = requests.get(url);
    if (pending) return pending as Promise<T>;

    if (requests.size >= MAX_DEFINITION_REQUESTS) {
      await Promise.race(
        [...requests.values()].map((request) =>
          request.then(
            () => undefined,
            () => undefined,
          ),
        ),
      );
      return read(url, ttl, parse);
    }

    const request = fetchAndValidate(url, ttl, parse);
    requests.set(url, request);
    void request.then(
      () => {
        if (requests.get(url) === request) requests.delete(url);
      },
      () => {
        if (requests.get(url) === request) requests.delete(url);
      },
    );
    return request;
  }

  function readRelease<T>(origin: string, digest: string, load: () => Promise<T>): Promise<T> {
    const key = releaseKey(origin, digest);
    const remembered = releases.get(key);
    if (remembered) {
      remember(releases, key, remembered, MAX_RELEASE_ENTRIES);
      return remembered as Promise<T>;
    }

    const request = Promise.resolve().then(load);
    remember(releases, key, request, MAX_RELEASE_ENTRIES);
    void request.then(
      () => undefined,
      () => {
        if (releases.get(key) === request) releases.delete(key);
      },
    );
    return request;
  }

  async function refresh(url: string): Promise<void> {
    definitions.delete(url);
    const cache = ports.cache();
    if (cache) await cache.delete(new Request(url, { method: 'GET' }));
  }

  return { read, readRelease, refresh };
}
