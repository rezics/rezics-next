import { expect, test } from 'bun:test';
import { browserMainApi } from '../api/browser.ts';
import { mainFeedApi } from './api.ts';
import { page, post, storyId } from './fixtures.ts';
import { appendPosts } from './projection.ts';
import type { FeedQuery } from './types.ts';

for (const reader of ['no-selected-agent', 'ineligible-agent', 'acting-context-unavailable', 'visitor', 'eligible-agent']) {
  test(`${reader}: first, successor, head and recovery keep the same reader authority`, async () => {
    const actor = reader === 'eligible-agent' ? storyId(801, 'bbbb') : undefined;
    const query: FeedQuery = { scope: actor ? 'following' : 'all', sort: 'best', ...(actor ? { actingSubject: actor } : {}) };
    const calls: { path: URL; credentials?: RequestCredentials; method: string }[] = [];
    let interrupted = false;
    const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : String(input));
      calls.push({ path, credentials: init?.credentials, method: init?.method ?? 'GET' });
      if (path.searchParams.has('actingSubject') !== (init?.credentials === 'same-origin'))
        return Response.json({ code: 'invalid_home_command' }, { status: 400 });
      if (path.pathname.endsWith('/head')) return Response.json({ scope: query.scope, newPosts: { value: 0, kind: 'exact' } });
      if (init?.method === 'POST') return Response.json({ value: 1, score: 13, revision: storyId(900) });
      if (path.searchParams.has('cursor')) {
        if (!interrupted) {
          interrupted = true;
          return Response.json({ code: 'temporarily_unavailable' }, { status: 503 });
        }
        return Response.json(page([post(1), post(2)], { scope: query.scope }));
      }
      return Response.json(page([post(1)], { scope: query.scope, nextCursor: 'successor' }));
    }, { preconnect: fetch.preconnect });
    const api = mainFeedApi(browserMainApi('https://reader.invalid', { fetcher }),
      browserMainApi('https://reader.invalid', { anonymous: true, fetcher }));
    const first = await api.page(query);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('The first page must be readable');
    expect(await api.page({ ...query, cursor: first.data.nextCursor! }))
      .toMatchObject({ ok: false, failure: 'unavailable', status: 503 });
    const recovered = await api.page(query);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error('Recovery must keep the first-page identity');
    const next = await api.page({ ...query, cursor: recovered.data.nextCursor! });
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error('The successor must be readable');
    expect(appendPosts(recovered.data.items, next.data.items).map(item => item.id)).toEqual([post(1).id, post(2).id]);
    expect(next.data.nextCursor).toBeNull();
    expect(await api.head({ scope: query.scope!, after: '40', afterReview: '7', ...(actor ? { actingSubject: actor } : {}) }))
      .toMatchObject({ ok: true });
    for (const call of calls) {
      expect(call.credentials).toBe(actor ? 'same-origin' : 'omit');
      expect(call.path.searchParams.get('actingSubject')).toBe(actor ?? null);
    }
  });
}

test('public reading never downgrades commands made by an eligible Agent', async () => {
  const calls: { credentials?: RequestCredentials; body?: BodyInit | null }[] = [];
  const fetcher = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ credentials: init?.credentials, body: init?.body });
    return Response.json({ value: 1, score: 13, revision: storyId(900) });
  }, { preconnect: fetch.preconnect });
  const api = mainFeedApi(browserMainApi('https://reader.invalid', { fetcher }),
    browserMainApi('https://reader.invalid', { anonymous: true, fetcher }));
  await api.vote(post(1).id, { value: 1, expectedRevision: null, actingSubject: storyId(801) }, 'vote-once');
  expect(calls[0]?.credentials).toBe('same-origin');
  expect(JSON.parse(String(calls[0]?.body))).toMatchObject({ actingSubject: storyId(801) });
});
