import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId, partitionOf } from '../../src/route/route.ts';
import type { DurableInitiatorRecord } from '../../src/access/durable-initiator.ts';
import {
  applyCollectionBulkTarget,
  collectCollectionBulkTargets,
  confirmCollectionBulk,
  pageCollectionBulkManifest,
  previewCollectionBulk,
  readCollectionBulk,
  type CollectionBulkTarget,
} from '../../src/library/collection-bulk-store.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});
const route = 0x6c59,
  now = '2026-11-03T12:00:00Z';
const target = (): CollectionBulkTarget => ({
  kind: 'subject',
  subjectId: newId(route),
  requestedSubjectId: null,
  expected: { kind: 'present', incarnation: newId(route), admissionSequence: '1', revision: 1 },
});
const preview = (targets: CollectionBulkTarget[]) => {
  const accountId = newId(route);
  return {
    route,
    accountId,
    operationId: newId(route),
    now,
    transactionId: newId(route),
    targets,
    request: {
      action: 'set_status' as const,
      state: 'completed' as const,
      selection: { kind: 'query' as const, filter: { state: 'planned' as const } },
    },
    // This test exercises the internal storage seam, not initiator capture or authorization.
    initiator: {} as DurableInitiatorRecord,
    creationReceipt: {
      partition: partitionOf(route),
      principalKind: 'account' as const,
      principalId: accountId,
      commandKind: 'library.collectionBulk.preview',
      key: newId(route),
      digest: 'a'.repeat(64),
    },
  };
};

test('confirmation and recovery use the persisted preview, skip a changed entry and commit each effect once', async () => {
  const tx = await db.admin.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(
      'CREATE TEMP TABLE bulk_test_effect (subject_id uuid PRIMARY KEY, revision integer, effects integer) ON COMMIT DROP',
    );
    const input = preview([target(), target(), target()]);
    await previewCollectionBulk(tx, input);
    for (let ordinal = 0; ordinal < 3; ordinal++)
      await tx.query('INSERT INTO bulk_test_effect VALUES ($1,$2,0)', [
        input.targets[ordinal]!.subjectId,
        ordinal === 1 ? 2 : 1,
      ]);
    expect(await confirmCollectionBulk(tx, input)).toBe(true);
    expect(await confirmCollectionBulk(tx, input)).toBe(false);
    // A new source match does not enter the captured manifest; an existing changed target stays inspectable.
    const before = await pageCollectionBulkManifest(tx, input);
    expect(before.map((row) => row.target.subjectId)).toEqual(input.targets.map((row) => row.subjectId));
    for (let ordinal = 0; ordinal < 3; ordinal++) {
      await applyCollectionBulkTarget(tx, { ...input, ordinal }, async (native, operation, row) => {
        expect(operation.request.action).toBe('set_status');
        if (row.target.kind !== 'subject' || row.target.expected.kind !== 'present')
          throw new Error('Expected an entry');
        const changed = await native.query(
          'UPDATE bulk_test_effect SET effects=effects+1 WHERE subject_id=$1 AND revision=$2 RETURNING true',
          [row.target.subjectId, row.target.expected.revision],
        );
        if (!changed.rowCount) return { state: 'conflict', reason: 'revision_mismatch' };
        return { state: 'applied', reason: null, resultingMemberId: newId(route) };
      });
    }
    const recovered = await pageCollectionBulkManifest(tx, input);
    expect(recovered.map((row) => [row.state, row.reason])).toEqual([
      ['applied', null],
      ['conflict', 'revision_mismatch'],
      ['applied', null],
    ]);
    expect((await readCollectionBulk(tx, input))?.phase).toBe('completed');
    for (let ordinal = 0; ordinal < 3; ordinal++) {
      const row = recovered[ordinal]!;
      if (row.state === 'pending') throw new Error('Expected a terminal result');
      expect(
        await applyCollectionBulkTarget(tx, { ...input, ordinal }, async () => {
          throw new Error('A completed effect was repeated');
        }),
      ).toEqual({ state: row.state, reason: row.reason, resultingMemberId: row.resultingMemberId });
    }
    expect((await tx.query('SELECT sum(effects)::integer AS n FROM bulk_test_effect')).rows[0].n).toBe(2);
    expect(await readCollectionBulk(tx, { ...input, accountId: newId(route) })).toBeNull();
    expect(await pageCollectionBulkManifest(tx, { ...input, accountId: newId(route) })).toEqual([]);
    expect((await previewCollectionBulk(tx, input)).phase).toBe('completed');
    await tx.query('COMMIT');
    expect((await readCollectionBulk(db.admin, input))?.phase).toBe('completed');
    expect(
      (
        await applyCollectionBulkTarget(db.admin, { ...input, ordinal: 0 }, async () => {
          throw new Error('A committed effect was repeated after navigation');
        })
      )?.state,
    ).toBe('applied');
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
});

test('exactly 1,000 targets preview; larger selections refuse before writing; unconfirmed targets cannot execute', async () => {
  const tx = await db.admin.connect();
  try {
    await tx.query('BEGIN');
    const targets = Array.from({ length: 1000 }, target),
      input = preview(targets);
    const captured = await collectCollectionBulkTargets(async (after, limit) => {
      const start = Number(after ?? 0),
        end = Math.min(start + limit, targets.length);
      return { targets: targets.slice(start, end), next: end === targets.length ? null : String(end) };
    });
    expect((await previewCollectionBulk(tx, { ...input, targets: captured })).targetCount).toBe(1000);
    expect(
      await applyCollectionBulkTarget(tx, { ...input, ordinal: 0 }, async () => {
        throw new Error('Unconfirmed effect');
      }),
    ).toBeNull();
    const large = preview([...targets, target()]);
    await expect(previewCollectionBulk(tx, large)).rejects.toThrow('Narrow the selection');
    expect(await readCollectionBulk(tx, large)).toBeNull();
    await expect(
      collectCollectionBulkTargets(async (after, limit) => {
        const start = Number(after ?? 0),
          end = Math.min(start + limit, large.targets.length);
        return { targets: large.targets.slice(start, end), next: end === large.targets.length ? null : String(end) };
      }),
    ).rejects.toThrow('Narrow the selection');
    await expect(collectCollectionBulkTargets(async () => ({ targets: [], next: 'stuck' }))).rejects.toThrow(
      'bounded progress',
    );
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
});

test('explicit subjects and duplicate-subject occurrences retain their exact identities; empty previews complete', async () => {
  const tx = await db.admin.connect();
  try {
    await tx.query('BEGIN');
    const subject = target(),
      input = preview([subject]);
    await previewCollectionBulk(tx, {
      ...input,
      request: {
        action: 'set_status',
        state: 'completed',
        selection: { kind: 'explicit', targets: [{ subjectId: subject.subjectId }] },
      },
    });
    expect((await readCollectionBulk(tx, input))?.request.selection).toEqual({ kind: 'explicit' });
    const collectionId = newId(route),
      memberIds = [newId(route), newId(route)];
    const occurrences = preview([]);
    await previewCollectionBulk(tx, {
      ...occurrences,
      request: { action: 'remove_from_collection', collectionId, selection: { kind: 'occurrences', memberIds } },
      targets: memberIds.map((memberId) => ({
        kind: 'occurrence',
        subjectId: subject.subjectId,
        collectionId,
        memberId,
        incarnation: newId(route),
        admissionSequence: '1',
        revision: 1,
      })),
    });
    expect((await pageCollectionBulkManifest(tx, occurrences)).map((row) => row.target.subjectId)).toEqual([
      subject.subjectId,
      subject.subjectId,
    ]);
    expect(
      (await pageCollectionBulkManifest(tx, occurrences)).map((row) =>
        row.target.kind === 'occurrence' ? row.target.memberId : null,
      ),
    ).toEqual(memberIds);
    const empty = preview([]);
    await previewCollectionBulk(tx, empty);
    expect(await confirmCollectionBulk(tx, empty)).toBe(true);
    expect((await readCollectionBulk(tx, empty))?.phase).toBe('completed');
    const duplicate = preview([subject, subject]);
    await expect(previewCollectionBulk(tx, duplicate)).rejects.toThrow('Duplicate manifest target');
    expect(await readCollectionBulk(tx, duplicate)).toBeNull();
    const expired = preview([target()]);
    await previewCollectionBulk(tx, expired);
    expect(await confirmCollectionBulk(tx, { ...expired, now: '2026-11-05T12:00:00Z' })).toBe(false);
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
});
