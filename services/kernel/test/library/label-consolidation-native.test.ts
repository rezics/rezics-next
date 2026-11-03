import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { createLabelAssignmentCommands } from '../../src/library/label-assignment-commands.ts';
import { ownedQueries } from '../../src/library/erasure-owned-queries.ts';
import { purgeExpiredLabelConsolidations } from '../../src/library/label-consolidation.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

const catalogue = () => createPersonalLabelCommands({ pool: f.pool, tokens: f.tokens });
const assignments = () => createLabelAssignmentCommands({ pool: f.pool, tokens: f.tokens, access: f.access });
const label = async (name: string) => (await catalogue().createLabel(f.owner.actor, { name }, entryKey())).value.label;
const select = async (labelId: string, subjectId: string) => {
  const value = (await assignments().assignLabel(f.owner.actor, labelId, { subjectId }, entryKey())).value.assignment;
  return { subjectId, assignmentId: value.id, revision: value.revision };
};

async function review(source: { id: string }, target: { id: string }, items: Array<{ subjectId: string; assignmentId: string; revision: number }>) {
  const path = `/v1/libraryLabels/${source.id}:reviewConsolidation`;
  let cursor: string | null = null;
  let first: any;
  const reviewed: unknown[] = [];
  do {
    const response = await f.send('owner', 'POST', path, {
      targetLabelId: target.id,
      items,
      limit: 4,
      ...(cursor ? { cursor } : {}),
    });
    expect(response.status).toBe(200);
    const page = await response.json();
    first ??= page;
    reviewed.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return {
    selection: first.selection,
    sourceLabel: first.sourceLabel,
    targetLabel: first.targetLabel,
    items: reviewed,
  };
}

async function confirm(sourceId: string, evidence: unknown) {
  return f.send('owner', 'POST', `/v1/libraryLabels/${sourceId}:confirmConsolidation`, evidence);
}

async function readAssignments(labelId: string) {
  const response = await f.send('owner', 'GET', `/v1/libraryLabelAssignments?labelId=${labelId}`);
  expect(response.status).toBe(200);
  return (await response.json()).assignments as Array<{ id: string; labelId: string; subjectId: string; revision: number }>;
}

test('confirmed selected moves reopen through both native readers and preserve already-on-target identity', async () => {
  const source = await label('Move source ' + crypto.randomUUID()),
    target = await label('Move target ' + crypto.randomUUID()),
    first = await select(source.id, await f.createSubject('unprofiled')),
    secondSubject = await f.createSubject('unprofiled'),
    second = await select(source.id, secondSubject),
    existingTarget = await select(target.id, secondSubject),
    evidence = await review(source, target, [first, second]);
  expect(evidence.items.map((item: any) => item.outcome)).toEqual(['movable', 'already_on_target']);
  const confirmation = await confirm(source.id, evidence);
  expect(confirmation.status).toBe(201);
  const { confirmationId } = await confirmation.json();
  const path = `/v1/libraryLabels/${source.id}:applyConsolidation`;
  const firstApply = await f.send('owner', 'POST', path, { confirmationId });
  expect(firstApply.status).toBe(200);
  expect((await firstApply.json()).items[0]).toMatchObject({ item: 0, status: 'moved', targetUnchanged: false });
  const secondApply = await f.send('owner', 'POST', path, { confirmationId });
  expect(secondApply.status).toBe(200);
  expect((await secondApply.json()).items[1]).toMatchObject({
    item: 1,
    status: 'moved',
    targetAssignment: { id: existingTarget.assignmentId },
    targetUnchanged: true,
  });
  const result = await f.send('owner', 'GET', `/v1/libraryLabels/${source.id}/consolidations/${confirmationId}`);
  expect(result.status).toBe(200);
  expect((await result.json()).status).toBe('completed');
  expect(await readAssignments(source.id)).toEqual([]);
  const targetRows = await readAssignments(target.id);
  expect(targetRows).toHaveLength(2);
  expect(targetRows.map((row) => row.subjectId)).toContain(first.subjectId);
  expect(targetRows.find((row) => row.subjectId === secondSubject)?.id).toBe(existingTarget.assignmentId);
  const catalogueRows = await f.send('owner', 'GET', '/v1/libraryLabels');
  expect((await catalogueRows.json()).labels.map((row: { id: string }) => row.id)).toContain(source.id);
}, 120_000);

test('changed evidence, renamed or recreated parents, and changed Subject exposure stop before source removal', async () => {
  const staleSource = await label('Stale source ' + crypto.randomUUID()),
    staleTarget = await label('Stale target ' + crypto.randomUUID()),
    staleItem = await select(staleSource.id, await f.createSubject('unprofiled')),
    staleEvidence = await review(staleSource, staleTarget, [staleItem]);
  await assignments().unassignLabel(f.owner.actor, staleSource.id, staleItem, entryKey());
  await select(staleSource.id, staleItem.subjectId);
  expect((await confirm(staleSource.id, staleEvidence)).status).toBe(409);

  const renamedSource = await label('Rename source ' + crypto.randomUUID()),
    renamedTarget = await label('Rename target ' + crypto.randomUUID()),
    renamedItem = await select(renamedSource.id, await f.createSubject('unprofiled')),
    renamedEvidence = await review(renamedSource, renamedTarget, [renamedItem]),
    renamedConfirmation = await confirm(renamedSource.id, renamedEvidence);
  expect(renamedConfirmation.status).toBe(201);
  const renamedId = (await renamedConfirmation.json()).confirmationId;
  await catalogue().renameLabel(
    f.owner.actor,
    renamedTarget.id,
    { name: 'Renamed target ' + crypto.randomUUID(), revision: renamedTarget.revision },
    entryKey(),
  );
  const renamedApply = await f.send('owner', 'POST', `/v1/libraryLabels/${renamedSource.id}:applyConsolidation`, {
    confirmationId: renamedId,
  });
  expect((await renamedApply.json()).items[0].status).toBe('changed');
  expect((await readAssignments(renamedTarget.id)).map((row) => row.subjectId)).not.toContain(renamedItem.subjectId);

  const recreatedSourceName = 'Recreated source ' + crypto.randomUUID(),
    deletedSource = await label(recreatedSourceName),
    deletedTarget = await label('Recreate target ' + crypto.randomUUID()),
    deletedItem = await select(deletedSource.id, await f.createSubject('unprofiled')),
    deletedEvidence = await review(deletedSource, deletedTarget, [deletedItem]),
    deletedConfirmation = await confirm(deletedSource.id, deletedEvidence);
  expect(deletedConfirmation.status).toBe(201);
  const deletedId = (await deletedConfirmation.json()).confirmationId;
  await catalogue().deleteLabel(f.owner.actor, deletedSource.id, deletedSource.revision, entryKey());
  const recreated = await label(recreatedSourceName);
  expect(recreated.id).not.toBe(deletedSource.id);
  const deletedApply = await f.send('owner', 'POST', `/v1/libraryLabels/${deletedSource.id}:applyConsolidation`, {
    confirmationId: deletedId,
  });
  expect((await deletedApply.json()).items[0].status).toBe('changed');
  expect((await readAssignments(deletedTarget.id)).map((row) => row.subjectId)).not.toContain(deletedItem.subjectId);

  const hiddenSource = await label('Hidden source ' + crypto.randomUUID()),
    hiddenTarget = await label('Hidden target ' + crypto.randomUUID()),
    hiddenItem = await select(hiddenSource.id, await f.createSubject('unprofiled')),
    hiddenEvidence = await review(hiddenSource, hiddenTarget, [hiddenItem]),
    hiddenConfirmation = await confirm(hiddenSource.id, hiddenEvidence);
  expect(hiddenConfirmation.status).toBe(201);
  const hiddenId = (await hiddenConfirmation.json()).confirmationId;
  const hidden = await f.send('steward', 'POST', `/v1/subjects/${hiddenItem.subjectId}:hide`, {
    reason: 'Hide a subject after label confirmation',
  });
  expect(hidden.status).toBe(200);
  const hiddenApply = await f.send('owner', 'POST', `/v1/libraryLabels/${hiddenSource.id}:applyConsolidation`, {
    confirmationId: hiddenId,
  });
  expect((await hiddenApply.json()).items[0]).toMatchObject({ status: 'inaccessible' });
  expect(
    (await f.pool.query(
      `SELECT slot_no FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4`,
      [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, hiddenItem.subjectId, hiddenSource.id],
    )).rows[0]?.slot_no,
  ).not.toBeNull();
}, 120_000);

test('native assignment admission refuses full capacity and reclaims only a deleted-parent reservation', async () => {
  const source = await label('Full source ' + crypto.randomUUID()),
    target = await label('Full target ' + crypto.randomUUID()),
    fullSubject = await f.createSubject('unprofiled'),
    fullItem = await select(source.id, fullSubject),
    fullEvidence = await review(source, target, [fullItem]),
    fullConfirmation = await confirm(source.id, fullEvidence);
  expect(fullConfirmation.status).toBe(201);
  const fullId = (await fullConfirmation.json()).confirmationId;
  for (let n = 0; n < 31; n++) await select((await label(`Full reservation ${n} ${crypto.randomUUID()}`)).id, fullSubject);
  const refused = await f.send('owner', 'POST', `/v1/libraryLabels/${source.id}:applyConsolidation`, { confirmationId: fullId });
  expect((await refused.json()).items[0].status).toBe('capacity_limited');
  expect((await readAssignments(source.id)).map((row) => row.subjectId)).toContain(fullSubject);

  const reclaimSource = await label('Reclaim source ' + crypto.randomUUID()),
    reclaimTarget = await label('Reclaim target ' + crypto.randomUUID()),
    reclaimSubject = await f.createSubject('unprofiled'),
    reclaimItem = await select(reclaimSource.id, reclaimSubject);
  const liveParents = [];
  for (let n = 0; n < 30; n++) {
    const parent = await label(`Reclaim reservation ${n} ${crypto.randomUUID()}`);
    liveParents.push(parent);
    await select(parent.id, reclaimSubject);
  }
  const deletedParent = await label('Deleted reservation ' + crypto.randomUUID());
  await select(deletedParent.id, reclaimSubject);
  await catalogue().deleteLabel(f.owner.actor, deletedParent.id, deletedParent.revision, entryKey());
  const before = (
    await f.pool.query(
      `SELECT revision,deleted_at::text AS deleted_at,purge_after::text AS purge_after,slot_no
       FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4`,
      [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, reclaimSubject, deletedParent.id],
    )
  ).rows[0];
  const reclaimEvidence = await review(reclaimSource, reclaimTarget, [reclaimItem]);
  expect((reclaimEvidence.items[0] as any).outcome).toBe('movable');
  const reclaimConfirmation = await confirm(reclaimSource.id, reclaimEvidence);
  expect(reclaimConfirmation.status).toBe(201);
  const reclaimId = (await reclaimConfirmation.json()).confirmationId;
  const accepted = await f.send('owner', 'POST', `/v1/libraryLabels/${reclaimSource.id}:applyConsolidation`, {
    confirmationId: reclaimId,
  });
  expect((await accepted.json()).items[0].status).toBe('moved');
  const after = (
    await f.pool.query(
      `SELECT revision,deleted_at::text AS deleted_at,purge_after::text AS purge_after,slot_no
       FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4`,
      [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, reclaimSubject, deletedParent.id],
    )
  ).rows[0];
  expect(after).toMatchObject({ revision: before.revision + 1, deleted_at: before.deleted_at, purge_after: before.purge_after, slot_no: null });
  expect(liveParents).toHaveLength(30);
}, 120_000);

test('original target replay, cancellation, finite undo, owner erasure and expiry retain only bounded results', async () => {
  const source = await label('Replay source ' + crypto.randomUUID()),
    target = await label('Replay target ' + crypto.randomUUID()),
    first = await select(source.id, await f.createSubject('unprofiled')),
    second = await select(source.id, await f.createSubject('unprofiled')),
    evidence = await review(source, target, [first, second]),
    confirmed = await confirm(source.id, evidence);
  expect(confirmed.status).toBe(201);
  const confirmationId = (await confirmed.json()).confirmationId,
    route = routeOf(f.owner.actor.accountId)!;
  const item = (
    await f.pool.query(
      `SELECT target_request_key,source_request_key FROM library.label_consolidation_item
       WHERE route=$1 AND account_id=$2 AND consolidation_id=$3 AND item_no=0`,
      [route, f.owner.actor.accountId, confirmationId],
    )
  ).rows[0]!;
  await f.pool.query(
    `UPDATE library.label_consolidation_item SET status='applying',stage='target_started'
     WHERE route=$1 AND account_id=$2 AND consolidation_id=$3 AND item_no=0`,
    [route, f.owner.actor.accountId, confirmationId],
  );
  const originalTarget = await assignments().assignLabelForConsolidation(
    f.owner.actor,
    target.id,
    { subjectId: first.subjectId },
    target.revision,
    { labelId: source.id, assignmentId: first.assignmentId, revision: first.revision, labelRevision: source.revision },
    null,
    item.target_request_key,
  );
  const targetEventCount = async () =>
    Number(
      (
        await f.pool.query(
          `SELECT count(*)::int AS count FROM core.outbox WHERE type='com.rezics.library.label.changed.v1'
           AND subject=$1 AND data->>'labelId'=$2`,
          [f.owner.actor.accountId, target.id],
        )
      ).rows[0]!.count,
    );
  const eventCount = await targetEventCount();
  const retry = await f.send('owner', 'POST', `/v1/libraryLabels/${source.id}:retryConsolidation`, {
    confirmationId,
    item: 0,
  });
  expect(retry.status).toBe(200);
  const afterRetry = await retry.json();
  expect(afterRetry.items[0]).toMatchObject({
    status: 'moved',
    targetAssignment: { id: originalTarget.value.assignment.id },
    targetUnchanged: false,
  });
  expect(await targetEventCount()).toBe(eventCount);

  const cancelled = await f.send('owner', 'POST', `/v1/libraryLabels/${source.id}:cancelConsolidation`, { confirmationId });
  expect(cancelled.status).toBe(200);
  expect((await cancelled.json()).items.map((row: { status: string }) => row.status)).toEqual(['moved', 'pending']);
  const stopped = await f.send('owner', 'POST', `/v1/libraryLabels/${source.id}:applyConsolidation`, { confirmationId });
  expect([404, 409]).toContain(stopped.status);
  expect((await readAssignments(target.id)).map((row) => row.subjectId)).toContain(first.subjectId);
  expect((await readAssignments(target.id)).map((row) => row.subjectId)).not.toContain(second.subjectId);
  expect((await f.send('other', 'GET', `/v1/libraryLabels/${source.id}/consolidations/${confirmationId}`)).status).toBe(404);

  const sourceBefore = (
    await f.pool.query(
      `SELECT revision,purge_after::text AS purge_after FROM library.label_assignment
       WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4`,
      [route, f.owner.actor.accountId, first.subjectId, source.id],
    )
  ).rows[0]!;
  const replayedSource = await assignments().unassignLabelAtRevision(
    f.owner.actor,
    source.id,
    { subjectId: first.subjectId, assignmentId: first.assignmentId, revision: first.revision },
    source.revision,
    item.source_request_key,
  );
  expect(replayedSource.value.revision).toBe(sourceBefore.revision);
  const sourceAfterReplay = (
    await f.pool.query(
      `SELECT revision,purge_after::text AS purge_after FROM library.label_assignment
       WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4`,
      [route, f.owner.actor.accountId, first.subjectId, source.id],
    )
  ).rows[0]!;
  expect(sourceAfterReplay).toEqual(sourceBefore);
  const restored = await assignments().restoreAssignment(
    f.owner.actor,
    source.id,
    { subjectId: first.subjectId, assignmentId: first.assignmentId, revision: replayedSource.value.revision },
    entryKey(),
  );
  expect(restored.value.assignment).toMatchObject({ id: first.assignmentId, revision: replayedSource.value.revision + 1 });

  const guardedItem = await select(source.id, await f.createSubject('unprofiled')),
    guardedEvidence = await review(source, target, [guardedItem]),
    guardedConfirmation = await confirm(source.id, guardedEvidence),
    guardedId = (await guardedConfirmation.json()).confirmationId,
    guardedKeys = (
      await f.pool.query(
        `SELECT target_request_key FROM library.label_consolidation_item
         WHERE route=$1 AND account_id=$2 AND consolidation_id=$3 AND item_no=0`,
        [route, f.owner.actor.accountId, guardedId],
      )
    ).rows[0]!;
  await f.pool.query(
    `UPDATE library.label_consolidation_item SET status='applying',stage='target_started'
     WHERE route=$1 AND account_id=$2 AND consolidation_id=$3 AND item_no=0`,
    [route, f.owner.actor.accountId, guardedId],
  );
  const guardedTarget = await assignments().assignLabelForConsolidation(
    f.owner.actor,
    target.id,
    { subjectId: guardedItem.subjectId },
    target.revision,
    { labelId: source.id, assignmentId: guardedItem.assignmentId, revision: guardedItem.revision, labelRevision: source.revision },
    null,
    guardedKeys.target_request_key,
  );
  await assignments().unassignLabel(
    f.owner.actor,
    target.id,
    { subjectId: guardedItem.subjectId, assignmentId: guardedTarget.value.assignment.id, revision: guardedTarget.value.assignment.revision },
    entryKey(),
  );
  const guardedRetry = await f.send('owner', 'POST', `/v1/libraryLabels/${source.id}:retryConsolidation`, {
    confirmationId: guardedId,
    item: 0,
  });
  expect((await guardedRetry.json()).items[0].status).toBe('target_applied_source_retained');
  expect((await readAssignments(source.id)).map((row) => row.subjectId)).toContain(guardedItem.subjectId);

  await f.pool.query(
    `UPDATE library.label_consolidation SET expires_at=clock_timestamp()-interval '1 second'
     WHERE route=$1 AND account_id=$2 AND consolidation_id=$3`,
    [route, f.owner.actor.accountId, confirmationId],
  );
  const expired = await purgeExpiredLabelConsolidations(
    { pool: f.pool },
    { partition: partitionOf(route), limit: 100, after: null },
  );
  expect(expired.removed).toBeGreaterThan(0);
  expect((await f.send('owner', 'GET', `/v1/libraryLabels/${source.id}/consolidations/${confirmationId}`)).status).toBe(404);

  const terminalSubject = await f.createSubject('unprofiled'),
    terminalItem = await select(source.id, terminalSubject),
    terminalEvidence = await review(source, target, [terminalItem]),
    terminal = await confirm(source.id, terminalEvidence);
  expect(terminal.status).toBe(201);
  const terminalId = (await terminal.json()).confirmationId,
    erased = await ownedQueries.label_consolidation.run(
      { query: f.pool.query.bind(f.pool) },
      { route, account_id: f.owner.actor.accountId },
    );
  expect(erased.length).toBeGreaterThan(0);
  expect(
    (await f.pool.query(`SELECT count(*)::int AS count FROM library.label_consolidation_item WHERE consolidation_id=$1`, [terminalId])).rows[0]!.count,
  ).toBe(0);
  expect((await f.send('owner', 'GET', `/v1/libraryLabels/${source.id}/consolidations/${terminalId}`)).status).toBe(404);
}, 120_000);
