import { expect, test } from 'bun:test';
import { createLifecycleCommands } from '../../src/access/lifecycle.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { createCopyCommands } from '../../src/library/copies.ts';
import * as facts from '../../src/library/entry-store.ts';
import {
  createLibraryProfileMigrationRuntime,
  LIBRARY_PROFILE_MIGRATION_WORKFLOW,
} from '../../src/library/profile-migration-runtime.ts';
import { routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { readWorkerConfig, startWorker } from '../../src/worker.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { observeRetentionQueries } from './entry-retention-worker-runtime.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import type { StoredProfileReceipt } from './support/profile-historical-native-fixture.ts';

// Historical fixture only: the same old native command boundary used by
// profile-copy-compatibility.test.ts. No new production endpoint or NULL-pin default.
async function historical(f: NativeProfileFixture, subjectId: string) {
  const owner = await f.identity([
    'subject:read',
    'library_entry:update',
    'library_entry:read',
    'progress_session:read',
    'progress_session:create',
    'progress_session:update',
    'copy:create',
    'copy:read',
    'copy:update',
    'copy:delete',
    'account:delete',
  ]);
  await f.grantLibraryGate(owner.actor.accountId);
  const accountId = owner.actor.accountId;
  const route = routeOf(accountId)!;
  const fixture = await f.historical(owner);
  await fixture.entry(subjectId, 'planned');
  const { recorded } = await fixture.session(subjectId, 'completed_units', 'chapter');
  const sessionId = recorded.value.id;
  const copyIds = [
    (await fixture.copy(subjectId, 'owned')).value.id,
    (await fixture.copy(subjectId, 'owned')).value.id,
  ];
  return { owner, accountId, route, sessionId, copyIds };
}

async function snapshot(f: NativeProfileFixture, accountId: string) {
  const state = await f.inspect(accountId);
  const sessions = await f.pool.query(
    `SELECT s.session_id, (SELECT jsonb_agg(u ORDER BY unit_id) FROM library.progress_unit u
      WHERE u.route=s.route AND u.session_id=s.session_id) AS units,
      (SELECT jsonb_agg(c ORDER BY change_no) FROM library.progress_change c
      WHERE c.route=s.route AND c.session_id=s.session_id) AS changes
     FROM library.progress_session s WHERE s.route=$1 AND s.account_id=$2`,
    [routeOf(accountId), accountId],
  );
  return { ...state, history: sessions.rows };
}
function withoutPins(rows: Array<{ row: Record<string, unknown> }>, copy = false) {
  return rows.map(({ row: { library_profile_pin: _pin, kind, ...row } }) => ({
    ...row,
    ...(copy ? {} : kind === undefined ? {} : { kind }),
  }));
}

test('Legacy Library profile migration has a real explicit default worker and owner-ready cutover', async () => {
  const f = await createProfileEntryFixture();
  const client = await createWorkClient(process.env.DATABASE_URL!, f.pool);
  const runtime = createLibraryProfileMigrationRuntime({ pool: f.pool, client });
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    const subjectId = await f.createSubject('game');
    const a = await historical(f, subjectId);
    const b = await historical(f, subjectId);
    const copies = createCopyCommands({ pool: f.pool, access: f.access, tokens: f.tokens });
    const retained = await copies.deleteCopy(b.owner.actor, b.copyIds[0]!, 1, entryKey());
    const before = await snapshot(f, a.accountId);
    // Ordinary reads neither create a job nor require current profile inference.
    expect((await f.commands.readEntry(a.owner.actor, subjectId)).state).toBe('planned');
    expect((await runtime.readProgress({ accountId: a.accountId })).phase).toBe('legacy');
    const start = await runtime.start({ accountId: a.accountId, releaseDigest: f.originalDigest });
    expect(start).toMatchObject({ phase: 'entry', after: null, releaseDigest: f.originalDigest });
    await expect(runtime.start({ accountId: a.accountId, releaseDigest: f.replacementDigest })).rejects.toBeDefined();
    // Changing Global cannot change the already captured immutable destination.
    await f.activate(f.replacementDigest);
    let fault: 'before' | 'after' | null = 'before';
    let advanced = false;
    const consumed = new WeakMap<object, number>();
    const rawPages: number[] = [];
    await observeRetentionQueries(f.pool, ({ connection, sql, result }) => {
      if (/AS incompatible/i.test(sql)) {
        const total = (consumed.get(connection) ?? 0) + result.rows.length;
        consumed.set(connection, total);
        rawPages.push(total);
        expect(total).toBeLessThanOrEqual(100);
      }
      if (/^(COMMIT|ROLLBACK)$/i.test(sql.trim())) consumed.delete(connection);
      if (/SET profile_migration_phase =/i.test(sql)) {
        advanced = true;
        if (fault === 'before') {
          fault = null;
          throw new Error('fixture before native commit');
        }
      }
      if (advanced && /^COMMIT$/i.test(sql.trim())) {
        advanced = false;
        if (fault === 'after') {
          fault = null;
          throw new Error('fixture after native commit');
        }
      }
    });
    await expect(runtime.resume({ accountId: a.accountId })).rejects.toThrow('fixture before native commit');
    expect(await runtime.readProgress({ accountId: a.accountId })).toEqual(start);
    expect((await snapshot(f, a.accountId)).entries).toEqual(before.entries);
    // Current writer wins the row revision/pin; the migration must preserve that pin.
    const oldEntry = await f.commands.readEntry(a.owner.actor, subjectId);
    await f.commands.putEntry(
      a.owner.actor,
      subjectId,
      {
        state: 'planned',
        revision: oldEntry.revision,
        incarnationId: oldEntry.incarnationId!,
      },
      entryKey(),
    );
    const fresh = await snapshot(f, a.accountId);
    fault = 'after';
    await expect(runtime.resume({ accountId: a.accountId })).rejects.toThrow('fixture after native commit');
    expect((await runtime.readProgress({ accountId: a.accountId })).phase).toBe('ready');
    expect((await runtime.resume({ accountId: a.accountId })).phase).toBe('ready');
    const after = await snapshot(f, a.accountId);
    expect(after.entries).toEqual(fresh.entries);
    expect(withoutPins(after.sessions)).toEqual(withoutPins(before.sessions));
    expect(withoutPins(after.copies, true)).toEqual(withoutPins(before.copies, true));
    expect(after.history).toEqual(before.history);
    expect(rawPages.some((rows) => rows === 4)).toBe(true);
    expect(after.receipts).toEqual(fresh.receipts);
    for (const { row } of [...after.sessions, ...after.copies])
      expect(row.library_profile_pin).toEqual({
        provenance: 'legacy',
        releaseDigest: f.originalDigest,
        acceptingType: null,
        profileId: 'legacy-fixed-v1',
      });
    for (const { row } of after.copies) expect(row.kind).toBe('legacy-unspecified');
    await runtime.start({ accountId: b.accountId, releaseDigest: f.originalDigest });
    const env = workerTestEnv({
      DATABASE_URL: process.env.DATABASE_URL!,
      STRIPE_SECRET_KEY: 'sk_test_profile_migration',
      STRIPE_MANAGED_PAYMENTS: 'false',
      CHECKOUT_SUCCESS_URL: 'https://web.example.test/success',
      CHECKOUT_CANCEL_URL: 'https://web.example.test/cancel',
    });
    worker = await startWorker(readWorkerConfig(env), undefined, env);
    const workflowId = `${LIBRARY_PROFILE_MIGRATION_WORKFLOW}:${b.accountId}:${f.originalDigest}:entry:start`;
    await client.retrieveWorkflow(workflowId).getResult();
    expect((await runtime.readProgress({ accountId: b.accountId })).phase).toBe('ready');
    // The default worker also replays a committed old checkpoint without new receipts.
    const oldWorkflow = `${LIBRARY_PROFILE_MIGRATION_WORKFLOW}:${a.accountId}:${f.originalDigest}:entry:start`;
    await client.retrieveWorkflow(oldWorkflow).getResult();
    expect((await snapshot(f, a.accountId)).receipts).toEqual(after.receipts);
    await worker.stop();
    worker = undefined;
    const restored = await copies.restoreCopy(
      b.owner.actor,
      b.copyIds[0]!,
      {
        deletionId: retained.transactionId,
        revision: 2,
      },
      entryKey(),
    );
    expect(restored.value).toMatchObject({
      id: b.copyIds[0],
      kind: 'legacy-unspecified',
      note: b.copyIds[0],
      revision: 3,
      createdAt: retained.value.createdAt,
    });
    const restoredPin = await facts.readCopyFact(f.pool, b.route, b.copyIds[0]!);
    expect(restoredPin?.pin).toMatchObject({ provenance: 'legacy', releaseDigest: f.originalDigest });
    await createLifecycleCommands({ pool: f.pool, access: f.access }).tombstone(
      { actor: b.owner.actor, deadline: deadlineFor(30_000) },
      { accountId: b.accountId, key: entryKey() },
    );
    const terminal = await snapshot(f, b.accountId);
    await expect(runtime.resume({ accountId: b.accountId })).rejects.toBeDefined();
    await expect(runtime.start({ accountId: b.accountId, releaseDigest: f.originalDigest })).rejects.toBeDefined();
    expect(await snapshot(f, b.accountId)).toEqual(terminal);
    // Existing current owners never need a job before their facts are readable.
    expect((await runtime.readProgress({ accountId: f.owner.actor.accountId })).phase).toBe('ready');
  } finally {
    await worker?.stop();
    await client.close();
    await f.close();
  }
}, 120_000);

test('historical fixture commits original owner facts and HTTP receipts, including exact retained entry restoration', async () => {
  const f = await createProfileEntryFixture();
  const client = await createWorkClient(process.env.DATABASE_URL!, f.pool);
  try {
    const owner = await f.identity([
      'subject:read', 'library_entry:update', 'library_entry:read', 'library_entry:delete',
      'progress_session:create', 'progress_session:update', 'copy:create',
    ]);
    const accountId = owner.actor.accountId;
    await f.grantLibraryGate(accountId);
    const legacy = await f.historical(owner);
    await legacy.seed();
    const seeded = await snapshot(f, accountId);
    expect([seeded.entries.length, seeded.sessions.length, seeded.copies.length]).toEqual([5, 18, 4]);
    expect(seeded.entries.map(({ row }) => row.state).sort()).toEqual(['completed', 'dropped', 'in_progress', 'paused', 'planned']);
    expect(new Set(seeded.sessions.map(({ row }) => `${row.mode}/${row.unit}`)).size).toBe(18);
    expect(seeded.history.flatMap((row) => row.units ?? []).map((row: { unit_id: string }) => row.unit_id)).toEqual(
      Array.from({ length: 6 }, () => ['1', '3', '7']).flat(),
    );
    const scalar = await f.pool.query('SELECT amount::text,total::text FROM library.progress_session WHERE route=$1 AND account_id=$2 AND mode=$3 AND unit=$4', [routeOf(accountId), accountId, 'scalar_amount', 'page']);
    expect(scalar.rows).toEqual([{ amount: '999999999999.999999', total: '999999999999.999999' }]);
    expect(seeded.copies.map(({ row }) => row.status).sort()).toEqual(['disposed', 'lent', 'ordered', 'owned']);
    for (const { row } of [...seeded.entries, ...seeded.sessions, ...seeded.copies]) {
      expect(row.account_id).toBe(accountId);
      expect(row.library_profile_pin).toBeNull();
    }
    const stored = (await f.pool.query<StoredProfileReceipt & { transactionId: string }>(
      `SELECT principal_id AS "accountId",command_kind AS "commandKind",idempotency_key AS "storageKey",
       encode(request_digest,'hex') AS digest,response,transaction_id AS "transactionId" FROM core.receipt
       WHERE partition_no=$1 AND principal_id=$2 AND command_kind=ANY($3::text[]) ORDER BY command_kind,idempotency_key`,
      [routeOf(accountId)! >> 4, accountId, ['library.entry.put', 'progress_session.start', 'progress_session.record', 'library.copy.create']],
    )).rows;
    const observed = stored.map((row) => legacy.receipts.bind(row));
    expect(observed).toHaveLength(45);
    expect(observed.filter((row) => row.status === 200)).toHaveLength(18);
    expect(observed.filter((row) => row.status === 201)).toHaveLength(27);
    for (let n = 0; n < stored.length; n++) {
      expect(observed[n]!.requestKey).not.toBe(stored[n]!.storageKey);
      expect(observed[n]!.digest).toMatch(/^[0-9a-f]{64}$/);
    }
    const transactions = new Set(stored.map((row) => row.transactionId));
    for (const { row } of [...seeded.entries, ...seeded.sessions, ...seeded.copies])
      expect(transactions.has(row.transaction_id as string)).toBe(true);
    expect(observed.some(({ response }) => (response as { amount?: string }).amount === '999999999999.999999')).toBe(true);
    const old = seeded.entries[0]!.row;
    const retained = await f.commands.deleteEntry(owner.actor, old.subject_id as string, 1, entryKey(), old.incarnation_id as string);
    if (!('deletionId' in retained.value)) throw new Error('Entry was not retained');
    const before = await snapshot(f, accountId);
    const runtime = createLibraryProfileMigrationRuntime({ pool: f.pool, client });
    let state = await runtime.start({ accountId, releaseDigest: f.originalDigest });
    await f.activate(f.replacementDigest);
    while (state.phase !== 'ready') state = await runtime.resume({ accountId });
    const after = await snapshot(f, accountId);
    for (const relation of ['entries', 'sessions', 'copies'] as const)
      expect(withoutPins(after[relation], relation === 'copies')).toEqual(withoutPins(before[relation], relation === 'copies'));
    expect(after.history).toEqual(before.history);
    expect(after.receipts).toEqual(before.receipts);
    const restored = await f.commands.restoreEntry(owner.actor, old.subject_id as string, retained.value, entryKey());
    expect(restored.value.entry).toMatchObject({
      subjectId: old.subject_id, incarnationId: old.incarnation_id, state: old.state, createdAt: new Date(old.created_at as string).toISOString(),
    });
    const fact = await facts.readEntryFact(f.pool, routeOf(accountId)!, accountId, old.subject_id as string);
    expect(fact?.pin).toEqual({ provenance: 'legacy', releaseDigest: f.originalDigest, acceptingType: null, profileId: 'legacy-fixed-v1' });
    const original = stored.findIndex((row) => row.commandKind === 'library.entry.put');
    const accepted = stored[original]!.response as { entry: { subjectId: string; state: string } };
    const replay = await f.send(owner.bearer, 'PUT', `/v1/libraryEntries/${accepted.entry.subjectId}`, { state: accepted.entry.state }, observed[original]!.requestKey);
    expect(replay.status).toBe(observed[original]!.status);
    await expect(legacy.copy(old.subject_id as string, 'owned')).rejects.toThrow('Library owner no longer admits unpinned facts');
  } finally {
    await client.close();
    await f.close();
  }
}, 120_000);
