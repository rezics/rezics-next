import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { id, selected } from '../src/stories/exact-revision/fixture';
import { loadPostHistoryPage } from '../src/threads/post-history-read';

const reader = { authorization: `Bearer ${selected.authorId}`, subject: selected.authorId };
const cursor = 'opaque-native/+=cursor';
const address = { postId: selected.id, cursor };

function transport(respond: (url: URL) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return respond(new URL(request.url));
    },
  });
  return { calls, client };
}

test('one native page preserves order, original target and historical zero at 1/20/100 rows', async () => {
  for (const count of [1, 20, 100]) {
    const revisions = Array.from({ length: count }, (_, index) => ({
      ...selected,
      revisionId: id(1_000 + index),
      subjectIds: Array.from({ length: 128 }, (_, key) => id(2_000 + key)),
      mediaIds: Array.from({ length: 32 }, (_, key) => id(3_000 + key)),
      voteCitation: { ...selected.voteCitation!, units: 0 },
    }));
    const native = { revisions, next: cursor };
    const { client, calls } = transport((url) => {
      if (url.pathname.endsWith('/revisions')) return Response.json(native);
      if (url.pathname === '/v1/accounts') return Response.json({ accounts: [] });
      if (url.pathname.startsWith('/v1/subjects/'))
        return Response.json({ subject: { id: url.pathname.split('/').at(-1), type: 'schema:Book', labels: {} } });
      throw new Error(`Unexpected read: ${url.pathname}`);
    });
    const page = await loadPostHistoryPage(client, address, reader);
    expect(page.available).toBe(true);
    if (!page.available) throw new Error('Expected admitted history');
    expect(page.revisions).toEqual(revisions);
    expect(page.next).toBe(cursor);
    expect(page.reviewVotes).toEqual({});
    expect(page.authors).toEqual({});
    expect(
      calls.map((request) => new URL(request.url).pathname).filter((path) => path.endsWith('/revisions')),
    ).toHaveLength(1);
    expect(calls.filter((request) => new URL(request.url).pathname === '/v1/accounts')).toHaveLength(1);
    expect(calls.filter((request) => new URL(request.url).pathname.startsWith('/v1/subjects/'))).toHaveLength(4);
    expect(new URL(calls[0]!.url).searchParams.get('limit')).toBe('20');
    expect(new URL(calls[0]!.url).searchParams.get('cursor')).toBe(cursor);
    expect(calls[0]!.headers.get('authorization')).toBe(reader.authorization);
  }
});

test('foreign post/thread, duplicate revision and oversized pages withhold every dependent read', async () => {
  for (const revisions of [
    [{ ...selected, id: id(9) }],
    [selected, { ...selected, revisionId: id(9), threadId: id(10) }],
    [selected, selected],
    Array.from({ length: 101 }, (_, index) => ({ ...selected, revisionId: id(1_000 + index) })),
  ]) {
    const { client, calls } = transport(() => Response.json({ revisions, next: cursor }));
    expect(await loadPostHistoryPage(client, address, reader)).toEqual({ available: false });
    expect(calls).toHaveLength(1);
  }
});

test('transport retry repeats the same opaque address; denied and empty remain distinct', async () => {
  let attempt = 0;
  const { client, calls } = transport(() => {
    if (++attempt === 1) throw new Error('History connection lost');
    return attempt === 2
      ? Response.json({ revisions: [], next: cursor })
      : Response.json({ code: 'not_found' }, { status: 404 });
  });
  expect(await loadPostHistoryPage(client, address, reader)).toEqual({ available: false, transportFailed: true });
  const empty = await loadPostHistoryPage(client, address, reader);
  expect(empty.available && empty.revisions).toEqual([]);
  expect(empty.available && empty.next).toBe(cursor);
  expect(await loadPostHistoryPage(client, address, reader)).toEqual({ available: false });
  expect(new Set(calls.map((request) => request.url)).size).toBe(1);
});
