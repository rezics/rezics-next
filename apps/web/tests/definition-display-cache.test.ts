import { expect, test } from 'bun:test';
import { createDisplayDefinitionCache } from '../src/subject/display-definition-cache/index';

type ReleaseEnvelope = {
  digest: string;
  release: { types: Record<string, unknown>; properties: Record<string, unknown> };
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readRelease(cache: ReturnType<typeof createDisplayDefinitionCache>, origin: string, digest: string) {
  const url = new URL(`/v1/definitions/releases/${encodeURIComponent(digest)}`, origin).href;
  return cache.readRelease(origin, digest, () =>
    cache.read<ReleaseEnvelope>(url, undefined, (body) => {
      const release = record(body) ? body.release : undefined;
      if (
        !record(body) ||
        body.digest !== digest ||
        !record(release) ||
        !record(release.types) ||
        !record(release.properties)
      )
        throw new Error('Definitions release is invalid');
      return { digest, release: release as ReleaseEnvelope['release'] };
    }),
  );
}

function validRelease(digest: string, marker = ''): ReleaseEnvelope {
  return { digest, release: { types: {}, properties: { marker } } };
}

test('invalid active and release 200 bodies are not remembered by the memory fallback', async () => {
  let activeReads = 0;
  let releaseReads = 0;
  const cache = createDisplayDefinitionCache({
    cache: () => undefined,
    now: () => Date.now(),
    fetch: async (request) => {
      if (new URL(request.url).pathname.endsWith('/active')) {
        activeReads += 1;
        return Response.json(activeReads === 1 ? { digest: '' } : { digest: 'release-a' });
      }
      releaseReads += 1;
      return Response.json(
        releaseReads === 1 ? { digest: 'other', release: { types: {}, properties: {} } } : validRelease('release-a'),
      );
    },
  });

  const active = 'https://memory-cache.test/v1/definitions/active';
  const parseActive = (value: unknown) => {
    if (!record(value) || typeof value.digest !== 'string' || !value.digest || value.digest.length > 256)
      throw new Error('Active definitions release is invalid');
    return value.digest;
  };
  await expect(cache.read(active, 60_000, parseActive)).rejects.toThrow('Active definitions release is invalid');
  expect(await cache.read(active, 60_000, parseActive)).toBe('release-a');

  await expect(readRelease(cache, 'https://memory-cache.test', 'release-a')).rejects.toThrow(
    'Definitions release is invalid',
  );
  expect(await readRelease(cache, 'https://memory-cache.test', 'release-a')).toEqual(validRelease('release-a'));
  expect(activeReads).toBe(2);
  expect(releaseReads).toBe(2);
});

test('a poisoned Cache API release from the former cache path is evicted before a corrected native read', async () => {
  const origin = 'https://cache-api.test';
  const digest = 'release-a';
  const url = new URL(`/v1/definitions/releases/${digest}`, origin).href;
  const entries = new Map<string, Response>([
    [
      url,
      Response.json(
        { digest: 'different-release', release: { types: {}, properties: {} } },
        { headers: { 'x-rezics-definition-stored-at': String(Date.now()) } },
      ),
    ],
  ]);
  const cacheApi = {
    match: async (request: Request) => entries.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => {
      entries.set(request.url, response.clone());
    },
    delete: async (request: Request) => entries.delete(request.url),
  } as unknown as Cache;
  let nativeReads = 0;
  const cache = createDisplayDefinitionCache({
    cache: () => cacheApi,
    now: () => Date.now(),
    fetch: async () => {
      nativeReads += 1;
      return Response.json(validRelease(digest));
    },
  });

  expect(await readRelease(cache, origin, digest)).toEqual(validRelease(digest));
  expect(nativeReads).toBe(1);
  expect(await entries.get(url)!.clone().json()).toEqual(validRelease(digest));
});

test('same-origin reads deduplicate while a same-digest read from another origin stays separate', async () => {
  const originA = 'https://one-origin.test';
  const originB = 'https://other-origin.test';
  const calls = new Map<string, number>();
  let releaseFetches!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetches = resolve;
  });
  const cache = createDisplayDefinitionCache({
    cache: () => undefined,
    now: () => Date.now(),
    fetch: async (request) => {
      const origin = new URL(request.url).origin;
      calls.set(origin, (calls.get(origin) ?? 0) + 1);
      await fetchGate;
      return Response.json(validRelease('same-digest', origin));
    },
  });

  const first = readRelease(cache, originA, 'same-digest');
  const shared = readRelease(cache, originA, 'same-digest');
  const other = readRelease(cache, originB, 'same-digest');
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(calls).toEqual(
    new Map([
      [originA, 1],
      [originB, 1],
    ]),
  );
  releaseFetches();
  const [firstValue, sharedValue, otherValue] = await Promise.all([first, shared, other]);
  expect(firstValue).toEqual(sharedValue);
  expect(firstValue.release.properties.marker).toBe(originA);
  expect(otherValue.release.properties.marker).toBe(originB);
});

test('release memory stays bounded and an older failed flight cannot remove a newer result', async () => {
  const origin = 'https://bounded-release.test';
  let fetches = 0;
  const cache = createDisplayDefinitionCache({
    cache: () => undefined,
    now: () => Date.now(),
    fetch: async (request) => {
      fetches += 1;
      const digest = decodeURIComponent(new URL(request.url).pathname.split('/').at(-1)!);
      return Response.json(validRelease(digest));
    },
  });

  for (let index = 0; index < 17; index += 1) await readRelease(cache, origin, `churn-${index}`);
  await readRelease(cache, origin, 'churn-0');
  expect(fetches).toBe(18);

  let failOld!: (error: Error) => void;
  const old = cache.readRelease(
    origin,
    'same-key',
    () => new Promise<string>((_resolve, reject) => (failOld = reject)),
  );
  await Promise.resolve();
  for (let index = 0; index < 16; index += 1)
    await cache.readRelease(origin, `evict-${index}`, async () => `evict-${index}`);
  expect(await cache.readRelease(origin, 'same-key', async () => 'new-value')).toBe('new-value');
  failOld(new Error('retired flight failed'));
  await expect(old).rejects.toThrow('retired flight failed');
  expect(await cache.readRelease(origin, 'same-key', async () => 'unexpected replacement')).toBe('new-value');
});
