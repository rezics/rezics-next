import { expect, expectTypeOf, test } from 'bun:test';
import { createKernelClient, type FeedPage, type KernelClient } from '../src/index.ts';

expectTypeOf<Awaited<ReturnType<KernelClient['feedItems']['get']>>['data']>().toEqualTypeOf<FeedPage | null>();

test('the exported mounted feed page preserves empty and retry continuations', async () => {
  for (const following of ['ready', 'unavailable'] as const) {
    const page: FeedPage = {
      feedItems: [], next: following === 'unavailable' ? 'original-frontier' : null,
      asOf: '2026-11-04T00:00:00Z',
      sources: { following, discovery: 'not_requested', continue: 'not_requested' },
    };
    const fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://kernel.test/v1/feedItems?stream=following');
      return Response.json(page);
    }) as typeof globalThis.fetch;
    const result = await createKernelClient('https://kernel.test', { fetch }).feedItems.get({ query: { stream: 'following' } });
    expect(result.error).toBeNull();
    expect(result.data).toEqual(page);
  }
});
