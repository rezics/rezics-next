import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { id, selected } from '../src/stories/exact-revision/fixture';
import { PostHistoryLifetime, type HistoryPage } from '../src/threads/post-history-lifetime';
import { loadPostHistoryPage } from '../src/threads/post-history-read';

const cursor = 'opaque-native/+=cursor';
const page = (count: number): HistoryPage => ({
  available: true,
  revisions: Array.from({ length: count }, (_, index) => ({ ...selected, revisionId: id(1_000 + index) })),
  next: cursor,
  authors: {},
  mentions: { [selected.authorId]: { handle: 'previous-mention' } },
  subjects: [{ id: id(20), label: 'Previous label', labels: {}, types: [], cover: null }],
  reviewVotes: { [selected.id]: selected.voteCitation! },
  documentMedia: { kind: 'ready', images: new Map() },
  now: selected.createdAt,
});

test('1/20/100 native rows are replaced before transport; failure and retry retain only the exact cursor', () => {
  for (const count of [1, 20, 100]) {
    const owner = new PostHistoryLifetime(() => true);
    const ticket = owner.ticket();
    owner.update(ticket, (view) => ({ ...view, open: true }));
    const first = owner.begin(ticket)!;
    owner.acceptPage(first, page(count));
    owner.finish(first);
    expect(owner.snapshot().revisions).toHaveLength(count);
    const generation = owner.snapshot().pageGeneration;
    const next = owner.begin(ticket, undefined, selected.id, cursor)!;
    expect(owner.ownsPage(ticket, generation)).toBe(false);
    expect(owner.snapshot()).toMatchObject({ revisions: [], authors: {}, mentions: {}, subjects: [], reviewVotes: {} });
    owner.failPage(next);
    owner.finish(next);
    expect(owner.snapshot()).toMatchObject({ available: false, failedCursor: cursor });
    const retry = owner.begin(ticket, undefined, selected.id, owner.snapshot().failedCursor)!;
    expect(retry.binding.target).toMatchObject({ postId: selected.id, cursor });
    owner.acceptPage(first, page(100)); // A delayed former response has no page authority.
    expect(owner.snapshot().revisions).toHaveLength(0);
    owner.acceptPage(retry, { ...page(1), next: null });
    owner.finish(retry);
    expect(owner.snapshot().revisions).toHaveLength(1);
    expect(owner.snapshot().next).toBeNull();
  }
});

test('observed owner replacement retires every page field and delayed response even after an A–B–A return', () => {
  let current = true;
  let observe = () => {};
  const owner = new PostHistoryLifetime(
    () => current,
    (listener) => {
      observe = listener;
      return () => {};
    },
  );
  const disconnect = owner.connect();
  const request = owner.begin(owner.ticket())!;
  owner.acceptPage(request, page(20));
  current = false;
  observe();
  current = true;
  owner.acceptPage(request, page(100));
  expect(owner.snapshot()).toMatchObject({
    revisions: [],
    authors: {},
    mentions: {},
    subjects: [],
    reviewVotes: {},
    open: false,
  });
  expect(owner.current()).toBe(false);
  disconnect();
});

test('nested author/mention keys share bounded hydration with exact association at 1/20/100 revisions', async () => {
  for (const count of [1, 20, 100]) {
    const mentionIds = [id(100), ...Array.from({ length: 99 }, (_, index) => id(4_000 + index))];
    const revisions = page(count).revisions.map((revision, index) => ({
      ...revision,
      authorId: id(100 + index),
      subjectIds: [],
      voteCitation: null,
      body: {
        ...selected.body!,
        doc: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: mentionIds.map((accountId) => ({ type: 'mention', attrs: { accountId } })) },
          ],
        },
      },
    }));
    const hydrated: string[] = [];
    let reads = 0;
    const client = createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname.endsWith('/revisions')) {
          reads++;
          return Response.json({ revisions, next: cursor });
        }
        expect(url.pathname).toBe('/v1/accounts');
        const ids = url.searchParams.get('ids')!.split(',');
        expect(ids.length).toBeLessThanOrEqual(100);
        hydrated.push(...ids);
        return Response.json({
          accounts: [...ids, id(9_999)].map((accountId) => ({
            id: accountId,
            state: 'active',
            kind: 'actor',
            displayName: 'Current name',
            handle: `reader-${accountId}`,
            automated: false,
            operatorId: null,
          })),
        });
      },
    });
    const result = await loadPostHistoryPage(
      client,
      { postId: selected.id },
      { authorization: null, subject: undefined },
    );
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('Expected an admitted page');
    expect(Object.keys(result.authors!)).toHaveLength(count);
    expect(Object.keys(result.mentions)).toEqual(mentionIds);
    expect(new Set(hydrated).size).toBe(hydrated.length);
    expect(hydrated).toHaveLength(count + 99);
    expect(reads).toBe(1);
  }
});
