import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { normalizeDocument } from '@rezics/document';
import type { PublicIdentity } from '../../src/access/account-data.ts';
import publicIdentityPage from '../../src/access/public-identity-page.sql';
import {
  currentReadingPageMentions,
  readingPageMentionIdentityViews,
  selectReadingPageMentions,
  unavailableReadingPageMentions,
  type ReadingPageMentionPost,
} from '../../src/content/reading-page-mentions.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { observeSql } from './support/sql-observer.ts';
import { createThreadReadingPageFixture } from './support/thread-reading-page-fixture.ts';

const threadId = newId(0);
const hash = 'a'.repeat(64);

function mentionBody(ids: readonly string[]) {
  return normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'text',
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'mentions' },
          content: ids.map((accountId) => ({ type: 'mention', attrs: { accountId } })),
        },
      ],
    },
  });
}

function mentionPost(id: string, accountIds: readonly string[]): ReadingPageMentionPost {
  return {
    id,
    threadId,
    availability: 'available',
    revisionId: newId(0),
    sha256: hash,
    body: mentionBody(accountIds),
  };
}

let f: Awaited<ReturnType<typeof createThreadReadingPageFixture>>;
setDefaultTimeout(120_000);
beforeAll(async () => {
  f = await createThreadReadingPageFixture();
}, 240_000);
afterAll(async () => {
  await f?.close();
});
let window = 0;
beforeEach(async () => {
  await f.setTime(Date.now() + ++window * 60_000);
});

test('mention selection binds readable page occurrences and caps distinct identities at 100', () => {
  const ids = Array.from({ length: 101 }, () => newId(0));
  const first = mentionPost(newId(0), ids.slice(0, 100));
  const second = mentionPost(newId(0), [ids[0]!, ids[100]!]);
  const erased: ReadingPageMentionPost = {
    ...mentionPost(newId(0), [newId(0)]),
    availability: 'erased',
    body: null,
    sha256: null,
  };
  const selection = selectReadingPageMentions([first, erased, second]);

  expect(selection.identities).toEqual(ids.slice(0, 100));
  expect(selection.sources).toEqual([
    expect.objectContaining({ postId: first.id, threadId, revisionId: first.revisionId, sha256: hash, pageIndex: 0 }),
    expect.objectContaining({
      postId: second.id,
      threadId,
      revisionId: second.revisionId,
      sha256: hash,
      pageIndex: 2,
      references: [ids[0]],
      overflow: true,
    }),
  ]);
  expect(selection.overflow).toBe(true);
  expect(selection.sources.flatMap((source) => source.references).filter((id) => id === ids[0])).toHaveLength(2);
});

test('empty, unavailable, active, concealed and erased identity states stay distinct', () => {
  const post = mentionPost(newId(0), []);
  const empty = selectReadingPageMentions([post]);
  expect(currentReadingPageMentions(empty, [])).toMatchObject({ state: 'current', retryable: false, overflow: false });
  expect(unavailableReadingPageMentions(empty)).toMatchObject({
    state: 'unavailable',
    retryable: true,
    identities: [],
  });

  const activeId = newId(0);
  const deletedId = newId(0);
  const concealedId = newId(0);
  const active: PublicIdentity = {
    id: activeId,
    kind: 'actor',
    handle: 'reader',
    displayName: null,
    state: 'active',
    automated: false,
    operatorId: null,
  };
  const deleted: PublicIdentity = { id: deletedId, kind: 'actor', state: 'deleted' };

  expect(readingPageMentionIdentityViews([activeId, concealedId, deletedId], [active, deleted])).toEqual([
    { id: activeId, state: 'active', handle: 'reader' },
    { id: concealedId, state: 'concealed' },
    { id: deletedId, state: 'erased' },
  ]);
});

test('first, continued and exact-selected-post pages contain only their readable body mentions', async () => {
  const thread = await f.thread();
  const missingAccountId = newId(routeOf(f.author.actor.accountId)!);
  const selectedReply = f.system.actors.other.actor.accountId;
  let firstMention: { id: string; revisionId: string } | undefined;
  let lastReply: { id: string; revisionId: string } | undefined;
  for (let index = 0; index < 22; index++) {
    if (index === 0 || index === 21) {
      const ids = index === 0 ? [f.author.actor.accountId, missingAccountId] : [selectedReply];
      await f.setTime(Date.now() + ++window * 60_000);
      const value = await f.checked('POST', `/v1/threads/${thread.id}/posts`, {
        bearer: f.author.bearer,
        body: {
          body: mentionBody(ids),
          licence: 'CC0-1.0',
          subjectIds: [],
          visibility: 'published',
        },
      });
      if (index === 0) firstMention = value.post;
      else lastReply = value.post;
    } else await f.post(thread.id, `Reply ${index}`);
  }

  const first = await f.page(thread.id);
  expect(first.response.status, first.text).toBe(200);
  expect(first.value.mentions).toMatchObject({ state: 'current', retryable: false, overflow: false });
  expect(first.value.mentions.identities.map((identity: { id: string }) => identity.id)).toEqual([
    f.author.actor.accountId,
    missingAccountId,
  ]);
  expect(first.value.mentions.identities[1]).toEqual({ id: missingAccountId, state: 'concealed' });
  expect(
    first.value.mentions.sources.find((source: { postId: string }) => source.postId === firstMention?.id),
  ).toMatchObject({
    pageIndex: 1,
    references: [f.author.actor.accountId, missingAccountId],
  });
  expect(first.value.mentions.identities.some((identity: { id: string }) => identity.id === selectedReply)).toBe(false);

  const continued = await f.page(thread.id, undefined, first.value.replies.next);
  expect(continued.response.status, continued.text).toBe(200);
  expect(
    continued.value.mentions.sources.find((source: { postId: string }) => source.postId === lastReply?.id),
  ).toMatchObject({
    pageIndex: 2,
    revisionId: lastReply?.revisionId,
    references: [selectedReply],
  });

  const location = await f.checked('GET', `/v1/threads/${thread.id}/posts/${lastReply!.id}/location`, {}, 200);
  const exact = await f.page(thread.id, undefined, location.cursor);
  expect(exact.response.status, exact.text).toBe(200);
  expect(exact.value.query.cursor).toBe(location.cursor);
  expect(exact.value.mentions.sources.some((source: { postId: string }) => source.postId === lastReply!.id)).toBe(true);
  expect(exact.value.mentions.identities.map((identity: { id: string }) => identity.id)).toEqual([selectedReply]);

  const observer = observeSql(f.system.database.pool);
  const barrier = observer.hold({ statement: publicIdentityPage.sql }, 'before');
  let pending: ReturnType<typeof f.page> | undefined;
  try {
    pending = f.page(thread.id);
    await Promise.race([
      barrier.entered,
      pending.then((value) => {
        throw new Error(`Reading page missed mention identity hydration: ${value.response.status} ${value.text}`);
      }),
    ]);
    await f.revise(firstMention!.id, firstMention!.revisionId, 'Changed mention source');
    barrier.release();
    const changed = await pending;
    expect(changed.response.status, changed.text).toBe(503);
    expect(changed.value.code).toBe('dependency_unavailable');
  } finally {
    barrier.release();
    await pending?.catch(() => {});
    await observer.close();
  }
}, 240_000);
