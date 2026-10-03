import { expect, spyOn, test } from 'bun:test';
import { uuidToSid } from '@rezics/model/address';
import { NextRequest } from 'next/server';
import { proxy } from '../../proxy.ts';
import { beforePathNormalization } from './edge.ts';
import { readAddress, type AddressRead } from './client.ts';
import { decideAddress } from './redirect.ts';

const space = 'https://rezics.com/id/0199a0fe-0b21-7000-8000-123456789abc';
const realm = 'https://rezics.com/id/0199a0fe-0b21-7000-8000-123456789abd';
const zoneId = '0199a0fe-0b21-7000-8000-123456789abe';
const zone = `https://rezics.com/id/${zoneId}`;
const admittedSpace: AddressRead = {
  kind: 'resolved',
  data: {
    profile: 'address-resolution-v1',
    status: 'resolved',
    scope: 'space',
    key: 'books',
    holder: space,
    state: 'current',
    capabilities: { realm, zone },
    canonical: { prefix: '/z/', key: 'books', slugSource: 'Books' },
  },
};

for (const locale of ['en', 'zh-Hant'] as const) {
  for (const key of [
    zoneId,
    zoneId.toUpperCase(),
    uuidToSid(zoneId),
    `${uuidToSid(zoneId)}-stale`,
  ]) {
    for (const tail of ['', '/about']) {
      test(`G1008: ${locale} admitted legacy Zone identity ${key}${tail} keeps its site surface`, async () => {
        const resolve = async () => admittedSpace;
        const destination = `/${locale}/z/books${tail}?position=all#part`;
        expect(
          await decideAddress(
            new URL(`https://rezics.test/${locale}/r/${key}${tail}/?position=all#part`),
            locale,
            resolve,
          ),
        ).toEqual({ kind: 'redirect', status: 301, location: destination });
        expect(
          await decideAddress(new URL(destination, 'https://rezics.test'), locale, resolve),
        ).toMatchObject({ kind: 'pass' });
      });
    }
  }
  for (const key of [space.slice(-36), realm.slice(-36), uuidToSid(realm.slice(-36)), 'books']) {
    test(`G1008: ${locale} Space or Realm ${key} retains the community surface`, async () => {
      expect(
        await decideAddress(
          new URL(`https://rezics.test/${locale}/r/${key}?position=all#part`),
          locale,
          async () => admittedSpace,
        ),
      ).toEqual(
        key === 'books'
          ? {
              kind: 'pass',
              data: admittedSpace.kind === 'resolved' ? admittedSpace.data : undefined,
            }
          : { kind: 'redirect', status: 301, location: `/${locale}/r/books?position=all#part` },
      );
    });
  }
  test(`G1008: ${locale} legacy document mount goes directly to its site route`, async () => {
    const lookups: unknown[] = [];
    const resolve = async (lookup: unknown) => {
      lookups.push(lookup);
      return admittedSpace;
    };
    const destination = `/${locale}/z/books/story?position=all&tag=a&tag=b#chapter`;
    expect(
      await decideAddress(
        new URL(`https://rezics.test/${locale}/r/books/story/?position=all&tag=a&tag=b#chapter`),
        locale,
        resolve,
      ),
    ).toEqual({ kind: 'redirect', status: 301, location: destination });
    // A Work mount is its own document, not a Collection member detail.
    expect(lookups).toEqual([{ scope: 'space', key: 'books' }]);
    expect(
      await decideAddress(new URL(destination, 'https://rezics.test'), locale, resolve),
    ).toMatchObject({ kind: 'pass' });
  });
}

test('G1008: proxy and trailing-slash ingress preserve the admitted legacy Zone destination', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/addresses/resolve') {
      if (admittedSpace.kind !== 'resolved') throw new Error('Expected admitted Space');
      return Response.json({ ...admittedSpace.data, key: url.searchParams.get('key') });
    }
    if (url.pathname === `/v1/realms/${realm.slice(-36)}`)
      return Response.json({
        profile: 'realm-read-v1',
        id: realm,
        visibility: 'public',
        listing: 'listed',
      });
    throw new Error(`Unexpected Main read: ${url.pathname}`);
  }) as typeof fetch;
  try {
    const response = await proxy(
      new NextRequest(`https://rezics.test/en/r/${zoneId.toUpperCase()}?position=all`),
    );
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://rezics.test/en/z/books?position=all');
    const edge = await beforePathNormalization(
      new Request(`https://rezics.test/en/r/${zoneId}/?position=all`),
    );
    expect(edge?.status).toBe(301);
    expect(edge?.headers.get('location')).toBe('https://rezics.test/en/z/books?position=all');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const phase of ['headers', 'body'] as const) {
  test(`G1008: a stalled address response ${phase} meets the read deadline and a later request recovers`, async () => {
    // Exercise native fetch cancellation, including a body that never ends.
    // Shorten the real ten-second bound only for this transport fault test.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const budgets: number[] = [];
    const deadline = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      budgets.push(ms);
      return timeout(50);
    });
    let stalled = true;
    let release: ((response: Response) => void) | undefined;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        if (!stalled) {
          if (admittedSpace.kind !== 'resolved') throw new Error('Expected admitted Space');
          return Response.json(admittedSpace.data);
        }
        if (phase === 'headers')
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    try {
      expect(
        await readAddress({ scope: 'space', key: 'books' }, 'en', server.url.origin, new Headers()),
      ).toEqual({ kind: 'unavailable' });
      release?.(new Response(null, { status: 503 }));
      stalled = false;
      expect(
        await readAddress({ scope: 'space', key: 'books' }, 'en', server.url.origin, new Headers()),
      ).toEqual(admittedSpace);
      expect(budgets).toEqual([10_000, 10_000]);
    } finally {
      release?.(new Response(null, { status: 503 }));
      await server.stop(true);
      deadline.mockRestore();
    }
  });
}
