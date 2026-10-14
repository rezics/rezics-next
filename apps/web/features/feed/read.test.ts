import { describe, expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { problemResult } from '../../../../services/main/src/api-contract.ts';
import { feedPage } from '../../../../services/main/src/modules/feed/contract.ts';
import { browserMainApi } from '../api/browser.ts';
import { mainFeedApi } from './api.ts';
import { closedRealm, closureActor, closurePersonas, closureProblem, closureQuery, closureSuccessor,
  closureTransport, closureUnavailableProblem, independentOriginals } from './closure-feed-fixtures.ts';
import { feedHeadScope, readFeedPage } from './read.ts';

describe('closed Realm feed answer consumption', () => {
  for (const persona of closurePersonas) test(`${persona}: originals, credit and exact successors survive`, async () => {
    const transport = closureTransport(persona, 'populated');
    try {
      const query = closureQuery(persona);
      const first = await readFeedPage(transport.main, query);
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('First page failed');
      expect(first.data.items).toEqual([independentOriginals[0]!]);
      expect(first.data.nextCursor).toBe(closureSuccessor);
      const api = mainFeedApi(transport.main);
      const next = await api.page({ ...query, cursor: first.data.nextCursor! });
      expect(next).toMatchObject({ ok: true, data: { items: [independentOriginals[1]!], nextCursor: null } });
      for (const call of transport.calls) {
        const request = new URL(call.path, 'https://contract.invalid');
        expect(request.searchParams.get('actingSubject') ?? undefined).toBe(closureActor(persona));
      }
      expect(new URL(transport.calls[1]!.path, 'https://contract.invalid').searchParams.get('cursor')).toBe(closureSuccessor);
      expect(JSON.stringify([first, next])).not.toContain(closedRealm);
      if (persona !== 'visitor') {
        const following = await api.page({ ...query, scope: 'following' });
        expect(following).toMatchObject({ ok: true, data: { scope: 'following' } });
        expect(JSON.stringify(following)).not.toContain(closedRealm);
      }
      for (const scope of ['all', ...(persona === 'visitor' ? [] : ['following']), `realm:${closedRealm}`]) {
        const head = await api.head({ scope, after: '40', afterReview: '7', actingSubject: closureActor(persona) });
        expect(head).toMatchObject({ ok: true, data: { scope, newPosts: { value: 0, kind: 'exact' } } });
      }
    } finally { transport.dispose(); }
  });

  for (const persona of closurePersonas) test(`${persona}: closed Realm answer is complete and empty`, async () => {
    const transport = closureTransport(persona, 'empty');
    const read = await readFeedPage(transport.main, closureQuery(persona, true));
    expect(read).toMatchObject({ ok: true, data: { items: [], nextCursor: null } });
    transport.dispose();
  });
});

test('feed head uses a Realm scope and declines unsupported combined filters', () => {
  expect(feedHeadScope(closureQuery('member', true))).toBe(`realm:${closedRealm}`);
  for (const filters of [{ realms: [closedRealm, independentOriginals[0]!.id] }, { savedFilter: 'filter' },
    { contentLanguages: ['en'] }, { kinds: ['work'] as const }, { interests: 'books' },
    { concepts: [closedRealm] }, { requiredConcept: closedRealm }, { excludedConcepts: [closedRealm] }]) {
    expect(feedHeadScope({ scope: 'all', ...filters } as Parameters<typeof feedHeadScope>[0])).toBeNull();
  }
});

test('feed read failures retain status and exact problem; only 401 requests sign-in', async () => {
  for (const [status, failure] of [[400, 'invalid'], [401, 'sign-in'], [403, 'unavailable'],
    [404, 'missing'], [409, 'moved'], [422, 'budget'], [503, 'unavailable']] as const) {
    const problem = { ...closureProblem, status, code: `feed_${status}`, type: `https://rezics.com/problems/feed_${status}` };
    const calls: string[] = [];
    const main = browserMainApi('https://contract.invalid', { fetcher: Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return Response.json(problem, { status });
    }, { preconnect: globalThis.fetch.preconnect }) });
    const query = closureQuery('member');
    const first = await readFeedPage(main, query);
    expect(first).toEqual({ ok: false, failure, status, problem });
    expect(calls).toHaveLength(status === 409 ? 2 : 1);
    const next = await readFeedPage(main, { ...query, cursor: closureSuccessor });
    expect(next).toEqual(first);
    expect(calls).toHaveLength(status === 409 ? 3 : 2);
  }
});

test('platform closure stays absent while retaining its HTTP answer', async () => {
  const problem = { ...closureProblem, code: 'platform_closed', type: 'https://rezics.com/problems/platform_closed' };
  const main = browserMainApi('https://contract.invalid', {
    fetcher: Object.assign(async () => Response.json(problem, { status: 403 }), { preconnect: globalThis.fetch.preconnect }),
  });
  expect(await readFeedPage(main, closureQuery('member'))).toEqual({ ok: false, failure: 'closed', status: 403, problem });
});

test('contract-built feed and refusal specimens conform to Main schemas', async () => {
  expect(Value.Check(problemResult(403), closureProblem)).toBe(true);
  expect(Value.Check(problemResult(503), closureUnavailableProblem)).toBe(true);
  for (const state of ['populated', 'empty', 'sparse'] as const) {
    const transport = closureTransport('member', state);
    const read = await readFeedPage(transport.main, closureQuery('member', state === 'empty'));
    if (!read.ok) throw new Error('First page failed');
    expect(Value.Check(feedPage, read.data)).toBe(true);
    transport.dispose();
  }
});

test('a transport failure has no invented HTTP status or Main problem', async () => {
  for (const [error, failure] of [[new TypeError('Failed to fetch'), 'offline'],
    [new Error('Unexpected transport failure'), 'unavailable']] as const) {
    const main = browserMainApi('https://contract.invalid', {
      fetcher: Object.assign(async () => { throw error; }, { preconnect: globalThis.fetch.preconnect }),
    });
    expect(await readFeedPage(main, closureQuery('member'))).toEqual({ ok: false, failure });
  }
});

test('an empty page retains its successor, and a refused successor retains the first original', async () => {
  for (const state of ['sparse', 'continuation-forbidden'] as const) {
    const transport = closureTransport('member', state);
    const api = mainFeedApi(transport.main);
    const first = await readFeedPage(transport.main, closureQuery('member'));
    if (!first.ok) throw new Error('First page failed');
    expect(first.data.nextCursor).toBe(closureSuccessor);
    const next = await api.page({ ...closureQuery('member'), cursor: first.data.nextCursor! });
    if (state === 'sparse') {
      expect(first.data.items).toEqual([]);
      expect(next).toMatchObject({ ok: true, data: { items: [independentOriginals[1]!], nextCursor: null } });
    } else {
      expect(first.data.items).toEqual([independentOriginals[0]!]);
      expect(next).toEqual({ ok: false, failure: 'unavailable', status: 403, problem: closureProblem });
    }
    transport.dispose();
  }
});
