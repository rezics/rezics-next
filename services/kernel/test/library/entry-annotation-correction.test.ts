import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { newId, routeOf } from '../../src/route/route.ts';

let f: NativeProfileFixture;
const json = async (response: Response, status: number) => {
  expect(response.status).toBe(status);
  return response.json() as Promise<any>;
};
const path = (subjectId: string) => `/v1/libraryEntries/${subjectId}`;

async function entry(label: string) {
  const subjectId = await f.createSubject('game', label);
  const saved = await f.commands.putEntry(f.owner.actor, subjectId, { state: 'planned' }, entryKey());
  if (!saved.value.entry.incarnationId) throw new Error('Expected an incarnated entry');
  return { subjectId, ...saved.value.entry, incarnationId: saved.value.entry.incarnationId };
}

async function personal(subjectId: string) {
  return (await json(await f.send('owner', 'GET', `${path(subjectId)}/personal`), 200)).personalEntry;
}

async function annotate(subjectId: string, note: { op: string; value?: string }, priority: { op: string; value?: number }) {
  const current = await personal(subjectId);
  return json(
    await f.send('owner', 'PUT', `${path(subjectId)}/annotations`, {
      revision: current.annotationRevision,
      note,
      priority,
    }),
    200,
  );
}

async function createReview(items: unknown[]) {
  const response = await f.send('owner', 'POST', '/v1/libraryEntryAnnotationCorrections', { items });
  const body = await json(response, 201);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  return body.review;
}

function selected(entry: Awaited<ReturnType<typeof entry>>, note: unknown, priority: unknown) {
  return {
    subjectId: entry.subjectId,
    incarnationId: entry.incarnationId,
    currentRevision: entry.revision,
    note,
    priority,
  };
}

async function page(reviewId: string, pageNumber = 0, as: 'owner' | 'other' = 'owner') {
  const response = await f.send(as, 'GET', `/v1/libraryEntryAnnotationCorrections/${reviewId}?page=${pageNumber}`);
  const body = await json(response, 200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  return body.review;
}

async function confirm(reviewId: string, epoch: string, position: number, status = 200) {
  const response = await f.send('owner', 'POST', `/v1/libraryEntryAnnotationCorrections/${reviewId}/confirm`, {
    epoch,
    position,
  });
  const body = await json(response, status);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  return body.review;
}

beforeAll(async () => {
  f = await createProfileEntryFixture({ projectLinks: false });
}, 360_000);
afterAll(async () => f?.close());

test('reviews only the fixed selection, preserves and clears independently, and replays one accepted native item', async () => {
  const priority = await entry('correction priority');
  const preserve = await entry('correction preserve');
  const concurrent = await entry('correction concurrent');
  const unselected = await entry('correction unselected');
  for (const [item, note] of [[priority, 'old priority'], [preserve, 'keep this'], [concurrent, 'old concurrent'], [unselected, 'untouched']] as const)
    await annotate(item.subjectId, { op: 'set', value: note }, { op: 'set', value: 7 });
  const review = await createReview([
    selected(priority, { op: 'clear' }, { op: 'set', value: 3 }),
    selected(preserve, { op: 'preserve' }, { op: 'preserve' }),
    selected(concurrent, { op: 'set', value: 'reviewed note' }, { op: 'preserve' }),
  ]);
  expect(review.items.map((item: any) => item.current.note)).toEqual(['old priority', 'keep this', 'old concurrent']);
  const forbidden = await f.send('other', 'GET', `/v1/libraryEntryAnnotationCorrections/${review.reviewId}`);
  expect(forbidden.status).toBe(404);
  expect(await forbidden.text()).not.toContain('reviewed note');

  await annotate(concurrent.subjectId, { op: 'set', value: 'concurrent edit' }, { op: 'unchanged' });
  const ownerRoute = routeOf(f.owner.actor.accountId)!;
  const source = async () =>
    Number((await f.pool.query('SELECT generation FROM library.fact_source_head WHERE route=$1 AND account_id=$2', [ownerRoute, f.owner.actor.accountId])).rows[0]?.generation ?? 0);
  const before = await source();
  expect((await confirm(review.reviewId, review.epoch, 0)).items[0].outcome).toBe('accepted');
  const accepted = await personal(priority.subjectId);
  const fenced = await source();
  expect(accepted).toMatchObject({ annotationRevision: 2, note: null, priority: 3 });
  expect(fenced).toBe(before + 1);
  expect((await confirm(review.reviewId, review.epoch, 0)).items[0].outcome).toBe('accepted');
  expect((await personal(priority.subjectId)).annotationRevision).toBe(accepted.annotationRevision);
  expect(await source()).toBe(fenced);
  expect((await confirm(review.reviewId, review.epoch, 1)).items[1].outcome).toBe('unchanged');
  expect((await confirm(review.reviewId, review.epoch, 2)).items[2].outcome).toBe('stale');
  const reopened = await page(review.reviewId);
  expect(reopened.items.map((item: any) => item.outcome)).toEqual(['accepted', 'unchanged', 'stale']);
  expect(reopened.items.map((item: any) => item.current?.note)).toEqual([null, 'keep this', 'concurrent edit']);
  expect(await personal(unselected.subjectId)).toMatchObject({ note: 'untouched', priority: 7 });
});

test('admits a maximum note and fixed sixteen-item first, deep and final pages', async () => {
  const entries = [];
  for (let index = 0; index < 16; index++) entries.push(await entry(`page ${index}`));
  const review = await createReview(
    entries.map((item) => selected(item, { op: 'preserve' }, { op: 'preserve' })),
  );
  expect(review).toMatchObject({ total: 16, page: 0, pageCount: 4, nextPage: 1 });
  expect((await page(review.reviewId, 0)).items).toHaveLength(4);
  expect((await page(review.reviewId, 2)).nextPage).toBe(3);
  expect((await page(review.reviewId, 3)).nextPage).toBeNull();

  const maxNote = await entry('maximum note');
  const maximum = 'm'.repeat(4096);
  const noteReview = await createReview([selected(maxNote, { op: 'set', value: maximum }, { op: 'preserve' })]);
  expect((await confirm(noteReview.reviewId, noteReview.epoch, 0)).items[0].outcome).toBe('accepted');
  expect((await personal(maxNote.subjectId)).note).toBe(maximum);
  const changed = await createReview([selected(maxNote, { op: 'set', value: 'new operand' }, { op: 'preserve' })]);
  expect((await confirm(changed.reviewId, changed.epoch, 0)).items[0].outcome).toBe('accepted');
  expect((await personal(maxNote.subjectId)).note).toBe('new operand');
});

test('does not create absent entries, rejects deleted incarnations, cancels pending work and expires reviews', async () => {
  const missingSubject = await f.createSubject('game', 'no entry');
  const missing = await createReview([
    {
      subjectId: missingSubject,
      incarnationId: newId(routeOf(missingSubject)!),
      currentRevision: 1,
      note: { op: 'set', value: 'must not create' },
      priority: { op: 'preserve' },
    },
  ]);
  expect(missing.items[0]).toMatchObject({ eligibility: 'unavailable', outcome: 'unavailable', current: null });
  expect((await confirm(missing.reviewId, missing.epoch, 0)).items[0].outcome).toBe('unavailable');
  expect((await f.send('owner', 'GET', path(missingSubject))).status).toBe(404);

  const recreated = await entry('recreated entry');
  const old = await createReview([selected(recreated, { op: 'set', value: 'old incarnation' }, { op: 'preserve' })]);
  const removed = await f.send(
    'owner',
    'DELETE',
    `${path(recreated.subjectId)}?revision=${recreated.revision}&incarnationId=${recreated.incarnationId}`,
  );
  expect(removed.status).toBe(204);
  const replacement = await f.commands.putEntry(f.owner.actor, recreated.subjectId, { state: 'planned' }, entryKey());
  expect(replacement.value.entry.incarnationId).not.toBe(recreated.incarnationId);
  expect((await page(old.reviewId)).items[0]).toMatchObject({ eligibility: 'stale', current: null, operation: null });
  expect((await confirm(old.reviewId, old.epoch, 0)).items[0].outcome).toBe('stale');
  expect((await personal(recreated.subjectId)).note).toBeNull();

  const revised = await entry('revision guarded entry');
  const revisionReview = await createReview([selected(revised, { op: 'set', value: 'stale entry edit' }, { op: 'preserve' })]);
  await f.commands.putEntry(
    f.owner.actor,
    revised.subjectId,
    { state: 'paused', revision: revised.revision, incarnationId: revised.incarnationId },
    entryKey(),
  );
  expect((await confirm(revisionReview.reviewId, revisionReview.epoch, 0)).items[0].outcome).toBe('stale');
  expect((await personal(revised.subjectId)).note).toBeNull();

  const first = await entry('cancel first');
  const second = await entry('cancel second');
  const cancelled = await createReview([
    selected(first, { op: 'set', value: 'accepted before cancel' }, { op: 'preserve' }),
    selected(second, { op: 'set', value: 'never started' }, { op: 'preserve' }),
  ]);
  expect((await confirm(cancelled.reviewId, cancelled.epoch, 0)).items[0].outcome).toBe('accepted');
  const cancelResponse = await f.send('owner', 'POST', `/v1/libraryEntryAnnotationCorrections/${cancelled.reviewId}/cancel`, {
    epoch: cancelled.epoch,
  });
  expect(await json(cancelResponse, 200)).toMatchObject({ state: 'cancelled' });
  expect((await confirm(cancelled.reviewId, cancelled.epoch, 1)).items[1].outcome).toBe('not-started');
  expect((await personal(first.subjectId)).note).toBe('accepted before cancel');
  expect((await personal(second.subjectId)).note).toBeNull();

  const expired = await createReview([selected(second, { op: 'set', value: 'private expired note' }, { op: 'preserve' })]);
  await f.pool.query(
    `UPDATE library.entry_annotation_review SET created_at=created_at-interval '16 minutes',
       expires_at=expires_at-interval '16 minutes', purge_after=purge_after-interval '16 minutes'
     WHERE route=$1 AND account_id=$2 AND review_id=$3`,
    [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, expired.reviewId],
  );
  expect((await page(expired.reviewId)).state).toBe('expired');
  const expiredConfirm = await f.send('owner', 'POST', `/v1/libraryEntryAnnotationCorrections/${expired.reviewId}/confirm`, {
    epoch: expired.epoch,
    position: 0,
  });
  expect(expiredConfirm.status).toBe(409);
  expect(await expiredConfirm.text()).not.toContain('private expired note');
  expect((await personal(second.subjectId)).note).toBeNull();
});
