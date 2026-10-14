import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { spaceHref } from '../address/path.ts';
import { discussionListHref, realmDiscussionReads } from './discussion-read.ts';

test('board and thread continuations are independent selections, with the reader retained', async () => {
  const requests: { path: string; query: Record<string, string> }[] = [];
  const main = treaty<MainApp>('https://contract.invalid', { parseDate: false, fetcher: (async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    const body = url.pathname.endsWith('/classification-context') ? { context: 'https://rezics.com/id/context' }
      : url.pathname === '/v1/classification-vocabulary' ? { items: [], nextCursor: null }
      : { items: [], nextCursor: null };
    return Response.json(body);
  }) as typeof fetch });
  const reads = realmDiscussionReads(main, 'realm', 'https://rezics.com/id/person');
  await reads.boards('boards/+==');
  await reads.threads({ sort: 'top', window: 'month', concept: 'https://rezics.com/id/concept',
    cursor: 'threads/+==', boardsCursor: 'boards/+==', language: 'ja' });
  expect(requests).toEqual([
    { path: '/v1/realms/realm/classification-context', query: {} },
    { path: '/v1/classification-vocabulary', query: { context: 'https://rezics.com/id/context', limit: '20', cursor: 'boards/+==' } },
    { path: '/v1/realms/realm/threads', query: { sort: 'top', window: 'month', concept: 'https://rezics.com/id/concept',
      cursor: 'threads/+==', language: 'ja', actingSubject: 'https://rezics.com/id/person' } },
  ]);
});

test('board links preserve the selected Concept and content language without mixing opaque cursors', () => {
  const url = new URL(discussionListHref(spaceHref('garden', 'community'), { sort: 'top', window: 'all', concept: 'https://rezics.com/id/concept',
    language: 'ja', cursor: 'thread/+==', boardsCursor: 'board/+==' }), 'https://contract.invalid');
  expect(url.pathname).toBe(`${spaceHref('garden', 'community')}/discussions`);
  expect(Object.fromEntries(url.searchParams)).toEqual({ sort: 'top', t: 'all', concept: 'https://rezics.com/id/concept',
    language: 'ja', cursor: 'thread/+==', boardsCursor: 'board/+==' });
});

test('production Realm IRIs become UUID route parameters for boards, selected lists and threads', async () => {
  const realm = '8a9c681a-fb6c-4ce1-850d-73730b07894a';
  const reply = '20ea15b3-d80a-4098-a0f6-ea53288953bf';
  const requests: string[] = [];
  const main = treaty<MainApp>('https://contract.invalid', { fetcher: (async input => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    requests.push(path);
    return Response.json(path.endsWith('/classification-context') ? { context: 'context' } : { items: [] });
  }) as typeof fetch });
  const reads = realmDiscussionReads(main, `https://rezics.com/id/${realm}`);
  await reads.boards();
  await reads.threads({ sort: 'best', window: 'week', concept: 'concept' });
  await reads.thread(`https://rezics.com/id/${reply}`, 'new');
  expect(requests).toEqual([
    `/v1/realms/${realm}/classification-context`, '/v1/classification-vocabulary',
    `/v1/realms/${realm}/threads`, `/v1/realms/${realm}/threads/${reply}`,
  ]);
});

test('closed and absent discussions retain the same ordinary failure for every reader', async () => {
  for (const actor of [undefined, 'stranger', 'member', 'owner', 'moderator', 'operator']) {
    const main = treaty<MainApp>('https://contract.invalid', { fetcher: (async (_input: RequestInfo | URL) =>
      Response.json({ code: 'not_found', message: 'Not found' }, { status: 404 })) as typeof fetch });
    for (const realm of ['closed', 'absent']) {
      const reads = realmDiscussionReads(main, realm, actor);
      expect(await reads.threads({ sort: 'new', window: 'week' })).toMatchObject({ ok: false, failure: 'missing', status: 404 });
      expect(await reads.thread('reply', 'new')).toMatchObject({ ok: false, failure: 'missing', status: 404 });
      expect(await reads.boards()).toMatchObject({ ok: false, failure: 'missing', status: 404 });
    }
  }
});

test('unsupported board selection remains a refusal rather than locally filtered success', async () => {
  const main = treaty<MainApp>('https://contract.invalid', { fetcher: (async (_input: RequestInfo | URL) =>
    Response.json({ code: 'invalid_request' }, { status: 400 })) as typeof fetch });
  expect(await realmDiscussionReads(main, 'realm').threads({ sort: 'new', window: 'week', concept: 'board' }))
    .toMatchObject({ ok: false, failure: 'invalid', status: 400 });
});
