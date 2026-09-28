import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { InvalidLibraryStatus, LibraryStatusConflict, ReaderLibraryStatusStore,
  StaleLibraryStatus } from '../../../services/main/src/modules/library/status.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;

test('G414: yearly goal counts dated finishes and preserves idempotent, concurrent edits', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the integration tier');
  const stack = await startMediaStack('library-goal');
  try {
    const status = new ReaderLibraryStatusStore(stack.contentPool);
    const agent = id();
    const noteWork = id();
    const privateReview = { agent, work: noteWork, text: 'A private imported review', language: 'en',
      spoiler: false, expectedVersion: 0, idempotencyKey: randomUUID() };
    const savedNote = await status.putPrivateReview(privateReview);
    expect(savedNote).toMatchObject({ text: privateReview.text, version: 1, replayed: false });
    expect(await status.putPrivateReview(privateReview)).toEqual({ ...savedNote, replayed: true });
    expect(await status.privateReviews(agent, [noteWork])).toMatchObject([{ text: privateReview.text }]);
    expect(await status.privateReviews(id(), [noteWork])).toEqual([]);
    await expect(status.putPrivateReview({ ...privateReview, text: 'Different' }))
      .rejects.toBeInstanceOf(LibraryStatusConflict);
    await expect(status.putPrivateReview({ ...privateReview, idempotencyKey: randomUUID() }))
      .rejects.toBeInstanceOf(StaleLibraryStatus);
    const goal = await status.goal(agent, 2026);
    expect(goal).toEqual({ year: 2026, target: null, completed: 0, version: 0, changedAt: null });
    for (const finishedOn of ['2026-01-12', '2026-12-31', '2025-12-31', null]) {
      await status.write({ agent, work: id(), status: 'read', startedOn: null, finishedOn,
        expectedVersion: 0, idempotencyKey: randomUUID() });
    }
    expect((await status.goal(agent, 2026)).completed).toBe(2);
    const reader = await stack.member('reading-stats');
    const structure = id(), january = id(), december = id();
    for (const [occurrence, completedAt, first] of [[january, '2026-01-08', true],
      [january, '2026-02-08', false], [december, '2026-12-29', true]] as const) {
      await stack.contentPool.query(`INSERT INTO structure.progress_command
        (principal_issuer, principal_subject, idempotency_key, request_digest, structure, occurrence, selection_key,
          result_version, result_completed, first_finish, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,'',1,true,$7,$8)`, [reader.principal.issuer, reader.principal.subject,
        randomUUID(), 'a'.repeat(64), structure, occurrence, first, completedAt]);
    }
    const stats = await status.readingYear(agent, reader.principal, 2026);
    expect(stats).toMatchObject({ year: 2026, books: 2, chapters: 2 });
    expect(stats.months[0]).toEqual({ month: 1, books: 1, chapters: 1 });
    expect(stats.months[11]).toEqual({ month: 12, books: 1, chapters: 1 });
    const input = { agent, year: 2026, target: 24, expectedVersion: 0, idempotencyKey: randomUUID() };
    const first = await status.setGoal(input);
    expect(first).toMatchObject({ target: 24, completed: 2, version: 1, replayed: false });
    expect(await status.setGoal(input)).toEqual({ ...first, replayed: true });
    await expect(status.setGoal({ ...input, target: 12 })).rejects.toBeInstanceOf(LibraryStatusConflict);
    await expect(status.setGoal({ ...input, idempotencyKey: randomUUID() }))
      .rejects.toBeInstanceOf(StaleLibraryStatus);
    const concurrent = await Promise.allSettled([12, 36].map(target => status.setGoal({ ...input,
      target, expectedVersion: 1, idempotencyKey: randomUUID() })));
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((concurrent.find(result => result.status === 'rejected') as PromiseRejectedResult).reason)
      .toBeInstanceOf(StaleLibraryStatus);
    const cleared = await status.setGoal({ ...input, target: null, expectedVersion: 2,
      idempotencyKey: randomUUID() });
    expect(cleared).toMatchObject({ target: null, completed: 2, version: 3 });
    await expect(status.setGoal({ ...input, target: 0, expectedVersion: 3,
      idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(InvalidLibraryStatus);
  } finally { await stack.stop(); }
});
