import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  CLEANUP_CHILD_BUDGET,
  COMMAND_JSON_CAP,
  createCopyArchiveProgressGrowthFixture,
  entryKey,
  expectNoGrownScans,
  type CopyArchiveProgressGrowthFixture,
} from './support/copy-archive-progress-growth-fixture.ts';

const reviewPool = 48;
let f: CopyArchiveProgressGrowthFixture;
const applied: { reviewId: string; sessionId: string }[] = [];

beforeAll(async () => {
  f = await createCopyArchiveProgressGrowthFixture();
  await f.uploadFor(f.applyOwner);
  f.applyOwner.reviews = await f.addReviews(f.applyOwner, reviewPool);
  await f.uploadFor(f.rejectOwner);
  f.rejectOwner.reviews = await f.addReviews(f.rejectOwner, reviewPool);
  for (const person of Object.values(f.cleanupOwners)) await f.uploadFor(person);
}, 360_000);

afterAll(async () => {
  await f?.close();
});

test('scalar apply stays constant at Native64/512/4096 unrelated same-owner Session/unit/History rows', async () => {
  const reviews = [...f.applyOwner.reviews];
  const report = await f.measure('archive progress scalar apply', f.applyOwner, 'aa000001', async (actor) => {
    const reviewId = reviews.shift();
    if (!reviewId || !f.applyOwner.uploadId) throw new Error('Apply review pool exhausted');
    const result = await f.service.applyProgress(actor, f.applyOwner.uploadId, reviewId, entryKey());
    expect(result).toMatchObject({ state: 'applied', acceptedSteps: 10, totalSteps: 10 });
    if (!result.sessionId) throw new Error('Apply omitted the native Session');
    applied.push({ reviewId, sessionId: result.sessionId });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(COMMAND_JSON_CAP);
    return result;
  });
  expectNoGrownScans(report);
}, 600_000);

test('lost-ack retry reloads bounded operands and replays the original receipt at Native64/512/4096', async () => {
  const reviews = f.applyOwner.reviews;
  let current: { reviewId: string; key: string } | undefined;
  const report = await f.measure(
    'archive progress lost-ack retry',
    f.applyOwner,
    'aa000002',
    async (actor) => {
      if (!current || !f.applyOwner.uploadId) throw new Error('Retry prepare did not bind a review');
      const result = await f.service.applyProgress(actor, f.applyOwner.uploadId, current.reviewId, current.key);
      expect(result).toMatchObject({ state: 'applied', acceptedSteps: 10, totalSteps: 10 });
      return result;
    },
    {
      async prepare(actor) {
        const reviewId = reviews.shift();
        if (!reviewId || !f.applyOwner.uploadId) throw new Error('Retry review pool exhausted');
        const key = entryKey();
        current = { reviewId, key };
        const abort = new AbortController();
        await expect(
          f.service.applyProgress(actor, f.applyOwner.uploadId, reviewId, key, abort.signal, () => abort.abort()),
        ).rejects.toThrow();
        const pending = await f.db.admin.query<{ bytes: number }>(
          `SELECT octet_length(active_command::text)::int AS bytes FROM library.copy_archive_progress_apply
           WHERE account_id=$1 AND upload_id=$2 AND review_id=$3`,
          [actor.accountId, f.applyOwner.uploadId, reviewId],
        );
        expect(pending.rows[0]?.bytes ?? 0).toBeLessThanOrEqual(COMMAND_JSON_CAP);
      },
    },
  );
  expectNoGrownScans(report);
}, 600_000);

test('progressResult readback is measured apart from apply and stays bounded at Native64/512/4096', async () => {
  const target = applied[0];
  if (!target || !f.applyOwner.uploadId) throw new Error('Apply did not leave a Session to read back');
  const report = await f.measure('archive progress result readback', f.applyOwner, 'aa000003', async (actor) => {
    const result = await f.service.progressResult(actor, f.applyOwner.uploadId!, target.reviewId);
    expect(result.application).toMatchObject({ state: 'applied', sessionId: target.sessionId, acceptedSteps: 10 });
    expect(result.progressSession).toMatchObject({ id: target.sessionId, state: 'completed' });
    expect(result.completedEpisodes).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(32 * 1024);
    return result;
  });
  expectNoGrownScans(report);
}, 600_000);

test('native rejection records stale after rollback at Native64/512/4096', async () => {
  await f.activate(f.staleDigest);
  const reviews = [...f.rejectOwner.reviews];
  try {
    const report = await f.measure('archive progress native rejection', f.rejectOwner, 'aa000004', async (actor) => {
      const reviewId = reviews.shift();
      if (!reviewId || !f.rejectOwner.uploadId) throw new Error('Rejection review pool exhausted');
      const result = await f.service.applyProgress(actor, f.rejectOwner.uploadId, reviewId, entryKey());
      expect(result).toMatchObject({ state: 'stale', acceptedSteps: 0, sessionId: null });
      return result;
    });
    expectNoGrownScans(report);
  } finally {
    await f.activate(f.goodDigest);
  }
}, 600_000);

async function cleanupPerson(person: CopyArchiveProgressGrowthFixture['applyOwner']) {
  await f.renew(person);
  await f.finishRemoval(person);
  await f.uploadFor(person);
  return person;
}

test('owner-remove all-application page deletes 100 children and retains known remainder at Native64/512/4096', async () => {
  const person = f.cleanupOwners.applications;
  let retained: string[] = [];
  const report = await f.measure(
    'archive progress cleanup all-application page',
    person,
    'aa000005',
    async (actor) => {
      if (!person.uploadId) throw new Error('Cleanup upload missing');
      const before = await f.knownApplyBytes(actor.accountId, person.uploadId, retained);
      const page = await f.service.remove(actor, person.uploadId);
      expect(page.removed).toBe(CLEANUP_CHILD_BUDGET);
      expect(page.complete).toBe(false);
      const after = await f.knownApplyBytes(actor.accountId, person.uploadId, retained);
      expect(after.ids).toEqual(retained);
      expect(after.bytes).toBe(before.bytes);
      expect(after.bytes).toBeLessThanOrEqual(CLEANUP_CHILD_BUDGET * COMMAND_JSON_CAP);
      return page;
    },
    {
      async prepare(actor) {
        await cleanupPerson(person);
        const seeded = await f.seedChildren(
          { actor, uploadId: person.uploadId! },
          { apply: CLEANUP_CHILD_BUDGET + 20, commandBytes: 8000 },
        );
        const removedIds = seeded.applyIds.slice(0, CLEANUP_CHILD_BUDGET);
        retained = seeded.applyIds.slice(CLEANUP_CHILD_BUDGET);
        const doomed = await f.knownApplyBytes(actor.accountId, person.uploadId!, removedIds);
        expect(doomed.ids).toHaveLength(CLEANUP_CHILD_BUDGET);
        expect(doomed.bytes).toBeGreaterThan(0);
        expect(doomed.bytes).toBeLessThanOrEqual(CLEANUP_CHILD_BUDGET * COMMAND_JSON_CAP);
      },
    },
  );
  expectNoGrownScans(report);
}, 600_000);

test('owner-remove page shares the 100-child budget across tables at Native64/512/4096', async () => {
  const person = f.cleanupOwners.crossing;
  let remainingApply: string[] = [];
  const report = await f.measure(
    'archive progress cleanup crossing child tables',
    person,
    'aa000006',
    async (actor) => {
      const page = await f.service.remove(actor, person.uploadId!);
      expect(page.removed).toBe(CLEANUP_CHILD_BUDGET);
      expect(page.complete).toBe(false);
      const leftover = await f.knownApplyBytes(actor.accountId, person.uploadId!, remainingApply);
      expect(leftover.ids).toEqual([]);
      return page;
    },
    {
      async prepare(actor) {
        await cleanupPerson(person);
        const seeded = await f.seedChildren(
          { actor, uploadId: person.uploadId! },
          { apply: 40, extraReviews: 40, extraRows: 40, commandBytes: 8000 },
        );
        remainingApply = seeded.applyIds;
      },
    },
  );
  expectNoGrownScans(report);
}, 600_000);

test('exhausted final owner-remove page deletes remaining children plus the root at Native64/512/4096', async () => {
  const person = f.cleanupOwners.finalPage;
  const report = await f.measure(
    'archive progress cleanup exhausted final page',
    person,
    'aa000007',
    async (actor) => {
      const page = await f.service.remove(actor, person.uploadId!);
      expect(page.complete).toBe(true);
      expect(page.removed).toBeGreaterThan(0);
      expect(page.removed).toBeLessThanOrEqual(CLEANUP_CHILD_BUDGET);
      const root = await f.db.admin.query(
        `SELECT 1 FROM library.copy_archive_upload WHERE account_id=$1 AND upload_id=$2`,
        [actor.accountId, person.uploadId],
      );
      expect(root.rowCount).toBe(0);
      delete person.uploadId;
      return page;
    },
    {
      async prepare(actor) {
        await cleanupPerson(person);
        await f.seedChildren({ actor, uploadId: person.uploadId! }, { apply: 8, extraRows: 4 });
      },
    },
  );
  expectNoGrownScans(report);
}, 600_000);

test('expired owner-remove continues through the shared child budget until the root at Native64/512/4096', async () => {
  const person = f.cleanupOwners.continuation;
  const report = await f.measure(
    'archive progress cleanup repeated continuation',
    person,
    'aa000008',
    async (actor) => {
      const first = await f.service.remove(actor, person.uploadId!);
      expect(first.complete).toBe(false);
      expect(first.removed).toBe(CLEANUP_CHILD_BUDGET);
      const second = await f.service.remove(actor, person.uploadId!);
      expect(second.complete).toBe(true);
      expect(second.removed).toBeGreaterThan(0);
      expect(second.removed).toBeLessThanOrEqual(CLEANUP_CHILD_BUDGET);
      delete person.uploadId;
      return { first, second };
    },
    {
      async prepare(actor) {
        await cleanupPerson(person);
        await f.seedChildren({ actor, uploadId: person.uploadId! }, { apply: 40, extraReviews: 20, extraRows: 10 });
        f.setNow(f.now() + 7 * 86_400_000);
      },
    },
  );
  expectNoGrownScans(report);
}, 600_000);
