import { projectBatch } from '../../src/events/log.ts';
import { registerEffects } from '../../src/events/effects.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { CommandResultErasedError, noEffect, principalCommandIdentity, runCommand } from '../../src/command/command.ts';
import { declareCommandHistory } from '../../src/history/record.ts';
import {
  declareCommandRecordSources,
  recordHistorySourceKey,
  type RecordHistorySourceReference,
} from '../../src/history/record-source.ts';
import { minimizeRecordHistoryPurge, prepareRecordHistoryPurge } from '../../src/history/record-purge.ts';
import { prepareRecordPurgeAuthority, type RecordPurgeReference } from '../../src/semantic/record-purge-authority.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { custodyFixture, digest, kind, scope, type CustodyFixture, type Person } from './command-custody-fixture.ts';
import { createDeletionFixture } from '../semantic/support/deletion-fixture.ts';
import { stageHistoryWork } from '../../src/work/history-enqueue.ts';

let f: CustodyFixture;
let native: Awaited<ReturnType<typeof createDeletionFixture>>;
let person: Person;
const context = () => ({ deadline: Date.now() + 30_000 });
beforeAll(async () => {
  f = await custodyFixture();
  native = await createDeletionFixture(f.db);
  await native.setup();
  person = await f.auth.person(`record_${randomUUID().replaceAll('-', '')}`);
}, 180_000);
afterAll(async () => {
  await native?.close();
  await f?.close();
});

async function original() {
  const record = await native.proposal(await native.person());
  const row = (
    await f.db.admin.query(
      'SELECT revision FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3',
      [routeOf(record.subject), record.subject, record.candidate],
    )
  ).rows[0];
  const source: RecordHistorySourceReference = {
    kind: 'contribution',
    subjectId: record.subject,
    candidateId: record.candidate,
    revision: row.revision,
    documentId: null,
  };
  return { record, source, key: recordHistorySourceKey(source), partition: partitionOf(routeOf(record.subject)!) };
}
type Original = Awaited<ReturnType<typeof original>>;

/** Exercise the actual command fence/codec and original-source enrollment, without patching
 * Semantic's real writers (their owner adopts this receiving declaration independently). */
async function copy(
  input: Original,
  key: string,
  options: { enrolled?: boolean; partition?: number; outbox?: boolean; workId?: string } = {},
) {
  const partition = options.partition ?? input.partition;
  const ctx = await f.context(person, partition);
  return runCommand(
    f.db.pool,
    {
      ...principalCommandIdentity(ctx.actor),
      partition,
      deadline: ctx.deadline,
      authorization: ctx.authorization,
      receipt: { kind, key, digest },
    },
    async (tx) => {
      if (options.enrolled !== false) declareCommandRecordSources(tx, [input.source]);
      const scopes = scope(person);
      await declareCommandHistory(tx, kind, {
        ...scopes,
        events: options.outbox ? [{ artifactType: 'outbox-event/v1', accounts: scopes.response.accounts }] : [],
      });
      if (options.workId)
        await stageHistoryWork(tx, {
          owner: 'record-purge-fixture',
          intent: {
            queue: 'maintenance',
            workflowName: 'record-purge-fixture',
            workflowId: options.workId,
            input: { accounts: [person.accountId], subjectId: input.record.subject },
          },
          scope: { artifactType: 'durable-work/v1', accounts: scopes.response.accounts },
        });
      const value = { payload: input.record.payload };
      return options.outbox
        ? {
            value,
            events: [
              {
                type: 'com.rezics.library.entry.purged.v1',
                subject: person.accountId,
                data: { deletionId: randomUUID() },
              },
            ],
          }
        : noEffect(value);
    },
  );
}
async function deleted(input: Original) {
  native.status(await native.call('DELETE', native.path(input.record), 'owner'), 200);
  const row = (
    await f.db.admin.query(
      'SELECT deletion_generation FROM semantic.record_lifecycle WHERE route=$1 AND subject_id=$2 AND candidate_id=$3',
      [routeOf(input.record.subject), input.record.subject, input.record.candidate],
    )
  ).rows[0];
  const ref: RecordPurgeReference = {
    subjectId: input.record.subject,
    candidateId: input.record.candidate,
    revision: input.source.kind === 'contribution' ? input.source.revision : 0,
    documentId: null,
    deletionGeneration: row.deletion_generation,
  };
  return ref;
}
async function preparation(ref: RecordPurgeReference) {
  const deps = { pool: f.db.pool, clock: native.clock };
  const ctx = context();
  const authority = await prepareRecordPurgeAuthority(deps, ref, ctx);
  expect(authority).not.toBeNull();
  const prepared = await prepareRecordHistoryPurge(deps, authority!, ctx);
  expect(prepared).not.toBeNull();
  return { deps, ctx, prepared: prepared! };
}
async function rows(input: Original) {
  return (
    await f.db.admin.query(
      'SELECT artifact_type,state,gap FROM core.record_history_locator WHERE source_key=$1 ORDER BY artifact_type',
      [input.key],
    )
  ).rows;
}
function expire() {
  native.setNow(new Date(native.clock().getTime() + 31 * 86_400_000));
}

test('actual native ordinary record authority minimizes exact enrolled local receipt and outbox with consumer closure', async () => {
  const input = await original(),
    key = randomUUID();
  const made = await copy(input, key, { outbox: true });
  const ref = await deleted(input);
  expire();
  const p = await preparation(ref);
  const first = await minimizeRecordHistoryPurge(p.deps, p.prepared, p.ctx);
  expect(first).toMatchObject({ state: 'progress', minimized: 1 });
  expect(first.examined).toBeLessThanOrEqual(8);
  expect((await f.stored(person, key, input.partition)).response).toBeNull();
  await expect(copy(input, key, { outbox: true })).rejects.toBeInstanceOf(CommandResultErasedError);
  // The actual effects checkpoint is required even for a projection-free event.
  const pending = await minimizeRecordHistoryPurge(p.deps, p.prepared, p.ctx);
  expect(pending).toMatchObject({ state: 'pending', minimized: 0 });
  expect(await rows(input)).toContainEqual(
    expect.objectContaining({ artifact_type: 'outbox-event/v1', gap: 'outbox-effects-not-dispatched' }),
  );
  // Dispatch the actual native log with the existing effects dispatcher. This closed event
  // has no registered consumers; no fabricated checkpoint or terminal workflow status is used.
  const effects = registerEffects([], f.db.pool);
  for (let unit = 0; unit < 64; unit++) {
    const dispatched = await projectBatch(f.db.pool, {
      partition: input.partition,
      consumer: 'effects',
      apply: effects.enqueue,
    });
    if (dispatched.status === 'read' && dispatched.position >= made.position) break;
    if (unit === 63) throw new Error('Native fixture effects did not reach the exact copy');
  }
  await f.db.admin.query(
    "UPDATE core.record_history_locator SET next_attempt=now() WHERE source_key=$1 AND state='pending'",
    [input.key],
  );
  expect(await minimizeRecordHistoryPurge(p.deps, p.prepared, p.ctx)).toMatchObject({
    state: 'progress',
    minimized: 1,
  });
  expect(
    (
      await f.db.admin.query('SELECT payload_state,data FROM core.outbox WHERE partition_no=$1 AND position=$2', [
        input.partition,
        made.position.toString(),
      ])
    ).rows,
  ).toEqual([{ payload_state: 'minimized', data: {} }]);
  // Local success never claims full historical inventory or account erasure proof.
  expect(await minimizeRecordHistoryPurge(p.deps, p.prepared, p.ctx)).toEqual({
    state: 'pending',
    examined: 0,
    minimized: 0,
  });
  expect(
    (
      await f.db.admin.query(
        'SELECT state,proof_barrier FROM core.history_locator WHERE partition_no=$1 AND account_id=$2',
        [input.partition, person.accountId],
      )
    ).rows.every((row) => row.state === 'pending' && row.proof_barrier === null),
  ).toBe(true);
});

test('restore, hold and stale source versions refuse preparation or effect', async () => {
  const input = await original(),
    key = randomUUID();
  await copy(input, key);
  const old = await deleted(input);
  native.status(await native.call('POST', `${native.path(input.record)}:restore`, 'owner', {}), 200);
  expect(await prepareRecordPurgeAuthority({ pool: f.db.pool, clock: native.clock }, old, context())).toBeNull();
  const current = await deleted(input);
  expire();
  expect(await prepareRecordPurgeAuthority({ pool: f.db.pool, clock: native.clock }, old, context())).toBeNull();
  const p = await preparation(current);
  for (const held of [true, false]) {
    native.status(
      await native.call('POST', `${native.path(input.record)}:hold`, 'platform', {
        held,
        reason: 'Native evidence custody',
      }),
      200,
    );
    expect(await minimizeRecordHistoryPurge(p.deps, p.prepared, p.ctx)).toEqual({
      state: 'pending',
      examined: 0,
      minimized: 0,
    });
    expect((await f.stored(person, key, input.partition)).response.payload).toBe(input.record.payload);
  }
});

test('unknown historical copies and actual foreign copies remain pending while known local copies progress', async () => {
  const input = await original(),
    old = randomUUID(),
    local = randomUUID(),
    foreign = randomUUID();
  await copy(input, old, { enrolled: false });
  await copy(input, local);
  const foreignPartition = (input.partition + 1) % 4096;
  await copy(input, foreign, { partition: foreignPartition });
  const ref = await deleted(input);
  expire();
  const p = await preparation(ref);
  expect(await minimizeRecordHistoryPurge(p.deps, p.prepared, p.ctx)).toMatchObject({
    state: 'progress',
    minimized: 1,
  });
  expect(await minimizeRecordHistoryPurge(p.deps, p.prepared, p.ctx)).toMatchObject({ state: 'pending', minimized: 0 });
  expect((await f.stored(person, old, input.partition)).response.payload).toBe(input.record.payload);
  expect((await f.stored(person, foreign, foreignPartition)).response.payload).toBe(input.record.payload);
  expect(await rows(input)).toContainEqual(
    expect.objectContaining({ state: 'pending', gap: 'record-source-bound-foreign-custody-unavailable' }),
  );
});

test('payload mutation rolls back atomically if native local progress cannot commit', async () => {
  const input = await original(),
    key = randomUUID();
  await copy(input, key);
  const ref = await deleted(input);
  expire();
  const p = await preparation(ref);
  const name = `record_purge_failure_${randomUUID().replaceAll('-', '')}`;
  await f.db.admin.query(`CREATE FUNCTION core.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.source_key=TG_ARGV[0] AND NEW.state='minimized' THEN RAISE EXCEPTION 'injected_record_progress_failure'; END IF;
    RETURN NEW; END $$`);
  await f.db.admin.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON core.record_history_locator
    FOR EACH ROW EXECUTE FUNCTION core.${name}('${input.key}')`);
  try {
    await expect(minimizeRecordHistoryPurge(p.deps, p.prepared, p.ctx)).rejects.toThrow(
      'injected_record_progress_failure',
    );
    expect((await f.stored(person, key, input.partition)).response.payload).toBe(input.record.payload);
    expect(await rows(input)).toEqual([{ artifact_type: 'command-receipt/v1', state: 'pending', gap: null }]);
  } finally {
    await f.db.admin.query(`DROP TRIGGER ${name} ON core.record_history_locator`);
    await f.db.admin.query(`DROP FUNCTION core.${name}()`);
  }
  expect(await minimizeRecordHistoryPurge(p.deps, p.prepared, p.ctx)).toMatchObject({
    state: 'progress',
    minimized: 1,
  });
});

test('living scoped work is enrolled by its actual staging serializer and cannot be retired by a source observation', async () => {
  const input = await original(),
    key = randomUUID(),
    workId = randomUUID();
  await copy(input, key, { workId });
  const ref = await deleted(input);
  expire();
  const p = await preparation(ref);
  await minimizeRecordHistoryPurge(p.deps, p.prepared, p.ctx);
  expect(await minimizeRecordHistoryPurge(p.deps, p.prepared, p.ctx)).toMatchObject({ state: 'pending', minimized: 0 });
  expect(await rows(input)).toContainEqual(
    expect.objectContaining({
      artifact_type: 'durable-work/v1',
      state: 'pending',
      gap: 'record-work-source-bound-retirement-unavailable',
    }),
  );
  expect(
    (
      await f.db.admin.query('SELECT state,request,scope FROM core.history_work WHERE partition_no=$1 AND work_id=$2', [
        input.partition,
        workId,
      ])
    ).rows[0],
  ).toMatchObject({ state: 'pending', request: expect.any(Object), scope: expect.any(Object) });
});
