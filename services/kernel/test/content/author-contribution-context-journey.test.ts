import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { readPost, readThread } from '../../src/content/reads.ts';
import { prepareAuthorItemContext } from '../../src/content/author-item-context.ts';
import views from '../../src/access/account-views-read.sql';
import { observeSql } from './support/sql-observer.ts';
import { createReviewLifecycleFixture } from './review-native-lifecycle-fixture.ts';
import {
  createContextReply,
  createContextReview,
  grantAuthorEditor,
  setAuthorViews,
} from './support/author-contribution-context-fixture.ts';

const reviewPath = (author: string) => `/v1/accounts/${author}/threads?kind=review`;

test('mounted public author pages retain exact review citations and anonymous immediate-parent context', async () => {
  const f = await createReviewLifecycleFixture();
  try {
    await setAuthorViews(f, { posts: true, reviews: true });
    const review = await createContextReview(f);
    const replacementTarget = await f.subject('Replacement target must not substitute');
    const movedTarget = await f.call('POST', `/v1/posts/${review.openingId}/revisions`, {
      bearer: f.author.bearer,
      ifMatch: review.revisionId,
      body: {
        body: fromPlainText('Attempted target replacement'),
        licence: 'CC0-1.0',
        subjectIds: [replacementTarget],
        boardId: f.boardId,
        voteCitation: review.citation,
      },
    });
    expect(movedTarget.response.status).toBe(400);
    const parent = await createContextReply(f, review.threadId, 'Immediate parent '.repeat(20));
    const child = await createContextReply(f, review.threadId, 'Public child', parent.id);
    const currentVote = await f.call('PUT', `/v1/subjects/${f.subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`, {
      bearer: f.author.bearer,
      body: { units: 8 },
    });
    expect(currentVote.response.status).toBe(200);
    expect(currentVote.value).toMatchObject({ units: 8, revision: review.citation.revision + 1 });

    const anonymous = await f.call('GET', reviewPath(f.author.accountId));
    const admitted = await f.call('GET', reviewPath(f.author.accountId), { bearer: f.other.bearer });
    expect(anonymous.response.status).toBe(200);
    expect(admitted.response.status).toBe(200);
    expect(anonymous.value.threads.map((item: { id: string }) => item.id)).toContain(review.threadId);
    expect(admitted.value.threads.map((item: { id: string }) => item.id)).toContain(review.threadId);
    expect(anonymous.value.actionSelection).toBeDefined();
    const row = anonymous.value.threads.find((item: { id: string }) => item.id === review.threadId);
    expect(row).toMatchObject({
      id: review.threadId,
      firstPost: { id: review.openingId, revisionId: review.revisionId, voteCitation: review.citation },
      reviewContext: {
        target: {
          state: 'available',
          subject: {
            id: f.subjectId,
            kind: 'schema:Book',
            label: { value: 'Native review lifecycle subject', language: 'en' },
          },
        },
        citation: { state: 'withheld' },
      },
      conversationActivity: { state: 'current', cohort: 'public' },
    });
    expect(JSON.stringify(row.reviewContext)).not.toContain('How much did you like this work?');

    const posts = await f.call('GET', `/v1/accounts/${f.author.accountId}/posts`);
    const reply = posts.value.posts.find((item: { id: string }) => item.id === child.id);
    expect(reply).toMatchObject({
      id: child.id,
      threadId: review.threadId,
      revisionId: child.revisionId,
      thread: { id: review.threadId },
      parentContext: {
        kind: 'reply',
        parent: { state: 'available', id: parent.id, author: null, language: 'ja', spoiler: true },
      },
    });
    expect(reply.parentContext.parent.excerpt.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(reply.parentContext)).not.toContain('private-attribute');
    expect(JSON.stringify(reply.parentContext)).not.toContain('private annotation');

    const protectedParent = await createContextReply(f, review.threadId, 'Concealed parent', undefined, 'protected');
    const protectedChild = await createContextReply(
      f,
      review.threadId,
      'Child with concealed parent',
      protectedParent.id,
    );
    const dependencies = {
      pool: f.system.database.pool,
      access: f.system.access,
      tokens: f.system.tokenKeys,
      routeKey: f.system.routeKey,
    };
    const context = {
      actor: { kind: 'account' as const, accountId: f.author.accountId },
      deadline: Date.now() + 120_000,
    };
    const [thread, post] = await Promise.all([
      readThread(dependencies, review.threadId, context),
      readPost(dependencies, review.threadId, protectedChild.id, context),
    ]);
    if (!thread.value || !post.value || post.value.availability !== 'available')
      throw new Error('Expected private source');
    const prepared = await prepareAuthorItemContext(
      dependencies,
      [{ thread: thread.value, post: post.value }],
      context,
    );
    const concealed = (await prepared.finish()).get(protectedChild.id);
    await prepared.confirm();
    expect(concealed?.parentContext).toEqual({ kind: 'reply', parent: { state: 'withheld' } });

    await setAuthorViews(f, { posts: false, reviews: false });
    expect((await f.call('GET', reviewPath(f.author.accountId))).value.threads).toEqual([]);
    expect((await f.call('GET', reviewPath(f.author.accountId), { bearer: f.other.bearer })).value.threads).toEqual([]);
    expect(
      (await f.call('GET', reviewPath(f.author.accountId), { bearer: f.author.bearer })).value.threads,
    ).toHaveLength(1);
    await grantAuthorEditor(f, f.other.accountId);
    expect(
      (await f.call('GET', reviewPath(f.author.accountId), { bearer: f.other.bearer })).value.threads,
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 240_000);

test('a source replacement during the final Accounts observation is retryable on the same input', async () => {
  const f = await createReviewLifecycleFixture();
  const observer = observeSql(f.system.database.pool);
  const path = reviewPath(f.author.accountId);
  let gate: ReturnType<typeof observer.hold> | undefined;
  try {
    await setAuthorViews(f, { posts: true, reviews: true });
    const review = await createContextReview(f, f.subjectId, 'Replacement review');
    gate = observer.hold({ statement: views.sql, occurrence: 2 }, 'after');
    const pending = f.call('GET', path);
    await gate.entered;
    await f.admin.query('UPDATE content.thread SET title=$3 WHERE route=$1 AND thread_id=$2', [
      routeOf(review.threadId),
      review.threadId,
      'Replacement title after context assembly',
    ]);
    gate.release();
    const stale = await pending;
    expect(stale.response.status).toBe(503);
    expect(stale.value).toMatchObject({ code: 'dependency_unavailable' });

    const retry = await f.call('GET', path);
    expect(retry.response.status).toBe(200);
    expect(retry.value.threads[0]).toMatchObject({
      id: review.threadId,
      title: 'Replacement title after context assembly',
      firstPost: { revisionId: review.revisionId, voteCitation: review.citation },
    });
  } finally {
    gate?.release();
    await observer.close();
    await f.close();
  }
}, 240_000);

test('a moved source withholds the selected page and permits the same request after recovery', async () => {
  const f = await createReviewLifecycleFixture();
  const observer = observeSql(f.system.database.pool);
  const path = reviewPath(f.author.accountId);
  let gate: ReturnType<typeof observer.hold> | undefined;
  let previous: { write_state: string; moved_to: string | null } | undefined;
  let sourcePartition: number | undefined;
  try {
    await setAuthorViews(f, { posts: true, reviews: true });
    const review = await createContextReview(f);
    sourcePartition = partitionOf(routeOf(review.threadId)!);
    gate = observer.hold({ statement: views.sql, occurrence: 2 }, 'after');
    const pending = f.call('GET', path);
    await gate.entered;
    previous = (
      await f.admin.query<{ write_state: string; moved_to: string | null }>(
        'SELECT write_state,moved_to FROM core.partition WHERE partition_no=$1',
        [sourcePartition],
      )
    ).rows[0];
    await f.admin.query(
      "UPDATE core.partition SET write_state='moved',moved_to='author-context-test' WHERE partition_no=$1",
      [sourcePartition],
    );
    gate.release();
    const moved = await pending;
    expect(moved.response.status).toBe(503);
  } finally {
    gate?.release();
    if (previous && sourcePartition !== undefined)
      await f.admin.query('UPDATE core.partition SET write_state=$2,moved_to=$3 WHERE partition_no=$1', [
        sourcePartition,
        previous.write_state,
        previous.moved_to,
      ]);
    await observer.close();
  }
  try {
    const retry = await f.call('GET', path);
    expect(retry.response.status).toBe(200);
    expect(retry.value.threads).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 240_000);
