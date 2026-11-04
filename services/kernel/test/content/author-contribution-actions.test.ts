import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { readAuthorContributionActions } from '../../src/content/author-contribution-actions.ts';
import { createReviewLifecycleFixture } from './review-native-lifecycle-fixture.ts';
import { observeSql } from './support/sql-observer.ts';
import views from '../../src/access/account-views-read.sql';
import { routeOf } from '../../src/route/route.ts';

test('one native author page admits a private exact cohort without changing its public document', async () => {
  const f = await createReviewLifecycleFixture();
  try {
    const created = await f.call('POST', '/v1/threads', {
      bearer: f.author.bearer,
      body: {
        kind: 'review',
        title: 'Selected contribution',
        body: fromPlainText('Public opening'),
        licence: 'CC0-1.0',
        boardId: f.boardId,
        subjectIds: [f.subjectId],
        visibility: 'published',
      },
    });
    expect(created.response.status, created.text).toBe(201);
    const page = await f.call('GET', `/v1/accounts/${f.author.accountId}/threads?kind=review`);
    expect(page.response.status, page.text).toBe(200);
    const selection = page.value.actionSelection;
    expect(selection.references).toHaveLength(1);
    expect(selection.references[0].id).toBe(created.value.thread.id);
    expect(page.text).not.toMatch(/viewerSelection|watching|operations/);
    const path = `/v1/accounts/${f.author.accountId}/contribution-actions`;
    const input = { view: 'reviews', cursor: null, ...selection };
    const anonymous = await f.call('POST', path, { body: input });
    expect(anonymous.response.status, anonymous.text).toBe(200);
    expect(anonymous.response.headers.get('cache-control')).toBe('private, no-store');
    expect(anonymous.value.viewer).toEqual({ kind: 'anonymous' });
    expect(anonymous.value.reactions.items.every((item: object) => !('viewerSelection' in item))).toBe(true);
    for (const bearer of [f.author.bearer, f.other.bearer]) {
      const result = await f.call('POST', path, { bearer, body: input });
      expect(result.response.status, result.text).toBe(200);
      expect(result.value.viewer.kind).toBe('account');
      expect(result.value.selected[0]).toMatchObject({ state: 'current', reference: selection.references[0] });
      expect(result.value.watch.items[0].threadId).toBe(created.value.thread.id);
    }
    for (const body of [
      { ...input, view: 'discussion' },
      { ...input, cursor: 'another-page' },
      { ...input, references: [...input.references, ...input.references] },
      { ...input, references: Array(21).fill(input.references[0]) },
      { ...input, references: [{ ...input.references[0], sourceRevisionId: f.subjectId }] },
    ]) {
      const result = await f.call('POST', path, { bearer: f.other.bearer, body });
      expect(result.response.status, result.text).toBe(400);
    }
    const wrongAuthor = await f.call('POST', `/v1/accounts/${f.other.accountId}/contribution-actions`, {
      bearer: f.other.bearer,
      body: input,
    });
    expect(wrongAuthor.response.status, wrongAuthor.text).toBe(404);
    await f.admin.query('UPDATE access.account SET public_views=$3::jsonb WHERE route=$1 AND account_id=$2', [
      routeOf(f.author.accountId),
      f.author.accountId,
      JSON.stringify({ posts: false, reviews: false }),
    ]);
    const hidden = await f.call('POST', path, { bearer: f.author.bearer, body: input });
    expect(hidden.response.status, hidden.text).toBe(404);
  } finally {
    await f.close();
  }
}, 240_000);

test('publication withdrawal during private assembly retires all advice', async () => {
  const f = await createReviewLifecycleFixture();
  const observer = observeSql(f.system.database.pool);
  try {
    const created = await f.call('POST', '/v1/threads', {
      bearer: f.author.bearer,
      body: {
        kind: 'review',
        title: 'Withdrawal',
        body: fromPlainText('Opening'),
        licence: 'CC0-1.0',
        boardId: f.boardId,
        subjectIds: [f.subjectId],
        visibility: 'published',
      },
    });
    expect(created.response.status, created.text).toBe(201);
    const page = await f.call('GET', `/v1/accounts/${f.author.accountId}/threads?kind=review`);
    const gate = observer.hold({ statement: views.sql }, 'after');
    const pending = readAuthorContributionActions(
      {
        pool: f.system.database.pool,
        access: f.system.access,
        tokens: f.system.tokenKeys,
        routeKey: new Uint8Array(32).fill(7),
      },
      f.author.accountId,
      { view: 'reviews', cursor: null, ...page.value.actionSelection },
      f.system.actors.other.actor,
      new Request('http://kernel.local/v1/accounts/actions', {
        headers: { authorization: `Bearer ${f.other.bearer}` },
      }),
      Date.now() + 120_000,
    );
    // Observe the rejection immediately, including while the SQL gate is held.
    const outcome = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await gate.entered;
    await f.admin.query('UPDATE access.account SET public_views=$3::jsonb WHERE route=$1 AND account_id=$2', [
      routeOf(f.author.accountId),
      f.author.accountId,
      JSON.stringify({ posts: false, reviews: false }),
    ]);
    gate.release();
    expect(await outcome).toMatchObject({ code: 'dependency_unavailable' });
  } finally {
    await observer.close();
    await f.close();
  }
}, 240_000);
