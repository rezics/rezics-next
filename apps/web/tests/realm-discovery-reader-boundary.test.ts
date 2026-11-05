import { expect, mock, test } from 'bun:test';

const nativeCalls: { locale: string; query: unknown; cache: string }[] = [];
let receivedSignal: AbortSignal | undefined;

function createServerFn() {
  let validate: (value: unknown) => unknown = (value) => value;
  const chain = {
    validator(next: (value: unknown) => unknown) {
      validate = next;
      return chain;
    },
    handler(run: (input: { data: unknown }) => unknown) {
      return (input: { data: unknown; signal?: AbortSignal }) => {
        const data = validate(input.data);
        receivedSignal = input.signal;
        return run({ data });
      };
    },
  };
  return chain;
}

mock.module('@tanstack/react-start', () => ({ createServerFn }));
mock.module('../src/kernel/client', () => ({
  kernelClient(locale: string) {
    return {
      realms: {
        discovery: {
          async get(options: { query: unknown; fetch: { cache: string } }) {
            nativeCalls.push({ locale, query: options.query, cache: options.fetch.cache });
            return { data: { realms: [], next: null } };
          },
        },
      },
    };
  },
}));

test('header Realm browsing uses the strict Search reader before native I/O', async () => {
  const { loadSearchRealmDiscovery } = await import('../src/search/realm-discovery-section');
  type Request = import('../src/search/realm-discovery-section').SearchRealmDiscoveryRequest;
  const signal = new AbortController().signal;
  const read = async (request: Request) => loadSearchRealmDiscovery(request, signal);
  const request: Request = { locale: 'zh-Hant', sort: 'trending', limit: 20 };

  await expect(read({ ...request, locale: '' })).rejects.toThrow();
  await expect(read({ ...request, cursor: 'x'.repeat(4097) })).rejects.toThrow();
  await expect(read({ ...request, extra: true } as Request)).rejects.toThrow();
  expect(nativeCalls).toEqual([]);
  expect(receivedSignal).toBeUndefined();

  expect(await read(request)).toEqual({ kind: 'ready', realms: [], next: null });
  expect(nativeCalls).toEqual([{ locale: 'zh-Hant', query: { sort: 'trending', limit: 20 }, cache: 'no-store' }]);
  expect(receivedSignal).toBe(signal);
});
