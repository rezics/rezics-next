import { afterAll, expect, mock, test } from 'bun:test';

const origin = 'https://display-release-recovery.test';
const digest = 'release-recovery-a';
const property = 'display:exampleRelation';

mock.module('../src/kernel/client.ts', () => ({
  configuredKernelOrigin: () => origin,
  requestLocale: () => 'en',
}));

const { relationLabels } = await import('../src/subject/definitions');
const originalFetch = globalThis.fetch;
const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
Object.defineProperty(globalThis, 'caches', { configurable: true, writable: true, value: undefined });

let malformed = true;
let activeReads = 0;
let releaseReads = 0;
globalThis.fetch = (async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== origin) throw new Error(`Unexpected origin: ${url.origin}`);
  if (url.pathname === '/v1/definitions/active') {
    activeReads += 1;
    return Response.json({ digest });
  }
  if (url.pathname === `/v1/definitions/releases/${digest}`) {
    releaseReads += 1;
    return Response.json({
      digest,
      release: malformed
        ? {}
        : {
            types: {},
            properties: {
              [property]: {
                labels: { en: 'edition' },
                datatype: 'string',
                relation: { group: 'membership', inverseLabels: { en: 'work' } },
              },
            },
          },
    });
  }
  throw new Error(`Unexpected definitions path: ${url.pathname}`);
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
  else Reflect.deleteProperty(globalThis, 'caches');
  mock.restore();
});

test('a Subject relation display recovers after a malformed successful release response is corrected', async () => {
  expect(await relationLabels([property], 'en')).toEqual({});

  malformed = false;
  expect(await relationLabels([property], 'en')).toEqual({
    [property]: {
      label: 'work',
      forwardLabel: 'edition',
      group: 'membership',
      symmetric: false,
    },
  });
  expect(activeReads).toBe(1);
  expect(releaseReads).toBe(2);
});
