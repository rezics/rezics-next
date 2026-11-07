import { expect, test } from 'bun:test';
import {
  prepareReadingPageReviewContext,
  readReadingPageDocumentMedia,
  readReadingPageMentions,
  selectReadingPageActivity,
  selectReadingPageDocumentMedia,
  selectReadingPageMentions,
} from '../../src/content/application/index.ts';
import {
  ReadingPageChangedError,
  type ReadingPageActivitySelection,
  type ReadingPageCitationThread,
  type ReadingPageOptional,
  type ReadingPagePost,
} from '../../src/content/contract/index.ts';

const current = <T>(value: T): ReadingPageOptional<T> => ({ state: 'current', value });
const unavailable = { state: 'unavailable' } as const;
type ActivitySelection = ReadingPageActivitySelection<string>;
const place = {
  threadId: 'thread',
  boardId: 'board',
  threadSecurityRevision: '3',
  boardSecurityRevision: '4',
  realmId: null,
};

function document(id: string, image: string, mentions: readonly string[] = []): ReadingPagePost {
  return {
    id,
    threadId: place.threadId,
    availability: 'available',
    revisionId: `${id}-revision`,
    sha256: 'a'.repeat(64),
    mediaIds: [image],
    body: {
      doc: {
        type: 'doc',
        content: [
          { type: 'image', attrs: { src: image } },
          ...mentions.map((accountId) => ({ type: 'mention', attrs: { accountId } })),
        ],
      },
    },
  };
}

function review(): ReadingPageCitationThread {
  return {
    id: place.threadId,
    route: 0,
    kind: 'review',
    firstPost: {
      id: 'opening',
      threadId: place.threadId,
      route: 0,
      availability: 'available',
      revisionId: 'opening-revision',
      disclosure: 'visible',
      voteCitation: { questionId: 'historical-question', units: 0, revision: 7 },
    },
  };
}

test('activity confirms its original source after enrichment and keeps an outage distinct from zero', async () => {
  const item: ReadingPageActivitySelection<string> = {
    threadId: place.threadId,
    status: 'current',
    cohort: 'public',
    replyCount: { kind: 'exact', value: 0 },
    lastContributionAt: null,
    witness: { ...place, source: 'original-anchor' },
  };
  const calls: unknown[] = [];
  const producer = {
    select: async (ids: readonly string[], deadline: number) => {
      calls.push([ids, deadline]);
      return current([item]);
    },
    confirm: async (selected: readonly ActivitySelection[], deadline: number) => {
      calls.push([selected, deadline]);
      return current(selected);
    },
  };
  const selected = await selectReadingPageActivity<string, ActivitySelection>(producer, place, 123);
  expect(calls).toHaveLength(1);
  const confirmed = await selected.confirm();
  expect(confirmed).toEqual({
    value: { state: 'current', cohort: 'public', count: { kind: 'exact', value: 0 }, lastActivityAt: null },
    anchors: ['original-anchor'],
  });
  expect(calls[1]).toEqual([[item], 123]);
  const outage = await selectReadingPageActivity<string, ActivitySelection>(
    { ...producer, confirm: async () => unavailable },
    place,
    123,
  );
  expect(await outage.confirm()).toEqual({ value: { state: 'unavailable', retryable: true }, anchors: [] });
  const stale = await selectReadingPageActivity<string, ActivitySelection>(
    {
      ...producer,
      confirm: async () => current([{ threadId: place.threadId, status: 'withheld', reason: 'stale' } as const]),
    },
    place,
    123,
  );
  await expect(stale.confirm()).rejects.toBeInstanceOf(ReadingPageChangedError);
});

test('review target outages preserve exact historical citations and never substitute a current scale', async () => {
  for (const phase of ['prepare', 'finish']) {
    const thread = review();
    const selected = await prepareReadingPageReviewContext(
      { prepare: async () => (phase === 'prepare' ? unavailable : current({ finish: async () => unavailable })) },
      thread,
      [],
    );
    const value = await selected.finish();
    expect(value).toEqual({
      source: { threadId: place.threadId, postId: 'opening', revisionId: 'opening-revision' },
      target: unavailable,
      citations: {
        state: 'current',
        items: [
          {
            postId: 'opening',
            sourceRevisionId: 'opening-revision',
            citation: {
              state: 'available',
              questionId: 'historical-question',
              units: 0,
              voteRevision: 7,
              metadata: unavailable,
            },
          },
        ],
      },
    });
    await expect(selected.finish()).rejects.toThrow('can finish only once');
  }
  const hidden = review();
  const selected = await prepareReadingPageReviewContext(
    { prepare: async () => unavailable },
    { ...hidden, firstPost: { ...hidden.firstPost, disclosure: 'withheld', voteCitation: null } },
    [],
  );
  expect((await selected.finish())?.citations.items[0]?.citation).toEqual({ state: 'withheld' });
  const ordinary = await prepareReadingPageReviewContext(
    {
      prepare: async () => {
        throw new Error('unexpected lookup');
      },
    },
    { ...review(), kind: 'discussion' },
    [],
  );
  expect(await ordinary.finish()).toBeUndefined();
});

test('partial sibling images do not conceal an independently readable exact document', async () => {
  const first = document('first', 'one');
  const second = document('second', 'two');
  const selection = selectReadingPageDocumentMedia(place.threadId, [first, second], () => true);
  const presentation = { id: 'one', containerId: place.threadId };
  const value = await readReadingPageDocumentMedia(
    {
      read: async (ids) => {
        expect(ids).toEqual(['one', 'two']);
        return current([presentation, { id: 'two', containerId: 'foreign-thread' }]);
      },
    },
    selection,
  );
  expect(value.state).toBe('available');
  expect(value.documents.map((entry) => [entry.postId, entry.revisionId, entry.sha256, entry.state])).toEqual([
    ['first', first.revisionId, first.sha256, 'available'],
    ['second', second.revisionId, second.sha256, 'unavailable'],
  ]);
  expect(value.documents[0]?.images[0]).toEqual({ id: 'one', state: 'available', presentation });
  expect(value.documents[1]?.images[0]).toEqual({ id: 'two', state: 'unavailable' });
  const failed = await readReadingPageDocumentMedia({ read: async () => unavailable }, selection);
  expect(failed.state).toBe('unavailable');
  expect(failed.documents.map((entry) => entry.postId)).toEqual(['first', 'second']);
  const defect = new Error('unexpected media defect');
  await expect(
    readReadingPageDocumentMedia(
      {
        read: async () => {
          throw defect;
        },
      },
      selection,
    ),
  ).rejects.toBe(defect);
});

test('mention keys stay bounded and immutable; live, deleted, unknown and failed are distinct', async () => {
  const ids = Array.from({ length: 101 }, (_, index) => `account-${index}`);
  const posts = [document('first', 'one', ids.slice(0, 100)), document('last', 'two', [ids[0]!, ids[100]!])];
  const selection = selectReadingPageMentions(posts, () => true);
  expect(selection.identities).toEqual(ids.slice(0, 100));
  expect(selection.sources[1]).toMatchObject({
    postId: 'last',
    revisionId: 'last-revision',
    pageIndex: 1,
    references: [ids[0]],
    overflow: true,
  });
  const value = await readReadingPageMentions(
    {
      read: async (keys) => {
        expect(keys).toEqual(ids.slice(0, 100));
        return current([
          { id: ids[0]!, state: 'active', handle: 'reader' },
          { id: ids[1]!, state: 'deleted' },
          { id: ids[2]!, state: 'unknown' },
          { id: ids[0]!, state: 'deleted' },
        ] as const);
      },
    },
    selection,
  );
  expect(value.identities.slice(0, 4)).toEqual([
    { id: ids[0], state: 'active', handle: 'reader' },
    { id: ids[1], state: 'erased' },
    { id: ids[2], state: 'concealed' },
    { id: ids[3], state: 'concealed' },
  ]);
  const failed = await readReadingPageMentions({ read: async () => unavailable }, selection);
  expect(failed).toMatchObject({ state: 'unavailable', retryable: true, identities: [], overflow: true });
  expect(failed.sources).toEqual(selection.sources);
  const empty = await readReadingPageMentions(
    {
      read: async () => {
        throw new Error('unexpected lookup');
      },
    },
    selectReadingPageMentions([], () => true),
  );
  expect(empty).toEqual({ state: 'current', retryable: false, overflow: false, sources: [], identities: [] });
});
